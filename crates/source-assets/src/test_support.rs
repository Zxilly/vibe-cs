use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
};

use crate::{VPK_INLINE_ARCHIVE_INDEX, VPK_SIGNATURE, VPK_VERSION_2};

#[derive(Debug, Clone, Copy)]
pub(crate) enum TestLocation {
    Inline,
    External(u16),
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct TestEntry<'a> {
    path: &'a str,
    preload: &'a [u8],
    body: &'a [u8],
    location: TestLocation,
}

impl<'a> TestEntry<'a> {
    pub(crate) const fn new(
        path: &'a str,
        preload: &'a [u8],
        body: &'a [u8],
        location: TestLocation,
    ) -> Self {
        Self {
            path,
            preload,
            body,
            location,
        }
    }
}

pub(crate) struct BuiltVpk {
    pub(crate) directory: Vec<u8>,
    pub(crate) archives: BTreeMap<u16, Vec<u8>>,
}

pub(crate) fn build_vpk(entries: &[TestEntry<'_>]) -> BuiltVpk {
    let mut inline = Vec::new();
    let mut archives: BTreeMap<u16, Vec<u8>> = BTreeMap::new();
    let mut groups: BTreeMap<String, BTreeMap<String, Vec<PreparedEntry<'_>>>> = BTreeMap::new();

    for entry in entries {
        let (directory, leaf) = entry.path.rsplit_once('/').unwrap_or((" ", entry.path));
        let (filename, extension) = leaf.rsplit_once('.').unwrap_or((leaf, " "));
        let (archive_index, offset) = match entry.location {
            TestLocation::Inline => {
                let offset = inline.len();
                inline.extend_from_slice(entry.body);
                (VPK_INLINE_ARCHIVE_INDEX, offset)
            }
            TestLocation::External(index) => {
                let archive = archives.entry(index).or_default();
                let offset = archive.len();
                archive.extend_from_slice(entry.body);
                (index, offset)
            }
        };
        let mut complete = Vec::with_capacity(entry.preload.len() + entry.body.len());
        complete.extend_from_slice(entry.preload);
        complete.extend_from_slice(entry.body);
        groups
            .entry(extension.to_owned())
            .or_default()
            .entry(directory.to_owned())
            .or_default()
            .push(PreparedEntry {
                filename,
                crc32: crc32fast::hash(&complete),
                preload: entry.preload,
                archive_index,
                offset: u32::try_from(offset).expect("test offset fits u32"),
                length: u32::try_from(entry.body.len()).expect("test body fits u32"),
            });
    }

    let mut tree = Vec::new();
    for (extension, directories) in groups {
        push_cstring(&mut tree, &extension);
        for (directory, entries) in directories {
            push_cstring(&mut tree, &directory);
            for entry in entries {
                push_cstring(&mut tree, entry.filename);
                tree.extend_from_slice(&entry.crc32.to_le_bytes());
                tree.extend_from_slice(
                    &u16::try_from(entry.preload.len())
                        .expect("test preload fits u16")
                        .to_le_bytes(),
                );
                tree.extend_from_slice(&entry.archive_index.to_le_bytes());
                tree.extend_from_slice(&entry.offset.to_le_bytes());
                tree.extend_from_slice(&entry.length.to_le_bytes());
                tree.extend_from_slice(&u16::MAX.to_le_bytes());
                tree.extend_from_slice(entry.preload);
            }
            tree.push(0);
        }
        tree.push(0);
    }
    tree.push(0);

    let mut directory = Vec::new();
    directory.extend_from_slice(&VPK_SIGNATURE.to_le_bytes());
    directory.extend_from_slice(&VPK_VERSION_2.to_le_bytes());
    directory.extend_from_slice(
        &u32::try_from(tree.len())
            .expect("test tree fits u32")
            .to_le_bytes(),
    );
    directory.extend_from_slice(
        &u32::try_from(inline.len())
            .expect("test inline data fits u32")
            .to_le_bytes(),
    );
    directory.extend_from_slice(&[0; 12]);
    directory.extend_from_slice(&tree);
    directory.extend_from_slice(&inline);
    BuiltVpk {
        directory,
        archives,
    }
}

pub(crate) fn write_vpk(path: &Path, entries: &[TestEntry<'_>]) {
    let built = build_vpk(entries);
    fs::write(path, built.directory).expect("write directory VPK");
    let parent = path.parent().expect("directory VPK has parent");
    let prefix = path
        .file_name()
        .and_then(|name| name.to_str())
        .and_then(|name| name.strip_suffix("_dir.vpk"))
        .expect("directory VPK test filename");
    for (index, bytes) in built.archives {
        let archive_path: PathBuf = parent.join(format!("{prefix}_{index:03}.vpk"));
        fs::write(archive_path, bytes).expect("write archive VPK");
    }
}

struct PreparedEntry<'a> {
    filename: &'a str,
    crc32: u32,
    preload: &'a [u8],
    archive_index: u16,
    offset: u32,
    length: u32,
}

fn push_cstring(bytes: &mut Vec<u8>, value: &str) {
    bytes.extend_from_slice(value.as_bytes());
    bytes.push(0);
}
