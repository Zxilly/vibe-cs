use std::collections::BTreeSet;
use std::fs::{self, File};
use std::io::{self, Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};

use tempfile::Builder;

use crate::{
    BackendError, BackendReport, CosmeticField, DemoRewriteBackend, LimitKind, RewriteError,
    RewriteLimits, RewriteReport, RewriteRequest, Source2RewriteBackend,
};

const DEMO_MAGIC: &[u8; 8] = b"PBDEMS2\0";

/// Safely rewrites a demo with the production Source 2 backend.
///
/// # Errors
///
/// Returns [`RewriteError`] when validation, bounded rewriting,
/// synchronization, or atomic publication fails.
pub fn rewrite_demo(
    input: impl AsRef<Path>,
    output: impl AsRef<Path>,
    request: &RewriteRequest,
    limits: &RewriteLimits,
) -> Result<RewriteReport, RewriteError> {
    rewrite_demo_with_backend(input, output, request, limits, &Source2RewriteBackend)
}

/// Safely rewrites a demo with an injected stream backend.
///
/// The facade owns validation, resource bounds, staging, synchronization, and
/// same-directory atomic publication. The backend never receives a final path.
///
/// # Errors
///
/// Returns [`RewriteError`] when validation, the injected backend, bounded
/// writing, synchronization, or atomic publication fails.
pub fn rewrite_demo_with_backend<B>(
    input: impl AsRef<Path>,
    output: impl AsRef<Path>,
    request: &RewriteRequest,
    limits: &RewriteLimits,
    backend: &B,
) -> Result<RewriteReport, RewriteError>
where
    B: DemoRewriteBackend + ?Sized,
{
    request.validate(limits)?;
    let paths = ResolvedPaths::new(input.as_ref(), output.as_ref())?;
    let mut input_file = File::open(&paths.input)
        .map_err(|error| RewriteError::io("open input", &paths.input, error))?;
    let input_bytes = input_file
        .metadata()
        .map_err(|error| RewriteError::io("inspect input", &paths.input, error))?
        .len();
    if input_bytes > limits.max_input_bytes {
        return Err(RewriteError::LimitExceeded {
            kind: LimitKind::InputBytes,
            limit: limits.max_input_bytes,
            observed: input_bytes,
        });
    }
    validate_magic(&mut input_file, &paths.input)?;
    let demo_messages = scan_demo_envelope(&mut input_file, input_bytes, limits.max_demo_messages)?;
    if demo_messages == 0 {
        return Err(RewriteError::MalformedEnvelope {
            offset: 16,
            reason: "demo contains no messages".to_owned(),
        });
    }

    let mut staging = Builder::new()
        .prefix(".vibe-cs-cosmetics-")
        .suffix(".tmp")
        .tempfile_in(&paths.output_parent)
        .map_err(|error| RewriteError::io("create staging file", &paths.output_parent, error))?;

    let backend_result;
    let output_limit_exceeded;
    {
        let mut bounded = BoundedWriter::new(staging.as_file_mut(), limits.max_output_bytes);
        backend_result = backend.rewrite(&mut input_file, &mut bounded, request, limits);
        output_limit_exceeded = bounded.limit_exceeded;
        if backend_result.is_ok() {
            bounded
                .flush()
                .map_err(|error| RewriteError::io("flush staging file", staging.path(), error))?;
        }
    }
    if output_limit_exceeded {
        let observed = staging
            .as_file()
            .metadata()
            .map_or(limits.max_output_bytes.saturating_add(1), |meta| {
                meta.len().max(limits.max_output_bytes.saturating_add(1))
            });
        return Err(RewriteError::LimitExceeded {
            kind: LimitKind::OutputBytes,
            limit: limits.max_output_bytes,
            observed,
        });
    }
    let rewrite = backend_result.map_err(map_backend_error)?;
    validate_backend_report(&rewrite, request, limits)?;
    if !rewrite
        .patches
        .iter()
        .flat_map(|patch| &patch.field_hits)
        .any(|hit| hit.hits != 0)
    {
        return Err(RewriteError::NoMatchingFields);
    }

    staging
        .as_file()
        .sync_all()
        .map_err(|error| RewriteError::io("synchronize staging file", staging.path(), error))?;
    let output_bytes = staging
        .as_file()
        .metadata()
        .map_err(|error| RewriteError::io("inspect staging file", staging.path(), error))?
        .len();
    if output_bytes > limits.max_output_bytes {
        return Err(RewriteError::LimitExceeded {
            kind: LimitKind::OutputBytes,
            limit: limits.max_output_bytes,
            observed: output_bytes,
        });
    }
    let staging_path = staging.path().to_path_buf();
    validate_magic(staging.as_file_mut(), &staging_path)?;
    let output_messages = scan_demo_envelope(
        staging.as_file_mut(),
        output_bytes,
        limits.max_demo_messages,
    )?;
    if output_messages == 0 {
        return Err(RewriteError::MalformedEnvelope {
            offset: 16,
            reason: "rewritten demo contains no messages".to_owned(),
        });
    }

    let temporary_path = staging.into_temp_path();
    match fs::hard_link(&temporary_path, &paths.output) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {
            return Err(RewriteError::OutputAlreadyExists { path: paths.output });
        }
        Err(error) => {
            return Err(RewriteError::io(
                "atomically publish output",
                &paths.output,
                error,
            ));
        }
    }
    drop(temporary_path);

    Ok(RewriteReport {
        input_path: paths.input,
        output_path: paths.output,
        input_bytes,
        output_bytes,
        demo_messages,
        rewrite,
    })
}

fn map_backend_error(error: BackendError) -> RewriteError {
    match error {
        BackendError::LimitExceeded {
            kind,
            limit,
            observed,
        } => RewriteError::LimitExceeded {
            kind,
            limit,
            observed,
        },
        other => RewriteError::Backend(other),
    }
}

fn validate_backend_report(
    report: &BackendReport,
    request: &RewriteRequest,
    limits: &RewriteLimits,
) -> Result<(), RewriteError> {
    if report.entity_updates > limits.max_entity_updates {
        return Err(RewriteError::LimitExceeded {
            kind: LimitKind::EntityUpdates,
            limit: limits.max_entity_updates,
            observed: report.entity_updates,
        });
    }
    if report.distinct_entities > limits.max_distinct_entities {
        return Err(RewriteError::LimitExceeded {
            kind: LimitKind::DistinctEntities,
            limit: limits.max_distinct_entities,
            observed: report.distinct_entities,
        });
    }
    if report.patches.len() != request.patches.len() {
        return Err(RewriteError::Backend(BackendError::Stream(
            "backend returned the wrong number of patch reports".to_owned(),
        )));
    }
    for (index, (patch_report, patch)) in report.patches.iter().zip(&request.patches).enumerate() {
        if patch_report.patch_index != index {
            return Err(RewriteError::Backend(BackendError::Stream(
                "backend returned an out-of-order patch report".to_owned(),
            )));
        }
        let expected = CosmeticField::ALL
            .into_iter()
            .filter(|field| patch.values.requested(*field))
            .collect::<BTreeSet<_>>();
        let actual = patch_report
            .field_hits
            .iter()
            .map(|hit| hit.field)
            .collect::<BTreeSet<_>>();
        if expected != actual || actual.len() != patch_report.field_hits.len() {
            return Err(RewriteError::Backend(BackendError::Stream(
                "backend field-hit report does not match requested fields".to_owned(),
            )));
        }
    }
    Ok(())
}

fn validate_magic(file: &mut File, path: &Path) -> Result<(), RewriteError> {
    let file_bytes = file
        .metadata()
        .map_err(|error| RewriteError::io("inspect demo header", path, error))?
        .len();
    if file_bytes < 16 {
        return Err(RewriteError::InvalidMagic {
            path: path.to_path_buf(),
        });
    }
    file.seek(SeekFrom::Start(0))
        .map_err(|error| RewriteError::io("seek demo header", path, error))?;
    let mut magic = [0_u8; 8];
    if file.read_exact(&mut magic).is_err() || &magic != DEMO_MAGIC {
        return Err(RewriteError::InvalidMagic {
            path: path.to_path_buf(),
        });
    }
    Ok(())
}

fn scan_demo_envelope(
    file: &mut File,
    input_bytes: u64,
    max_messages: u64,
) -> Result<u64, RewriteError> {
    file.seek(SeekFrom::Start(16))
        .map_err(|error| RewriteError::io("seek demo messages", "<input>", error))?;
    let mut messages = 0_u64;
    while file
        .stream_position()
        .map_err(|error| RewriteError::io("inspect demo position", "<input>", error))?
        < input_bytes
    {
        let _command = read_var_u32(file, input_bytes)?;
        let _tick = read_var_u32(file, input_bytes)?;
        let payload_size = u64::from(read_var_u32(file, input_bytes)?);
        let payload_start = file
            .stream_position()
            .map_err(|error| RewriteError::io("inspect demo position", "<input>", error))?;
        let payload_end = payload_start.checked_add(payload_size).ok_or_else(|| {
            RewriteError::MalformedEnvelope {
                offset: payload_start,
                reason: "payload size overflow".to_owned(),
            }
        })?;
        if payload_end > input_bytes {
            return Err(RewriteError::MalformedEnvelope {
                offset: payload_start,
                reason: format!("payload length {payload_size} exceeds the remaining input"),
            });
        }
        file.seek(SeekFrom::Start(payload_end))
            .map_err(|error| RewriteError::io("skip demo payload", "<input>", error))?;
        messages = messages.saturating_add(1);
        if messages > max_messages {
            return Err(RewriteError::LimitExceeded {
                kind: LimitKind::DemoMessages,
                limit: max_messages,
                observed: messages,
            });
        }
    }
    Ok(messages)
}

fn read_var_u32(file: &mut File, input_bytes: u64) -> Result<u32, RewriteError> {
    let start = file
        .stream_position()
        .map_err(|error| RewriteError::io("inspect demo position", "<input>", error))?;
    let mut value = 0_u32;
    for shift in (0..=28).step_by(7) {
        let position = file
            .stream_position()
            .map_err(|error| RewriteError::io("inspect demo position", "<input>", error))?;
        if position >= input_bytes {
            return Err(RewriteError::MalformedEnvelope {
                offset: start,
                reason: "truncated varint".to_owned(),
            });
        }
        let mut byte = [0_u8; 1];
        file.read_exact(&mut byte)
            .map_err(|error| RewriteError::io("read demo varint", "<input>", error))?;
        if shift == 28 && byte[0] & 0xf0 != 0 {
            return Err(RewriteError::MalformedEnvelope {
                offset: start,
                reason: "u32 varint overflow".to_owned(),
            });
        }
        value |= u32::from(byte[0] & 0x7f) << shift;
        if byte[0] & 0x80 == 0 {
            return Ok(value);
        }
    }
    Err(RewriteError::MalformedEnvelope {
        offset: start,
        reason: "unterminated u32 varint".to_owned(),
    })
}

#[derive(Debug)]
struct ResolvedPaths {
    input: PathBuf,
    output: PathBuf,
    output_parent: PathBuf,
}

impl ResolvedPaths {
    fn new(input: &Path, output: &Path) -> Result<Self, RewriteError> {
        validate_absolute_demo_path(input, "input")?;
        validate_absolute_demo_path(output, "output")?;
        let input = fs::canonicalize(input)
            .map_err(|error| RewriteError::io("resolve input", input, error))?;
        if !input
            .metadata()
            .map_err(|error| RewriteError::io("inspect input", &input, error))?
            .is_file()
        {
            return Err(RewriteError::invalid("input must be a regular file"));
        }
        let output_parent = output.parent().ok_or_else(|| {
            RewriteError::invalid("output must have an existing parent directory")
        })?;
        let output_parent = fs::canonicalize(output_parent)
            .map_err(|error| RewriteError::io("resolve output parent", output_parent, error))?;
        let file_name = output
            .file_name()
            .ok_or_else(|| RewriteError::invalid("output must include a file name"))?;
        let output = output_parent.join(file_name);
        if input == output {
            return Err(RewriteError::SameInputAndOutput { path: input });
        }
        if output
            .try_exists()
            .map_err(|error| RewriteError::io("inspect output", &output, error))?
        {
            return Err(RewriteError::OutputAlreadyExists { path: output });
        }
        Ok(Self {
            input,
            output,
            output_parent,
        })
    }
}

fn validate_absolute_demo_path(path: &Path, role: &'static str) -> Result<(), RewriteError> {
    if !path.is_absolute() {
        return Err(RewriteError::PathNotAbsolute {
            role,
            path: path.to_path_buf(),
        });
    }
    if !path
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("dem"))
    {
        return Err(RewriteError::InvalidExtension {
            role,
            path: path.to_path_buf(),
        });
    }
    Ok(())
}

#[derive(Debug)]
struct BoundedWriter<'a> {
    inner: &'a mut File,
    max_bytes: u64,
    position: u64,
    limit_exceeded: bool,
}

impl<'a> BoundedWriter<'a> {
    fn new(inner: &'a mut File, max_bytes: u64) -> Self {
        Self {
            inner,
            max_bytes,
            position: 0,
            limit_exceeded: false,
        }
    }

    fn limit_error(&mut self) -> io::Error {
        self.limit_exceeded = true;
        io::Error::other("bounded demo output limit exceeded")
    }
}

impl Write for BoundedWriter<'_> {
    fn write(&mut self, buffer: &[u8]) -> io::Result<usize> {
        let requested_end = self
            .position
            .checked_add(buffer.len() as u64)
            .ok_or_else(|| self.limit_error())?;
        if requested_end > self.max_bytes {
            return Err(self.limit_error());
        }
        let written = self.inner.write(buffer)?;
        self.position = self.position.saturating_add(written as u64);
        Ok(written)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

impl Seek for BoundedWriter<'_> {
    fn seek(&mut self, position: SeekFrom) -> io::Result<u64> {
        let next = self.inner.seek(position)?;
        if next > self.max_bytes {
            return Err(self.limit_error());
        }
        self.position = next;
        Ok(next)
    }
}
