use std::{cmp::Reverse, ffi::OsStr, io, path::Path, time::SystemTime};

const MAXIMUM_LOG_ENTRIES_TO_INSPECT: usize = 10_000;

/// Removes the oldest regular daily log files while preserving the newest `retain` files.
///
/// Symbolic links, directories, unrelated files, and the unsuffixed active log name are ignored.
///
/// # Errors
///
/// Returns an error when the log directory cannot be read or a selected old log cannot be removed.
pub fn prune_daily_logs(directory: &Path, stem: &str, retain: usize) -> io::Result<usize> {
    if retain == 0 || stem.is_empty() {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "log retention requires a non-zero window and file stem",
        ));
    }
    let prefix = format!("{stem}.");
    let mut candidates = Vec::new();
    for entry in std::fs::read_dir(directory)?.take(MAXIMUM_LOG_ENTRIES_TO_INSPECT) {
        let entry = entry?;
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with(&prefix) || name == OsStr::new(stem) {
            continue;
        }
        let metadata = std::fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            continue;
        }
        candidates.push((
            metadata.modified().unwrap_or(SystemTime::UNIX_EPOCH),
            name,
            entry.path(),
        ));
    }
    candidates.sort_by_key(|(modified, name, _)| Reverse((*modified, name.clone())));
    let mut removed = 0;
    for (_, _, path) in candidates.into_iter().skip(retain) {
        std::fs::remove_file(path)?;
        removed += 1;
    }
    Ok(removed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retention_removes_only_old_matching_regular_files() {
        let directory = tempfile::tempdir().expect("log directory");
        for index in 0..16 {
            std::fs::write(
                directory.path().join(format!("app.log.2026-01-{index:02}")),
                b"log",
            )
            .expect("log fixture");
        }
        std::fs::write(directory.path().join("unrelated.txt"), b"keep").expect("unrelated fixture");

        assert_eq!(
            prune_daily_logs(directory.path(), "app.log", 14).expect("retention"),
            2
        );
        let remaining = std::fs::read_dir(directory.path())
            .expect("remaining logs")
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("app.log."))
            .count();
        assert_eq!(remaining, 14);
        assert!(directory.path().join("unrelated.txt").is_file());
    }
}
