use std::{collections::HashSet, io::Read as _, path::Path};

use crate::{MediaError, MediaResult, io_error};

#[must_use]
pub fn is_font_path(path: &Path) -> bool {
    path.extension()
        .and_then(|value| value.to_str())
        .is_some_and(|extension| {
            extension.eq_ignore_ascii_case("ttf") || extension.eq_ignore_ascii_case("otf")
        })
}

/// Checks the supported SFNT container and its bounded table directory.
/// Import and the renderer share this check; fonts have no A/V stream metadata.
/// Glyph shaping and outline decoding remain the renderer's responsibility.
///
/// # Errors
/// Returns an error for unsupported paths, invalid font headers or table ranges,
/// missing required SFNT tables, and file I/O failures.
pub fn validate_font_file(path: &Path) -> MediaResult<()> {
    if !is_font_path(path) || !path.is_file() {
        return Err(MediaError::InvalidInput(
            "custom font must be an existing .ttf or .otf file".to_owned(),
        ));
    }
    let file = std::fs::File::open(path).map_err(|error| io_error(path, error))?;
    let length = file
        .metadata()
        .map_err(|error| io_error(path, error))?
        .len();
    let mut reader = std::io::BufReader::new(file);
    let mut header = [0_u8; 12];
    reader
        .read_exact(&mut header)
        .map_err(|_| invalid_font("truncated SFNT header"))?;
    if header[..4] != [0, 1, 0, 0] && &header[..4] != b"OTTO" {
        return Err(invalid_font("expected a TrueType or OpenType SFNT header"));
    }
    let count = u16::from_be_bytes([header[4], header[5]]);
    let directory_end = 12 + u64::from(count) * 16;
    if count == 0 || directory_end > length {
        return Err(invalid_font("SFNT table directory is missing or truncated"));
    }
    // A u16 table count bounds this read to at most 1 MiB, regardless of the
    // source file size. Table payloads are not loaded for metadata inspection.
    let mut tags = HashSet::new();
    for _ in 0..count {
        let mut record = [0_u8; 16];
        reader
            .read_exact(&mut record)
            .map_err(|_| invalid_font("truncated SFNT table record"))?;
        let tag = [record[0], record[1], record[2], record[3]];
        let offset = u64::from(u32::from_be_bytes([
            record[8], record[9], record[10], record[11],
        ]));
        let size = u64::from(u32::from_be_bytes([
            record[12], record[13], record[14], record[15],
        ]));
        if !tags.insert(tag) || offset < directory_end || offset + size > length {
            return Err(invalid_font(
                "duplicate SFNT tag or table range outside the font",
            ));
        }
        let minimum = match &tag {
            b"head" => 54,
            b"maxp" => 6,
            b"cmap" => 4,
            _ => 0,
        };
        if size < minimum {
            return Err(invalid_font("required SFNT table is truncated"));
        }
    }
    if ![b"head", b"maxp", b"cmap"]
        .into_iter()
        .all(|tag| tags.contains(tag))
    {
        return Err(invalid_font("font requires head, maxp and cmap tables"));
    }
    Ok(())
}

fn invalid_font(message: &str) -> MediaError {
    MediaError::InvalidInput(format!("invalid font: {message}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_renamed_files_and_out_of_bounds_sfnt_tables() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("bad.otf");
        std::fs::write(&path, b"not a font despite its extension").unwrap();
        assert!(validate_font_file(&path).is_err());
        let mut bytes = vec![0; 28];
        bytes[..4].copy_from_slice(b"OTTO");
        bytes[4..6].copy_from_slice(&1_u16.to_be_bytes());
        bytes[12..16].copy_from_slice(b"head");
        bytes[20..24].copy_from_slice(&u32::MAX.to_be_bytes());
        bytes[24..28].copy_from_slice(&54_u32.to_be_bytes());
        std::fs::write(&path, bytes).unwrap();
        let error = validate_font_file(&path).expect_err("table exceeds file");
        assert!(error.to_string().contains("table range"));
    }
}
