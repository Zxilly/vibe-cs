use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
};

use crate::{Result, SourceAssetError};

pub const VPK_SIGNATURE: u32 = 0x55aa_1234;
pub const VPK_VERSION_2: u32 = 2;
pub const VPK_INLINE_ARCHIVE_INDEX: u16 = 0x7fff;
const VPK_V2_HEADER_SIZE: u64 = 28;
const VPK_V2_HEADER_LENGTH: usize = 28;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VpkLimits {
    pub max_tree_size: u64,
    /// Maximum unsectioned trailer accepted after the documented VPK v2 sections.
    /// Source 2 packages can append a certificate payload outside those sizes.
    pub max_trailing_data: u64,
    pub max_entries: usize,
    pub max_path_length: usize,
    pub max_entry_size: u64,
    pub max_archive_index: u16,
}

impl Default for VpkLimits {
    fn default() -> Self {
        Self {
            max_tree_size: 128 * 1024 * 1024,
            max_trailing_data: 16 * 1024 * 1024,
            max_entries: 1_000_000,
            max_path_length: 1_024,
            max_entry_size: 256 * 1024 * 1024,
            max_archive_index: 4_096,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VpkHeader {
    pub tree_size: u32,
    pub file_data_section_size: u32,
    pub archive_md5_section_size: u32,
    pub other_md5_section_size: u32,
    pub signature_section_size: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VpkArchiveLocation {
    Inline,
    External(u16),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VpkEntry {
    path: String,
    crc32: u32,
    archive: VpkArchiveLocation,
    offset: u64,
    data_length: u64,
    preload: Vec<u8>,
}

impl VpkEntry {
    pub fn path(&self) -> &str {
        &self.path
    }

    pub const fn crc32(&self) -> u32 {
        self.crc32
    }

    pub const fn archive(&self) -> VpkArchiveLocation {
        self.archive
    }

    pub const fn offset(&self) -> u64 {
        self.offset
    }

    pub const fn data_length(&self) -> u64 {
        self.data_length
    }

    pub fn preload_length(&self) -> usize {
        self.preload.len()
    }

    pub fn total_size(&self) -> u64 {
        u64::try_from(self.preload.len())
            .unwrap_or(u64::MAX)
            .saturating_add(self.data_length)
    }
}

#[derive(Debug)]
pub struct VpkArchive {
    directory_path: PathBuf,
    directory_root: PathBuf,
    archive_prefix: String,
    header: VpkHeader,
    data_section_offset: u64,
    entries: BTreeMap<String, VpkEntry>,
    limits: VpkLimits,
}

impl VpkArchive {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        Self::open_with_limits(path, VpkLimits::default())
    }

    pub fn open_with_limits(path: impl AsRef<Path>, limits: VpkLimits) -> Result<Self> {
        let requested_path = path.as_ref().to_path_buf();
        let directory_path = fs::canonicalize(&requested_path)
            .map_err(|error| SourceAssetError::io(&requested_path, error))?;
        let directory_root = directory_path
            .parent()
            .ok_or_else(|| invalid_input(&directory_path, "VPK path has no parent directory"))?
            .to_path_buf();
        let archive_prefix = directory_archive_prefix(&directory_path)?;

        let mut file = File::open(&directory_path)
            .map_err(|error| SourceAssetError::io(&directory_path, error))?;
        let file_length = file
            .metadata()
            .map_err(|error| SourceAssetError::io(&directory_path, error))?
            .len();
        if file_length < VPK_V2_HEADER_SIZE {
            return Err(SourceAssetError::InvalidVpkLength {
                path: directory_path,
                declared: VPK_V2_HEADER_SIZE,
                actual: file_length,
            });
        }

        let mut raw_header = [0_u8; VPK_V2_HEADER_LENGTH];
        file.read_exact(&mut raw_header)
            .map_err(|error| SourceAssetError::io(&directory_path, error))?;
        let signature = read_header_u32(&raw_header, 0);
        if signature != VPK_SIGNATURE {
            return Err(SourceAssetError::InvalidVpkSignature {
                path: directory_path,
            });
        }
        let version = read_header_u32(&raw_header, 4);
        if version != VPK_VERSION_2 {
            return Err(SourceAssetError::UnsupportedVpkVersion {
                path: directory_path,
                version,
            });
        }
        let header = VpkHeader {
            tree_size: read_header_u32(&raw_header, 8),
            file_data_section_size: read_header_u32(&raw_header, 12),
            archive_md5_section_size: read_header_u32(&raw_header, 16),
            other_md5_section_size: read_header_u32(&raw_header, 20),
            signature_section_size: read_header_u32(&raw_header, 24),
        };
        enforce_limit(
            "VPK directory tree",
            u64::from(header.tree_size),
            limits.max_tree_size,
        )?;

        let declared_length = [
            header.tree_size,
            header.file_data_section_size,
            header.archive_md5_section_size,
            header.other_md5_section_size,
            header.signature_section_size,
        ]
        .into_iter()
        .try_fold(VPK_V2_HEADER_SIZE, |total, section| {
            total
                .checked_add(u64::from(section))
                .ok_or(SourceAssetError::ArithmeticOverflow("VPK section sizes"))
        })?;
        if declared_length > file_length {
            return Err(SourceAssetError::InvalidVpkLength {
                path: directory_path,
                declared: declared_length,
                actual: file_length,
            });
        }
        enforce_limit(
            "VPK trailing data",
            file_length - declared_length,
            limits.max_trailing_data,
        )?;

        let tree_length = usize::try_from(header.tree_size)
            .map_err(|_| SourceAssetError::ArithmeticOverflow("directory tree allocation"))?;
        let mut tree = vec![0_u8; tree_length];
        file.read_exact(&mut tree)
            .map_err(|error| SourceAssetError::io(&directory_path, error))?;
        let entries = parse_directory_tree(&tree, header.file_data_section_size, limits)?;
        let data_section_offset = VPK_V2_HEADER_SIZE
            .checked_add(u64::from(header.tree_size))
            .ok_or(SourceAssetError::ArithmeticOverflow("inline data offset"))?;

        Ok(Self {
            directory_path,
            directory_root,
            archive_prefix,
            header,
            data_section_offset,
            entries,
            limits,
        })
    }

    pub fn directory_path(&self) -> &Path {
        &self.directory_path
    }

    pub const fn header(&self) -> VpkHeader {
        self.header
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    pub fn entries(&self) -> impl ExactSizeIterator<Item = &VpkEntry> {
        self.entries.values()
    }

    pub fn entry(&self, virtual_path: &str) -> Result<Option<&VpkEntry>> {
        let key = normalize_virtual_path(virtual_path, self.limits.max_path_length)?;
        Ok(self.entries.get(&key))
    }

    pub fn read(&self, virtual_path: &str) -> Result<Vec<u8>> {
        let key = normalize_virtual_path(virtual_path, self.limits.max_path_length)?;
        let entry = self
            .entries
            .get(&key)
            .ok_or_else(|| SourceAssetError::EntryNotFound(key.clone()))?;
        self.read_validated_entry(entry)
    }

    fn read_validated_entry(&self, entry: &VpkEntry) -> Result<Vec<u8>> {
        enforce_limit("VPK entry", entry.total_size(), self.limits.max_entry_size)?;
        let capacity = usize::try_from(entry.total_size())
            .map_err(|_| SourceAssetError::ArithmeticOverflow("entry allocation"))?;
        let mut data = Vec::with_capacity(capacity);
        data.extend_from_slice(&entry.preload);

        if entry.data_length > 0 {
            let (source_path, source_offset) = match entry.archive {
                VpkArchiveLocation::Inline => (
                    self.directory_path.clone(),
                    self.data_section_offset
                        .checked_add(entry.offset)
                        .ok_or(SourceAssetError::ArithmeticOverflow("inline entry offset"))?,
                ),
                VpkArchiveLocation::External(index) => (
                    self.external_archive_path(index, &entry.path)?,
                    entry.offset,
                ),
            };
            let mut source = File::open(&source_path)
                .map_err(|error| SourceAssetError::io(&source_path, error))?;
            let source_length = source
                .metadata()
                .map_err(|error| SourceAssetError::io(&source_path, error))?
                .len();
            let source_end = source_offset
                .checked_add(entry.data_length)
                .ok_or(SourceAssetError::ArithmeticOverflow("entry data range"))?;
            if source_end > source_length {
                return Err(SourceAssetError::EntryOutOfBounds {
                    path: entry.path.clone(),
                });
            }
            source
                .seek(SeekFrom::Start(source_offset))
                .map_err(|error| SourceAssetError::io(&source_path, error))?;
            let body_length = usize::try_from(entry.data_length)
                .map_err(|_| SourceAssetError::ArithmeticOverflow("entry body allocation"))?;
            let body_start = data.len();
            data.resize(
                body_start
                    .checked_add(body_length)
                    .ok_or(SourceAssetError::ArithmeticOverflow("entry allocation"))?,
                0,
            );
            source
                .read_exact(&mut data[body_start..])
                .map_err(|error| SourceAssetError::io(&source_path, error))?;
        }

        let actual = crc32fast::hash(&data);
        if actual != entry.crc32 {
            return Err(SourceAssetError::CrcMismatch {
                path: entry.path.clone(),
                expected: entry.crc32,
                actual,
            });
        }
        Ok(data)
    }

    fn external_archive_path(&self, index: u16, entry: &str) -> Result<PathBuf> {
        let candidate = self
            .directory_root
            .join(format!("{}_{index:03}.vpk", self.archive_prefix));
        let canonical = fs::canonicalize(&candidate)
            .map_err(|error| SourceAssetError::io(&candidate, error))?;
        if canonical.parent() != Some(self.directory_root.as_path()) {
            return Err(SourceAssetError::ArchiveOutsideDirectory {
                entry: entry.to_owned(),
            });
        }
        Ok(canonical)
    }
}

fn parse_directory_tree(
    tree: &[u8],
    file_data_section_size: u32,
    limits: VpkLimits,
) -> Result<BTreeMap<String, VpkEntry>> {
    let mut cursor = TreeCursor::new(tree);
    let mut entries = BTreeMap::new();
    loop {
        let extension = cursor.read_cstring(limits.max_path_length)?.to_owned();
        if extension.is_empty() {
            break;
        }
        validate_leaf_fragment(&extension, "extension")?;
        loop {
            let directory = cursor.read_cstring(limits.max_path_length)?.to_owned();
            if directory.is_empty() {
                break;
            }
            loop {
                let filename = cursor.read_cstring(limits.max_path_length)?.to_owned();
                if filename.is_empty() {
                    break;
                }
                validate_leaf_fragment(&filename, "filename")?;
                let path = assemble_virtual_path(
                    &extension,
                    &directory,
                    &filename,
                    limits.max_path_length,
                )?;
                let crc32 = cursor.read_u32()?;
                let preload_length = usize::from(cursor.read_u16()?);
                let archive_index = cursor.read_u16()?;
                let offset = u64::from(cursor.read_u32()?);
                let data_length = u64::from(cursor.read_u32()?);
                let terminator = cursor.read_u16()?;
                if terminator != u16::MAX {
                    return Err(cursor.error("entry terminator is not 0xffff"));
                }
                let preload = cursor.read_bytes(preload_length)?.to_vec();
                let total_size = u64::try_from(preload_length)
                    .map_err(|_| SourceAssetError::ArithmeticOverflow("preload length"))?
                    .checked_add(data_length)
                    .ok_or(SourceAssetError::ArithmeticOverflow("entry size"))?;
                enforce_limit("VPK entry", total_size, limits.max_entry_size)?;

                let archive = if archive_index == VPK_INLINE_ARCHIVE_INDEX {
                    let end = offset
                        .checked_add(data_length)
                        .ok_or(SourceAssetError::ArithmeticOverflow("inline entry range"))?;
                    if end > u64::from(file_data_section_size) {
                        return Err(SourceAssetError::EntryOutOfBounds { path });
                    }
                    VpkArchiveLocation::Inline
                } else {
                    if archive_index > limits.max_archive_index {
                        return Err(SourceAssetError::ArchiveIndexLimit {
                            index: archive_index,
                            limit: limits.max_archive_index,
                        });
                    }
                    VpkArchiveLocation::External(archive_index)
                };

                if entries.len() >= limits.max_entries {
                    return Err(SourceAssetError::LimitExceeded {
                        kind: "VPK entry count",
                        actual: u64::try_from(entries.len())
                            .unwrap_or(u64::MAX)
                            .saturating_add(1),
                        limit: u64::try_from(limits.max_entries).unwrap_or(u64::MAX),
                    });
                }
                let entry = VpkEntry {
                    path: path.clone(),
                    crc32,
                    archive,
                    offset,
                    data_length,
                    preload,
                };
                if entries.insert(path.clone(), entry).is_some() {
                    return Err(SourceAssetError::DuplicateEntry(path));
                }
            }
        }
    }
    if cursor.remaining() != 0 {
        return Err(cursor.error("bytes remain after the tree terminator"));
    }
    Ok(entries)
}

fn assemble_virtual_path(
    extension: &str,
    directory: &str,
    filename: &str,
    max_length: usize,
) -> Result<String> {
    let extension = placeholder_as_empty(extension);
    let directory = placeholder_as_empty(directory);
    let filename = placeholder_as_empty(filename);
    if filename.is_empty() && extension.is_empty() {
        return Err(SourceAssetError::UnsafeVirtualPath {
            path: String::new(),
            reason: "entry has neither a filename nor extension",
        });
    }
    let leaf = if extension.is_empty() {
        filename.to_owned()
    } else if filename.is_empty() {
        format!(".{extension}")
    } else {
        format!("{filename}.{extension}")
    };
    let path = if directory.is_empty() {
        leaf
    } else {
        format!("{directory}/{leaf}")
    };
    normalize_virtual_path(&path, max_length)
}

fn placeholder_as_empty(value: &str) -> &str {
    if value == " " { "" } else { value }
}

fn validate_leaf_fragment(value: &str, kind: &'static str) -> Result<()> {
    if value != " " && (value.contains('/') || value.contains('\\')) {
        return Err(SourceAssetError::UnsafeVirtualPath {
            path: value.to_owned(),
            reason: kind,
        });
    }
    Ok(())
}

fn normalize_virtual_path(path: &str, max_length: usize) -> Result<String> {
    if path.is_empty() {
        return Err(SourceAssetError::UnsafeVirtualPath {
            path: path.to_owned(),
            reason: "path is empty",
        });
    }
    if path.len() > max_length {
        return Err(SourceAssetError::LimitExceeded {
            kind: "VPK path",
            actual: u64::try_from(path.len()).unwrap_or(u64::MAX),
            limit: u64::try_from(max_length).unwrap_or(u64::MAX),
        });
    }
    if !path.is_ascii() {
        return Err(SourceAssetError::UnsafeVirtualPath {
            path: path.to_owned(),
            reason: "path is not ASCII",
        });
    }
    if path.starts_with('/') || path.ends_with('/') || path.contains('\\') || path.contains(':') {
        return Err(SourceAssetError::UnsafeVirtualPath {
            path: path.to_owned(),
            reason: "path is absolute or contains a platform separator",
        });
    }
    for component in path.split('/') {
        if component.is_empty() || component == "." || component == ".." {
            return Err(SourceAssetError::UnsafeVirtualPath {
                path: path.to_owned(),
                reason: "path contains an empty or traversal component",
            });
        }
        if component.bytes().any(|byte| byte.is_ascii_control()) {
            return Err(SourceAssetError::UnsafeVirtualPath {
                path: path.to_owned(),
                reason: "path contains a control character",
            });
        }
    }
    Ok(path.to_ascii_lowercase())
}

fn enforce_limit(kind: &'static str, actual: u64, limit: u64) -> Result<()> {
    if actual > limit {
        return Err(SourceAssetError::LimitExceeded {
            kind,
            actual,
            limit,
        });
    }
    Ok(())
}

fn directory_archive_prefix(path: &Path) -> Result<String> {
    let filename = path
        .file_name()
        .and_then(|name| name.to_str())
        .ok_or_else(|| invalid_input(path, "VPK directory filename is not UTF-8"))?;
    filename
        .strip_suffix("_dir.vpk")
        .filter(|prefix| !prefix.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| invalid_input(path, "VPK directory filename must end in _dir.vpk"))
}

fn invalid_input(path: &Path, message: &'static str) -> SourceAssetError {
    SourceAssetError::io(
        path,
        std::io::Error::new(std::io::ErrorKind::InvalidInput, message),
    )
}

fn read_header_u32(header: &[u8; VPK_V2_HEADER_LENGTH], offset: usize) -> u32 {
    u32::from_le_bytes(
        header[offset..offset + 4]
            .try_into()
            .expect("fixed header range"),
    )
}

struct TreeCursor<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> TreeCursor<'a> {
    const fn new(bytes: &'a [u8]) -> Self {
        Self { bytes, offset: 0 }
    }

    fn read_cstring(&mut self, max_length: usize) -> Result<&'a str> {
        let start = self.offset;
        let remaining = self
            .bytes
            .get(start..)
            .ok_or_else(|| self.error("string starts outside the tree"))?;
        let length = remaining
            .iter()
            .position(|byte| *byte == 0)
            .ok_or_else(|| self.error("unterminated string"))?;
        if length > max_length {
            return Err(SourceAssetError::LimitExceeded {
                kind: "VPK tree string",
                actual: u64::try_from(length).unwrap_or(u64::MAX),
                limit: u64::try_from(max_length).unwrap_or(u64::MAX),
            });
        }
        let end = start
            .checked_add(length)
            .ok_or(SourceAssetError::ArithmeticOverflow("tree string range"))?;
        let raw = &self.bytes[start..end];
        if !raw.is_ascii() {
            return Err(self.error("tree strings must be ASCII"));
        }
        self.offset = end
            .checked_add(1)
            .ok_or(SourceAssetError::ArithmeticOverflow("tree cursor"))?;
        Ok(std::str::from_utf8(raw).expect("ASCII is valid UTF-8"))
    }

    fn read_u16(&mut self) -> Result<u16> {
        let bytes: [u8; 2] = self.read_bytes(2)?.try_into().expect("fixed integer size");
        Ok(u16::from_le_bytes(bytes))
    }

    fn read_u32(&mut self) -> Result<u32> {
        let bytes: [u8; 4] = self.read_bytes(4)?.try_into().expect("fixed integer size");
        Ok(u32::from_le_bytes(bytes))
    }

    fn read_bytes(&mut self, length: usize) -> Result<&'a [u8]> {
        let end = self
            .offset
            .checked_add(length)
            .ok_or(SourceAssetError::ArithmeticOverflow("tree data range"))?;
        let bytes = self
            .bytes
            .get(self.offset..end)
            .ok_or_else(|| self.error("entry metadata or preload data is truncated"))?;
        self.offset = end;
        Ok(bytes)
    }

    const fn remaining(&self) -> usize {
        self.bytes.len() - self.offset
    }

    fn error(&self, message: impl Into<String>) -> SourceAssetError {
        SourceAssetError::InvalidDirectoryTree {
            offset: self.offset,
            message: message.into(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, fs::OpenOptions};

    use tempfile::tempdir;

    use super::*;
    use crate::test_support::{TestEntry, TestLocation, build_vpk, write_vpk};

    #[test]
    fn reads_inline_and_external_entries_with_preload_and_crc() {
        let directory = tempdir().expect("create temp directory");
        let vpk_path = directory.path().join("pak01_dir.vpk");
        write_vpk(
            &vpk_path,
            &[
                TestEntry::new(
                    "resource/overviews/de_safe.txt",
                    b"pre",
                    b"load",
                    TestLocation::Inline,
                ),
                TestEntry::new(
                    "resource/overviews/de_safe_radar.dds",
                    b"DDS ",
                    b"pixels",
                    TestLocation::External(0),
                ),
            ],
        );

        let archive = VpkArchive::open(&vpk_path).expect("open VPK");
        assert_eq!(archive.len(), 2);
        assert_eq!(
            archive
                .entry("RESOURCE/OVERVIEWS/DE_SAFE.TXT")
                .expect("validate path")
                .expect("entry exists")
                .archive(),
            VpkArchiveLocation::Inline
        );
        assert_eq!(
            archive
                .read("resource/overviews/de_safe.txt")
                .expect("read inline entry"),
            b"preload"
        );
        assert_eq!(
            archive
                .read("resource/overviews/de_safe_radar.dds")
                .expect("read archive entry"),
            b"DDS pixels"
        );
    }

    #[test]
    fn rejects_crc_mismatch_and_truncated_external_archive() {
        let directory = tempdir().expect("create temp directory");
        let vpk_path = directory.path().join("pak01_dir.vpk");
        write_vpk(
            &vpk_path,
            &[TestEntry::new(
                "resource/overviews/de_safe.txt",
                b"",
                b"content",
                TestLocation::External(0),
            )],
        );
        let chunk = directory.path().join("pak01_000.vpk");
        fs::write(&chunk, b"xxxxxxx").expect("corrupt chunk");
        let archive = VpkArchive::open(&vpk_path).expect("open VPK");
        assert!(matches!(
            archive.read("resource/overviews/de_safe.txt"),
            Err(SourceAssetError::CrcMismatch { .. })
        ));

        OpenOptions::new()
            .write(true)
            .open(&chunk)
            .expect("open chunk")
            .set_len(2)
            .expect("truncate chunk");
        assert!(matches!(
            archive.read("resource/overviews/de_safe.txt"),
            Err(SourceAssetError::EntryOutOfBounds { .. })
        ));
    }

    #[test]
    fn rejects_traversal_invalid_terminator_and_inline_overflow() {
        let directory = tempdir().expect("create temp directory");
        let vpk_path = directory.path().join("pak01_dir.vpk");

        let traversal_tree = single_entry_tree("txt", "../outside", "map", 0, 0, 0xffff);
        fs::write(&vpk_path, wrap_tree(&traversal_tree, &[])).expect("write traversal VPK");
        assert!(matches!(
            VpkArchive::open(&vpk_path),
            Err(SourceAssetError::UnsafeVirtualPath { .. })
        ));

        let bad_terminator = single_entry_tree("txt", "resource", "map", 0, 0, 0);
        fs::write(&vpk_path, wrap_tree(&bad_terminator, &[])).expect("write bad VPK");
        assert!(matches!(
            VpkArchive::open(&vpk_path),
            Err(SourceAssetError::InvalidDirectoryTree { .. })
        ));

        let overflow = single_entry_tree("txt", "resource", "map", 0, 1, 0xffff);
        fs::write(&vpk_path, wrap_tree(&overflow, &[])).expect("write overflow VPK");
        assert!(matches!(
            VpkArchive::open(&vpk_path),
            Err(SourceAssetError::EntryOutOfBounds { .. })
        ));
    }

    #[test]
    fn enforces_tree_entry_path_and_archive_index_limits() {
        let directory = tempdir().expect("create temp directory");
        let vpk_path = directory.path().join("pak01_dir.vpk");
        let built = build_vpk(&[TestEntry::new(
            "resource/overviews/de_safe.txt",
            b"",
            b"content",
            TestLocation::External(7),
        )]);
        fs::write(&vpk_path, &built.directory).expect("write VPK");

        let limits = VpkLimits {
            max_tree_size: u64::MAX,
            max_trailing_data: 0,
            max_entries: 0,
            max_path_length: 1_024,
            max_entry_size: u64::MAX,
            max_archive_index: 7,
        };
        assert!(matches!(
            VpkArchive::open_with_limits(&vpk_path, limits),
            Err(SourceAssetError::LimitExceeded {
                kind: "VPK entry count",
                ..
            })
        ));

        let limits = VpkLimits {
            max_entries: 1,
            max_archive_index: 6,
            ..limits
        };
        assert!(matches!(
            VpkArchive::open_with_limits(&vpk_path, limits),
            Err(SourceAssetError::ArchiveIndexLimit { index: 7, limit: 6 })
        ));

        let limits = VpkLimits {
            max_path_length: 8,
            max_archive_index: 7,
            ..limits
        };
        assert!(matches!(
            VpkArchive::open_with_limits(&vpk_path, limits),
            Err(SourceAssetError::LimitExceeded { .. })
        ));

        let tree_size = u64::from(read_header_u32(
            built.directory[..VPK_V2_HEADER_LENGTH]
                .try_into()
                .expect("header"),
            8,
        ));
        let limits = VpkLimits {
            max_tree_size: tree_size - 1,
            max_path_length: 1_024,
            ..limits
        };
        assert!(matches!(
            VpkArchive::open_with_limits(&vpk_path, limits),
            Err(SourceAssetError::LimitExceeded {
                kind: "VPK directory tree",
                ..
            })
        ));
    }

    #[test]
    fn bounds_trailing_data_and_requires_full_tree_consumption() {
        let directory = tempdir().expect("create temp directory");
        let vpk_path = directory.path().join("pak01_dir.vpk");
        let built = build_vpk(&[]);
        let mut trailing_file = built.directory.clone();
        trailing_file.push(0xaa);
        fs::write(&vpk_path, trailing_file).expect("write trailing file");
        VpkArchive::open_with_limits(
            &vpk_path,
            VpkLimits {
                max_trailing_data: 1,
                ..VpkLimits::default()
            },
        )
        .expect("accept bounded Source 2 trailer");
        assert!(matches!(
            VpkArchive::open_with_limits(
                &vpk_path,
                VpkLimits {
                    max_trailing_data: 0,
                    ..VpkLimits::default()
                }
            ),
            Err(SourceAssetError::LimitExceeded {
                kind: "VPK trailing data",
                ..
            })
        ));

        let extra_tree = vec![0, 0xaa];
        fs::write(&vpk_path, wrap_tree(&extra_tree, &[])).expect("write extra tree bytes");
        assert!(matches!(
            VpkArchive::open(&vpk_path),
            Err(SourceAssetError::InvalidDirectoryTree { .. })
        ));
    }

    fn single_entry_tree(
        extension: &str,
        directory: &str,
        filename: &str,
        offset: u32,
        length: u32,
        terminator: u16,
    ) -> Vec<u8> {
        let mut tree = Vec::new();
        push_cstring(&mut tree, extension);
        push_cstring(&mut tree, directory);
        push_cstring(&mut tree, filename);
        tree.extend_from_slice(&crc32fast::hash(&[]).to_le_bytes());
        tree.extend_from_slice(&0_u16.to_le_bytes());
        tree.extend_from_slice(&VPK_INLINE_ARCHIVE_INDEX.to_le_bytes());
        tree.extend_from_slice(&offset.to_le_bytes());
        tree.extend_from_slice(&length.to_le_bytes());
        tree.extend_from_slice(&terminator.to_le_bytes());
        tree.extend_from_slice(&[0, 0, 0]);
        tree
    }

    fn wrap_tree(tree: &[u8], inline: &[u8]) -> Vec<u8> {
        let mut vpk = Vec::new();
        vpk.extend_from_slice(&VPK_SIGNATURE.to_le_bytes());
        vpk.extend_from_slice(&VPK_VERSION_2.to_le_bytes());
        vpk.extend_from_slice(
            &u32::try_from(tree.len())
                .expect("tree length fits")
                .to_le_bytes(),
        );
        vpk.extend_from_slice(
            &u32::try_from(inline.len())
                .expect("inline length fits")
                .to_le_bytes(),
        );
        vpk.extend_from_slice(&[0; 12]);
        vpk.extend_from_slice(tree);
        vpk.extend_from_slice(inline);
        vpk
    }

    fn push_cstring(bytes: &mut Vec<u8>, value: &str) {
        bytes.extend_from_slice(value.as_bytes());
        bytes.push(0);
    }
}
