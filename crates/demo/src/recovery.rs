use std::{
    fs::{File, OpenOptions},
    io::{BufReader, Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
};

use crate::{
    DemoError, DemoResult, ParseCancellation, SOURCE2_DEMO_MAGIC, ValidationLimits, io_error,
};
use source2_demo::proto::EDemoCommands;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TerminalTailRepairCopy {
    pub path: PathBuf,
    pub source_bytes: u64,
    pub copied_bytes: u64,
    pub reason: &'static str,
}

#[derive(Debug)]
struct RemoveOnDrop {
    path: PathBuf,
    armed: bool,
}

impl Drop for RemoveOnDrop {
    fn drop(&mut self) {
        if self.armed {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// Creates a separate repair copy only when a complete file-info
/// message is followed by one provably incomplete terminal message. The source
/// is never opened for writing. Other malformed layouts remain rejected.
///
/// # Errors
///
/// Returns an error for invalid headers, unsafe destinations, I/O failures, or
/// damage that is not the narrowly supported trailing-message case.
pub fn create_terminal_tail_repair_copy(
    source: impl AsRef<Path>,
    destination: impl AsRef<Path>,
) -> DemoResult<Option<TerminalTailRepairCopy>> {
    create_terminal_tail_repair_copy_cancellable(source, destination, &ParseCancellation::default())
}

/// Creates the same bounded repair copy while cooperatively observing
/// cancellation throughout header inspection, message scanning, and copying.
///
/// # Errors
///
/// Returns [`DemoError::Cancelled`] once cancellation is observed. A partial
/// destination is removed before returning.
pub fn create_terminal_tail_repair_copy_cancellable(
    source: impl AsRef<Path>,
    destination: impl AsRef<Path>,
    cancellation: &ParseCancellation,
) -> DemoResult<Option<TerminalTailRepairCopy>> {
    let source = source.as_ref();
    let destination = destination.as_ref();
    cancellation.check()?;
    if destination
        .extension()
        .and_then(|value| value.to_str())
        .is_none_or(|value| !value.eq_ignore_ascii_case("dem"))
    {
        return Err(DemoError::UnsupportedExtension(destination.to_path_buf()));
    }
    let file = File::open(source).map_err(|error| io_error(source, error))?;
    let source_bytes = file
        .metadata()
        .map_err(|error| io_error(source, error))?
        .len();
    if source_bytes > ValidationLimits::default().maximum_bytes || source_bytes < 16 {
        return Err(DemoError::MetadataUnavailable(
            "demo size is outside repair-copy limits",
        ));
    }
    let mut reader = BufReader::new(file);
    let mut header = [0_u8; 16];
    reader
        .read_exact(&mut header)
        .map_err(|error| io_error(source, error))?;
    cancellation.check()?;
    if &header[..8] != SOURCE2_DEMO_MAGIC {
        return Err(DemoError::InvalidMagic);
    }
    let file_info_offset = u64::from(u32::from_le_bytes([
        header[8], header[9], header[10], header[11],
    ]));
    if !(16..source_bytes).contains(&file_info_offset) {
        return Err(DemoError::MetadataUnavailable(
            "demo file-info offset is outside the file",
        ));
    }

    let mut offset = 16_u64;
    let mut complete_file_info = false;
    let mut incomplete_tail = None;
    while offset < source_bytes {
        cancellation.check()?;
        reader
            .seek(SeekFrom::Start(offset))
            .map_err(|error| io_error(source, error))?;
        let frame_start = offset;
        let Some((command, command_bytes)) =
            read_varint(&mut reader, source_bytes - offset, source, cancellation)?
        else {
            incomplete_tail = Some(frame_start);
            break;
        };
        offset += command_bytes;
        let Some((_, tick_bytes)) =
            read_varint(&mut reader, source_bytes - offset, source, cancellation)?
        else {
            incomplete_tail = Some(frame_start);
            break;
        };
        offset += tick_bytes;
        let Some((size, size_bytes)) =
            read_varint(&mut reader, source_bytes - offset, source, cancellation)?
        else {
            incomplete_tail = Some(frame_start);
            break;
        };
        offset += size_bytes;
        let end = offset
            .checked_add(size)
            .ok_or(DemoError::MetadataUnavailable("demo message size overflow"))?;
        if end > source_bytes {
            incomplete_tail = Some(frame_start);
            break;
        }
        let command_kind = command & !(EDemoCommands::DemIsCompressed as u64);
        if frame_start == file_info_offset && command_kind == EDemoCommands::DemFileInfo as u64 {
            complete_file_info = true;
        }
        offset = end;
    }

    let Some(copied_bytes) = incomplete_tail else {
        return Ok(None);
    };
    if !complete_file_info || copied_bytes <= file_info_offset {
        return Err(DemoError::MetadataUnavailable(
            "truncation is not an incomplete terminal message after a complete file-info packet",
        ));
    }
    cancellation.check()?;
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(destination)
        .map_err(|error| io_error(destination, error))?;
    let mut cleanup = RemoveOnDrop {
        path: destination.to_path_buf(),
        armed: true,
    };
    reader
        .seek(SeekFrom::Start(0))
        .map_err(|error| io_error(source, error))?;
    let mut bounded = reader.take(copied_bytes);
    let mut copied = 0_u64;
    let mut buffer = vec![0_u8; 64 * 1024];
    while copied < copied_bytes {
        cancellation.check()?;
        let remaining = copied_bytes - copied;
        let limit = usize::try_from(remaining)
            .unwrap_or(usize::MAX)
            .min(buffer.len());
        let read = bounded
            .read(&mut buffer[..limit])
            .map_err(|error| io_error(source, error))?;
        if read == 0 {
            break;
        }
        output
            .write_all(&buffer[..read])
            .map_err(|error| io_error(destination, error))?;
        copied = copied
            .checked_add(u64::try_from(read).unwrap_or(u64::MAX))
            .ok_or(DemoError::MetadataUnavailable(
                "repair copy byte count overflow",
            ))?;
    }
    if copied != copied_bytes {
        return Err(DemoError::MetadataUnavailable(
            "repair copy ended before the verified boundary",
        ));
    }
    output
        .flush()
        .map_err(|error| io_error(destination, error))?;
    cancellation.check()?;
    output
        .sync_all()
        .map_err(|error| io_error(destination, error))?;
    cancellation.check()?;
    cleanup.armed = false;
    Ok(Some(TerminalTailRepairCopy {
        path: destination.to_path_buf(),
        source_bytes,
        copied_bytes,
        reason: "removed an incomplete terminal message after a complete file-info packet",
    }))
}

fn read_varint(
    reader: &mut impl Read,
    remaining: u64,
    source: &Path,
    cancellation: &ParseCancellation,
) -> DemoResult<Option<(u64, u64)>> {
    let mut value = 0_u64;
    for index in 0..5_u32 {
        cancellation.check()?;
        if u64::from(index) >= remaining {
            return Ok(None);
        }
        let mut byte = [0_u8; 1];
        if reader
            .read(&mut byte)
            .map_err(|error| io_error(source, error))?
            == 0
        {
            return Ok(None);
        }
        value |= u64::from(byte[0] & 0x7f) << (index * 7);
        if byte[0] & 0x80 == 0 {
            return Ok(Some((value, u64::from(index + 1))));
        }
    }
    Ok(None)
}

#[cfg(test)]
mod tests {
    use std::{io::Seek as _, time::Duration};

    use super::*;

    fn push_varint(bytes: &mut Vec<u8>, mut value: u64) {
        loop {
            let byte = u8::try_from(value & 0x7f).expect("seven bits fit");
            value >>= 7;
            if value == 0 {
                bytes.push(byte);
                break;
            }
            bytes.push(byte | 0x80);
        }
    }

    #[test]
    fn creates_a_new_repair_copy_only_for_a_proven_incomplete_terminal_message() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source.dem");
        let destination = temporary.path().join("repair.dem");
        let mut bytes = Vec::from(*b"PBDEMS2\0");
        bytes.extend_from_slice(&16_u32.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(&[2, 2, 1, 9]);
        bytes.extend_from_slice(&[2, 3, 5, 7]);
        std::fs::write(&source, &bytes).unwrap();
        let copy = create_terminal_tail_repair_copy(&source, &destination)
            .unwrap()
            .unwrap();
        assert_eq!(copy.copied_bytes, 20);
        assert_eq!(std::fs::read(&destination).unwrap(), bytes[..20]);
        assert_eq!(std::fs::read(&source).unwrap(), bytes);
    }

    #[test]
    fn rejects_truncation_before_the_file_info_message() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source.dem");
        let mut bytes = Vec::from(*b"PBDEMS2\0");
        bytes.extend_from_slice(&32_u32.to_le_bytes());
        bytes.extend_from_slice(&0_u32.to_le_bytes());
        bytes.extend_from_slice(&[1, 2, 9, 7]);
        std::fs::write(&source, bytes).unwrap();
        assert!(
            create_terminal_tail_repair_copy(&source, temporary.path().join("repair.dem")).is_err()
        );
    }

    #[test]
    fn cancellation_during_bounded_copy_removes_partial_destination() {
        let temporary = tempfile::tempdir().unwrap();
        let source = temporary.path().join("source.dem");
        let destination = temporary.path().join("repair.dem");
        let payload_bytes = 32 * 1024 * 1024_u64;
        let mut prefix = Vec::from(*b"PBDEMS2\0");
        prefix.extend_from_slice(&16_u32.to_le_bytes());
        prefix.extend_from_slice(&0_u32.to_le_bytes());
        prefix.extend_from_slice(&[2, 2, 1, 9]);
        prefix.extend_from_slice(&[1, 3]);
        push_varint(&mut prefix, payload_bytes);
        let payload_start = u64::try_from(prefix.len()).unwrap();
        let tail_start = payload_start + payload_bytes;
        let mut file = File::create(&source).unwrap();
        file.write_all(&prefix).unwrap();
        file.seek(SeekFrom::Start(tail_start)).unwrap();
        file.write_all(&[2, 3, 5, 7]).unwrap();
        file.sync_all().unwrap();

        let cancellation = ParseCancellation::default();
        let cancellation_for_thread = cancellation.clone();
        let destination_for_thread = destination.clone();
        let canceller = std::thread::spawn(move || {
            let deadline = std::time::Instant::now() + Duration::from_secs(5);
            while !destination_for_thread.exists() && std::time::Instant::now() < deadline {
                std::thread::yield_now();
            }
            cancellation_for_thread.cancel();
        });
        let result =
            create_terminal_tail_repair_copy_cancellable(&source, &destination, &cancellation);
        canceller.join().unwrap();

        assert!(matches!(result, Err(DemoError::Cancelled)));
        assert!(!destination.exists());
        assert_eq!(std::fs::metadata(source).unwrap().len(), tail_start + 4);
    }
}
