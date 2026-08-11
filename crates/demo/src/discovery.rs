use std::{
    collections::{HashMap, HashSet},
    fs::File,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

use walkdir::WalkDir;
use zip::ZipArchive;

use crate::{
    DemoError, DemoResult, ParseCancellation, ValidatedDemo, ValidationLimits, io_error,
    validate_demo,
};

#[derive(Debug, Clone, Copy)]
pub struct DiscoveryOptions {
    pub recursive: bool,
    pub maximum_files: usize,
}

impl Default for DiscoveryOptions {
    fn default() -> Self {
        Self {
            recursive: true,
            maximum_files: 10_000,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiscoveryReport {
    pub demos: Vec<PathBuf>,
    pub errors: Vec<String>,
}

/// Finds demo files below a root without following directory symlinks.
///
/// # Errors
///
/// Returns an error when the root is missing or cannot be inspected.
pub fn discover_demos(
    root: impl AsRef<Path>,
    options: DiscoveryOptions,
) -> DemoResult<DiscoveryReport> {
    let root = root.as_ref();
    if root.is_file() {
        return Ok(DiscoveryReport {
            demos: is_demo(root)
                .then(|| root.to_path_buf())
                .into_iter()
                .collect(),
            errors: Vec::new(),
        });
    }
    if !root.exists() {
        return Err(DemoError::NotFound(root.to_path_buf()));
    }

    let depth = if options.recursive { usize::MAX } else { 1 };
    let mut demos = Vec::new();
    let mut errors = Vec::new();
    for entry in WalkDir::new(root).follow_links(false).max_depth(depth) {
        match entry {
            Ok(entry) if entry.file_type().is_file() && is_demo(entry.path()) => {
                if demos.len() == options.maximum_files {
                    errors.push(format!(
                        "discovery stopped after {} demo files",
                        options.maximum_files
                    ));
                    break;
                }
                demos.push(entry.into_path());
            }
            Ok(_) => {}
            Err(error) => errors.push(error.to_string()),
        }
    }
    demos.sort();
    demos.dedup();
    Ok(DiscoveryReport { demos, errors })
}

fn is_demo(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|value| value.eq_ignore_ascii_case("dem"))
}

/// Validates that an archive entry is a portable relative path.
///
/// # Errors
///
/// Returns [`DemoError::UnsafeArchivePath`] for absolute, parent-relative, or
/// platform-specific paths.
pub fn validate_archive_entry_path(name: &str) -> DemoResult<PathBuf> {
    let without_directory_suffix = name.strip_suffix('/').unwrap_or(name);
    if without_directory_suffix.is_empty()
        || name.contains('\0')
        || name.contains('\\')
        || name.starts_with('/')
        || without_directory_suffix
            .split('/')
            .any(|part| !is_portable_archive_component(part))
    {
        return Err(DemoError::UnsafeArchivePath(name.to_owned()));
    }
    let path = Path::new(without_directory_suffix);
    if path.components().any(|component| {
        matches!(
            component,
            Component::ParentDir | Component::RootDir | Component::Prefix(_)
        )
    }) {
        return Err(DemoError::UnsafeArchivePath(name.to_owned()));
    }
    Ok(path.to_path_buf())
}

fn is_portable_archive_component(component: &str) -> bool {
    if component.is_empty()
        || matches!(component, "." | "..")
        || component.ends_with([' ', '.'])
        || component.contains(':')
        || component.chars().any(char::is_control)
    {
        return false;
    }
    let stem = component
        .split_once('.')
        .map_or(component, |(stem, _)| stem)
        .to_ascii_uppercase();
    !matches!(
        stem.as_str(),
        "CON"
            | "PRN"
            | "AUX"
            | "NUL"
            | "COM1"
            | "COM2"
            | "COM3"
            | "COM4"
            | "COM5"
            | "COM6"
            | "COM7"
            | "COM8"
            | "COM9"
            | "LPT1"
            | "LPT2"
            | "LPT3"
            | "LPT4"
            | "LPT5"
            | "LPT6"
            | "LPT7"
            | "LPT8"
            | "LPT9"
    )
}

#[derive(Debug, Clone, Copy)]
pub struct ArchiveLimits {
    pub maximum_entries: usize,
    pub maximum_expanded_bytes: u64,
    pub maximum_demo_files: usize,
    pub maximum_compression_ratio: u64,
}

impl Default for ArchiveLimits {
    fn default() -> Self {
        Self {
            maximum_entries: 2_000,
            maximum_expanded_bytes: 4 * 1024 * 1024 * 1024,
            maximum_demo_files: 256,
            maximum_compression_ratio: 200,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExtractedDemoArchive {
    pub demos: Vec<ValidatedDemo>,
    pub expanded_bytes: u64,
}

#[derive(Debug, Clone)]
struct ArchiveDemoEntry {
    index: usize,
    relative_path: PathBuf,
    size: u64,
}

#[derive(Debug)]
struct ArchiveInspection {
    demos: Vec<ArchiveDemoEntry>,
    expanded_bytes: u64,
}

/// Inspects an archive without extracting it and returns safe demo entry paths.
///
/// # Errors
///
/// Returns an error for unreadable archives, unsafe entry names, or configured
/// entry/expanded-size limit violations.
pub fn inspect_demo_zip(path: impl AsRef<Path>, limits: ArchiveLimits) -> DemoResult<Vec<PathBuf>> {
    let path = path.as_ref();
    let file = File::open(path).map_err(|error| io_error(path, error))?;
    let mut archive = ZipArchive::new(file)?;
    Ok(inspect_archive(&mut archive, limits)?
        .demos
        .into_iter()
        .map(|entry| entry.relative_path)
        .collect())
}

fn inspect_archive(
    archive: &mut ZipArchive<File>,
    limits: ArchiveLimits,
) -> DemoResult<ArchiveInspection> {
    if archive.len() > limits.maximum_entries {
        return Err(DemoError::ArchiveEntryLimit(limits.maximum_entries));
    }
    let mut expanded = 0_u64;
    let mut demos = Vec::new();
    let mut entry_names = HashSet::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index)?;
        let safe = validate_archive_entry_path(entry.name())?;
        let identity = safe.to_string_lossy().replace('\\', "/").to_lowercase();
        if !entry_names.insert(identity) {
            return Err(DemoError::DuplicateArchivePath(entry.name().to_owned()));
        }
        if entry.unix_mode().is_some_and(|mode| {
            let file_type = mode & 0o170_000;
            file_type != 0
                && !matches!(
                    (entry.is_dir(), file_type),
                    (true, 0o040_000) | (false, 0o100_000)
                )
        }) {
            return Err(DemoError::UnsafeArchiveFileType(entry.name().to_owned()));
        }
        expanded = expanded
            .checked_add(entry.size())
            .ok_or(DemoError::ArchiveSizeLimit(limits.maximum_expanded_bytes))?;
        if expanded > limits.maximum_expanded_bytes {
            return Err(DemoError::ArchiveSizeLimit(limits.maximum_expanded_bytes));
        }
        if entry.size() >= 1024 * 1024
            && (entry.compressed_size() == 0
                || entry.size()
                    > entry
                        .compressed_size()
                        .saturating_mul(limits.maximum_compression_ratio))
        {
            return Err(DemoError::ArchiveCompressionRatio(entry.name().to_owned()));
        }
        if !entry.is_dir() && is_demo(&safe) {
            if demos.len() == limits.maximum_demo_files {
                return Err(DemoError::ArchiveDemoLimit(limits.maximum_demo_files));
            }
            demos.push(ArchiveDemoEntry {
                index,
                relative_path: safe,
                size: entry.size(),
            });
        }
    }
    if demos.is_empty() {
        return Err(DemoError::EmptyDemoArchive);
    }
    Ok(ArchiveInspection {
        demos,
        expanded_bytes: expanded,
    })
}

/// Extracts only validated `.dem` entries into a newly published directory.
///
/// The archive is inspected before any extraction. Entries are streamed into a
/// sibling staging directory with create-new semantics, validated and hashed,
/// then the complete directory is renamed into place. Any failure removes the
/// staging directory, so callers never observe a partial batch.
///
/// # Errors
///
/// Returns an error for unsafe or ambiguous entry paths, symlinks, archive
/// bombs, invalid demos, existing destinations, cancellation, or I/O failures.
pub fn extract_demo_zip_atomic(
    archive_path: impl AsRef<Path>,
    destination: impl AsRef<Path>,
    archive_limits: ArchiveLimits,
    demo_limits: ValidationLimits,
    cancellation: &ParseCancellation,
) -> DemoResult<ExtractedDemoArchive> {
    let archive_path = archive_path.as_ref();
    let destination = destination.as_ref();
    cancellation.check()?;
    if destination.exists() {
        return Err(io_error(
            destination,
            std::io::Error::new(
                std::io::ErrorKind::AlreadyExists,
                "archive destination already exists",
            ),
        ));
    }
    let parent = destination.parent().ok_or_else(|| {
        io_error(
            destination,
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                "archive destination has no parent",
            ),
        )
    })?;
    std::fs::create_dir_all(parent).map_err(|error| io_error(parent, error))?;
    let staging = parent.join(format!(
        ".{}.{}.staging",
        destination
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("demo-archive"),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&staging).map_err(|error| io_error(&staging, error))?;

    let outcome = extract_archive_to_staging(
        archive_path,
        &staging,
        archive_limits,
        demo_limits,
        cancellation,
    );
    let (validated, expanded_bytes) = match outcome {
        Ok(result) => result,
        Err(error) => {
            let _ = std::fs::remove_dir_all(&staging);
            return Err(error);
        }
    };
    cancellation.check().inspect_err(|_| {
        let _ = std::fs::remove_dir_all(&staging);
    })?;
    if let Err(error) = std::fs::rename(&staging, destination) {
        let _ = std::fs::remove_dir_all(&staging);
        return Err(io_error(destination, error));
    }
    let demos = validated
        .into_iter()
        .map(|(relative_path, validated)| ValidatedDemo {
            path: destination.join(relative_path),
            size: validated.size,
            sha256: validated.sha256,
        })
        .collect();
    Ok(ExtractedDemoArchive {
        demos,
        expanded_bytes,
    })
}

fn extract_archive_to_staging(
    archive_path: &Path,
    staging: &Path,
    archive_limits: ArchiveLimits,
    demo_limits: ValidationLimits,
    cancellation: &ParseCancellation,
) -> DemoResult<(Vec<(PathBuf, ValidatedDemo)>, u64)> {
    let file = File::open(archive_path).map_err(|error| io_error(archive_path, error))?;
    let mut archive = ZipArchive::new(file)?;
    let inspection = inspect_archive(&mut archive, archive_limits)?;
    let entries = inspection
        .demos
        .iter()
        .map(|entry| (entry.index, (entry.relative_path.clone(), entry.size)))
        .collect::<HashMap<_, _>>();
    let mut validated = Vec::with_capacity(entries.len());
    for index in 0..archive.len() {
        cancellation.check()?;
        let Some((relative_path, declared_size)) = entries.get(&index) else {
            continue;
        };
        if *declared_size < demo_limits.minimum_bytes {
            return Err(DemoError::TooSmall {
                actual: *declared_size,
                minimum: demo_limits.minimum_bytes,
            });
        }
        if *declared_size > demo_limits.maximum_bytes {
            return Err(DemoError::TooLarge {
                actual: *declared_size,
                maximum: demo_limits.maximum_bytes,
            });
        }
        let mut entry = archive.by_index(index)?;
        let target = staging.join(relative_path);
        let target_parent = target.parent().unwrap_or(staging);
        std::fs::create_dir_all(target_parent).map_err(|error| io_error(target_parent, error))?;
        let mut output = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&target)
            .map_err(|error| io_error(&target, error))?;
        let copied = std::io::copy(
            &mut entry.by_ref().take(declared_size.saturating_add(1)),
            &mut output,
        )
        .map_err(|error| io_error(&target, error))?;
        if copied != *declared_size {
            return Err(io_error(
                &target,
                std::io::Error::new(
                    std::io::ErrorKind::InvalidData,
                    "archive entry size does not match its directory record",
                ),
            ));
        }
        output.flush().map_err(|error| io_error(&target, error))?;
        output
            .sync_all()
            .map_err(|error| io_error(&target, error))?;
        drop(output);
        let demo = validate_demo(&target, demo_limits, cancellation)?;
        validated.push((relative_path.clone(), demo));
    }
    Ok((validated, inspection.expanded_bytes))
}

#[cfg(test)]
mod tests {
    use std::{fs, io::Write};

    use super::*;

    #[test]
    fn recursive_discovery_is_sorted_and_ignores_symlinks() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("nested")).unwrap();
        fs::write(root.path().join("z.dem"), b"").unwrap();
        fs::write(root.path().join("nested/a.DEM"), b"").unwrap();
        fs::write(root.path().join("nested/no.txt"), b"").unwrap();

        let report = discover_demos(root.path(), DiscoveryOptions::default()).unwrap();
        assert_eq!(report.demos.len(), 2);
        assert!(report.demos[0].ends_with("a.DEM"));
        assert!(report.demos[1].ends_with("z.dem"));
    }

    #[test]
    fn non_recursive_discovery_stays_at_root() {
        let root = tempfile::tempdir().unwrap();
        fs::create_dir(root.path().join("nested")).unwrap();
        fs::write(root.path().join("root.dem"), b"").unwrap();
        fs::write(root.path().join("nested/hidden.dem"), b"").unwrap();
        let report = discover_demos(
            root.path(),
            DiscoveryOptions {
                recursive: false,
                ..DiscoveryOptions::default()
            },
        )
        .unwrap();
        assert_eq!(report.demos.len(), 1);
    }

    #[test]
    fn archive_path_rejects_zip_slip_and_windows_paths() {
        for unsafe_name in [
            "../escape.dem",
            "/root.dem",
            "C:\\escape.dem",
            "folder\\bad.dem",
        ] {
            assert!(matches!(
                validate_archive_entry_path(unsafe_name),
                Err(DemoError::UnsafeArchivePath(_))
            ));
        }
        assert_eq!(
            validate_archive_entry_path("matches/good.dem").unwrap(),
            PathBuf::from("matches/good.dem")
        );
    }

    #[test]
    fn zip_inspection_reports_safe_demo_entries() {
        let file = tempfile::Builder::new().suffix(".zip").tempfile().unwrap();
        {
            let mut writer = zip::ZipWriter::new(file.reopen().unwrap());
            writer
                .start_file("nested/match.dem", zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"demo").unwrap();
            writer
                .start_file("notes.txt", zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"notes").unwrap();
            writer.finish().unwrap();
        }
        let entries = inspect_demo_zip(file.path(), ArchiveLimits::default()).unwrap();
        assert_eq!(entries, [PathBuf::from("nested/match.dem")]);
    }

    #[test]
    fn extraction_validates_and_atomically_publishes_demo_files() {
        let root = tempfile::tempdir().unwrap();
        let archive_path = root.path().join("matches.zip");
        {
            let file = File::create(&archive_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            writer
                .start_file("nested/match.dem", zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"PBDEMS2\0abcdefgh").unwrap();
            writer
                .start_file("notes.txt", zip::write::SimpleFileOptions::default())
                .unwrap();
            writer.write_all(b"ignored").unwrap();
            writer.finish().unwrap();
        }

        let destination = root.path().join("published");
        let report = extract_demo_zip_atomic(
            &archive_path,
            &destination,
            ArchiveLimits::default(),
            ValidationLimits::default(),
            &ParseCancellation::default(),
        )
        .unwrap();
        assert_eq!(report.demos.len(), 1);
        assert_eq!(report.demos[0].size, 16);
        assert!(destination.join("nested/match.dem").is_file());
        assert!(!destination.join("notes.txt").exists());
    }

    #[test]
    fn invalid_demo_rolls_back_the_entire_archive_destination() {
        let root = tempfile::tempdir().unwrap();
        let archive_path = root.path().join("invalid.zip");
        {
            let file = File::create(&archive_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            for (name, bytes) in [
                ("valid.dem", b"PBDEMS2\0abcdefgh".as_slice()),
                ("invalid.dem", b"NOTADEMOabcdefgh".as_slice()),
            ] {
                writer
                    .start_file(name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(bytes).unwrap();
            }
            writer.finish().unwrap();
        }

        let destination = root.path().join("must-not-exist");
        assert!(
            extract_demo_zip_atomic(
                &archive_path,
                &destination,
                ArchiveLimits::default(),
                ValidationLimits::default(),
                &ParseCancellation::default(),
            )
            .is_err()
        );
        assert!(!destination.exists());
        assert!(fs::read_dir(root.path()).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".staging")
        }));
    }

    #[test]
    fn duplicate_case_folded_paths_are_rejected() {
        let root = tempfile::tempdir().unwrap();
        let archive_path = root.path().join("duplicate.zip");
        {
            let file = File::create(&archive_path).unwrap();
            let mut writer = zip::ZipWriter::new(file);
            for name in ["Match.dem", "match.DEM"] {
                writer
                    .start_file(name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(b"PBDEMS2\0abcdefgh").unwrap();
            }
            writer.finish().unwrap();
        }
        assert!(matches!(
            inspect_demo_zip(&archive_path, ArchiveLimits::default()),
            Err(DemoError::DuplicateArchivePath(_))
        ));
    }

    #[test]
    fn portable_archive_paths_reject_aliases_and_device_names() {
        for unsafe_name in [
            "folder//match.dem",
            "folder/./match.dem",
            "folder/name:stream.dem",
            "NUL.dem",
            "trailing./match.dem",
        ] {
            assert!(matches!(
                validate_archive_entry_path(unsafe_name),
                Err(DemoError::UnsafeArchivePath(_))
            ));
        }
    }

    #[test]
    fn archive_limits_cover_demo_count_expansion_and_compression_ratio() {
        let root = tempfile::tempdir().unwrap();
        let two_demos = root.path().join("two.zip");
        {
            let mut writer = zip::ZipWriter::new(File::create(&two_demos).unwrap());
            for (name, content) in [
                ("one.dem", b"PBDEMS2\0one-demo".as_slice()),
                ("two.dem", b"PBDEMS2\0two-demo".as_slice()),
            ] {
                writer
                    .start_file(name, zip::write::SimpleFileOptions::default())
                    .unwrap();
                writer.write_all(content).unwrap();
            }
            writer.finish().unwrap();
        }
        assert!(matches!(
            inspect_demo_zip(
                &two_demos,
                ArchiveLimits {
                    maximum_demo_files: 1,
                    ..ArchiveLimits::default()
                }
            ),
            Err(DemoError::ArchiveDemoLimit(1))
        ));
        assert!(matches!(
            inspect_demo_zip(
                &two_demos,
                ArchiveLimits {
                    maximum_expanded_bytes: 15,
                    ..ArchiveLimits::default()
                }
            ),
            Err(DemoError::ArchiveSizeLimit(15))
        ));

        let compressed = root.path().join("compressed.zip");
        {
            let mut writer = zip::ZipWriter::new(File::create(&compressed).unwrap());
            writer
                .start_file(
                    "large.dem",
                    zip::write::SimpleFileOptions::default()
                        .compression_method(zip::CompressionMethod::Deflated),
                )
                .unwrap();
            let mut content = vec![0_u8; 1024 * 1024];
            content[..8].copy_from_slice(b"PBDEMS2\0");
            writer.write_all(&content).unwrap();
            writer.finish().unwrap();
        }
        assert!(matches!(
            inspect_demo_zip(
                &compressed,
                ArchiveLimits {
                    maximum_compression_ratio: 2,
                    ..ArchiveLimits::default()
                }
            ),
            Err(DemoError::ArchiveCompressionRatio(_))
        ));
    }

    #[test]
    fn archive_symlink_entries_are_rejected_even_when_named_as_demos() {
        let file = tempfile::Builder::new().suffix(".zip").tempfile().unwrap();
        {
            let mut writer = zip::ZipWriter::new(file.reopen().unwrap());
            writer
                .add_symlink(
                    "linked.dem",
                    "outside.dem",
                    zip::write::SimpleFileOptions::default(),
                )
                .unwrap();
            writer.finish().unwrap();
        }
        assert!(matches!(
            inspect_demo_zip(file.path(), ArchiveLimits::default()),
            Err(DemoError::UnsafeArchiveFileType(_))
        ));
    }
}
