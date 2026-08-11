use std::fs;
use std::io::{self, SeekFrom};

use source2_demo::proto::{CDemoFileInfo, EDemoCommands, Message};
use source2_demo::writer::write_demo_message;
use tempfile::TempDir;
use vibe_cs_cosmetics::{
    BackendError, BackendReport, CosmeticField, CosmeticPatch, CosmeticTarget, CosmeticValues,
    DemoRewriteBackend, FieldHit, LimitKind, PatchRewriteReport, ReadSeek, RewriteError,
    RewriteLimits, RewriteRequest, StablePlayerIdentity, WriteSeek, rewrite_demo,
    rewrite_demo_with_backend,
};

const STEAM_ID_BASE: u64 = 76_561_197_960_265_728;

#[derive(Debug, Clone, Copy)]
enum FixtureMode {
    Success,
    NoHits,
    FailAfterWrite,
}

#[derive(Debug)]
struct FixtureBackend {
    mode: FixtureMode,
}

#[derive(Debug)]
struct ExcessEntities;

impl DemoRewriteBackend for ExcessEntities {
    fn rewrite(
        &self,
        input: &mut dyn ReadSeek,
        output: &mut dyn WriteSeek,
        request: &RewriteRequest,
        _limits: &RewriteLimits,
    ) -> Result<BackendReport, BackendError> {
        input.seek(SeekFrom::Start(0)).unwrap();
        io::copy(input, output).unwrap();
        let mut report = report_for(request, 1);
        report.distinct_entities = 2;
        Ok(report)
    }
}

impl DemoRewriteBackend for FixtureBackend {
    fn rewrite(
        &self,
        input: &mut dyn ReadSeek,
        output: &mut dyn WriteSeek,
        request: &RewriteRequest,
        _limits: &RewriteLimits,
    ) -> Result<BackendReport, BackendError> {
        input
            .seek(SeekFrom::Start(0))
            .map_err(|error| BackendError::Io(error.to_string()))?;
        io::copy(input, output).map_err(|error| BackendError::Io(error.to_string()))?;
        if matches!(self.mode, FixtureMode::FailAfterWrite) {
            return Err(BackendError::Stream("synthetic failure".to_owned()));
        }
        Ok(report_for(
            request,
            u64::from(matches!(self.mode, FixtureMode::Success)),
        ))
    }
}

fn report_for(request: &RewriteRequest, hits: u64) -> BackendReport {
    BackendReport {
        entity_updates: 1,
        distinct_entities: 1,
        patches: request
            .patches
            .iter()
            .enumerate()
            .map(|(patch_index, patch)| PatchRewriteReport {
                patch_index,
                matched_entities: 1,
                field_hits: CosmeticField::ALL
                    .into_iter()
                    .filter(|field| match field {
                        CosmeticField::PaintKit => patch.values.paint_kit.is_some(),
                        CosmeticField::Seed => patch.values.seed.is_some(),
                        CosmeticField::Wear => patch.values.wear.is_some(),
                        CosmeticField::StatTrak => patch.values.stat_trak.is_some(),
                    })
                    .map(|field| FieldHit { field, hits })
                    .collect(),
                incompatible_type_occurrences: 0,
            })
            .collect(),
    }
}

fn request() -> RewriteRequest {
    let account_id = 777;
    RewriteRequest {
        patches: vec![CosmeticPatch {
            target: CosmeticTarget {
                owner: StablePlayerIdentity::new(STEAM_ID_BASE + u64::from(account_id), account_id)
                    .unwrap(),
                item_definition_index: Some(7),
            },
            values: CosmeticValues {
                paint_kit: Some(711),
                ..CosmeticValues::default()
            },
        }],
    }
}

fn synthetic_demo(extra_messages: usize) -> Vec<u8> {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(b"PBDEMS2\0");
    bytes.extend_from_slice(&16_u32.to_le_bytes());
    bytes.extend_from_slice(&[0_u8; 4]);
    let playback_ticks = i32::try_from(extra_messages).unwrap();
    let file_info = CDemoFileInfo {
        playback_ticks: Some(playback_ticks),
        ..CDemoFileInfo::default()
    };
    write_demo_message(
        &mut bytes,
        EDemoCommands::DemFileInfo,
        0,
        &file_info.encode_to_vec(),
    )
    .unwrap();
    for tick in 0..extra_messages {
        write_demo_message(
            &mut bytes,
            EDemoCommands::DemSyncTick,
            u32::try_from(tick).unwrap(),
            &[],
        )
        .unwrap();
    }
    write_demo_message(
        &mut bytes,
        EDemoCommands::DemStop,
        u32::try_from(extra_messages).unwrap(),
        &[],
    )
    .unwrap();
    bytes
}

fn fixture_paths(temp: &TempDir) -> (std::path::PathBuf, std::path::PathBuf) {
    (
        temp.path().join("input.dem"),
        temp.path().join("output.dem"),
    )
}

fn staging_files(temp: &TempDir) -> Vec<String> {
    fs::read_dir(temp.path())
        .unwrap()
        .filter_map(Result::ok)
        .filter_map(|entry| entry.file_name().into_string().ok())
        .filter(|name| {
            name.starts_with(".vibe-cs-cosmetics-")
                && std::path::Path::new(name)
                    .extension()
                    .is_some_and(|extension| extension.eq_ignore_ascii_case("tmp"))
        })
        .collect()
}

#[test]
fn successful_rewrite_is_synchronized_and_atomically_published() {
    let temp = TempDir::new().unwrap();
    let (input, output) = fixture_paths(&temp);
    let source = synthetic_demo(2);
    fs::write(&input, &source).unwrap();

    let report = rewrite_demo_with_backend(
        &input,
        &output,
        &request(),
        &RewriteLimits::default(),
        &FixtureBackend {
            mode: FixtureMode::Success,
        },
    )
    .unwrap();

    assert_eq!(fs::read(&output).unwrap(), source);
    assert_eq!(report.output_path, fs::canonicalize(&output).unwrap());
    assert_eq!(report.demo_messages, 4);
    assert_eq!(report.rewrite.total_hits(), 1);
    assert!(staging_files(&temp).is_empty());
}

#[test]
fn zero_hits_is_a_failure_and_leaves_no_final_or_staging_file() {
    let temp = TempDir::new().unwrap();
    let (input, output) = fixture_paths(&temp);
    fs::write(&input, synthetic_demo(0)).unwrap();

    let error = rewrite_demo_with_backend(
        &input,
        &output,
        &request(),
        &RewriteLimits::default(),
        &FixtureBackend {
            mode: FixtureMode::NoHits,
        },
    )
    .unwrap_err();

    assert!(matches!(error, RewriteError::NoMatchingFields));
    assert!(!output.exists());
    assert!(staging_files(&temp).is_empty());
}

#[test]
fn backend_failure_after_writing_never_publishes_partial_output() {
    let temp = TempDir::new().unwrap();
    let (input, output) = fixture_paths(&temp);
    fs::write(&input, synthetic_demo(0)).unwrap();

    let error = rewrite_demo_with_backend(
        &input,
        &output,
        &request(),
        &RewriteLimits::default(),
        &FixtureBackend {
            mode: FixtureMode::FailAfterWrite,
        },
    )
    .unwrap_err();

    assert!(matches!(error, RewriteError::Backend(_)));
    assert!(!output.exists());
    assert!(staging_files(&temp).is_empty());
}

#[test]
fn input_output_message_and_backend_entity_limits_are_enforced() {
    let temp = TempDir::new().unwrap();
    let (input, output) = fixture_paths(&temp);
    let source = synthetic_demo(2);
    fs::write(&input, &source).unwrap();

    let input_limits = RewriteLimits {
        max_input_bytes: u64::try_from(source.len()).unwrap() - 1,
        ..RewriteLimits::default()
    };
    let input_error = rewrite_demo_with_backend(
        &input,
        &output,
        &request(),
        &input_limits,
        &FixtureBackend {
            mode: FixtureMode::Success,
        },
    )
    .unwrap_err();
    assert!(matches!(
        input_error,
        RewriteError::LimitExceeded {
            kind: LimitKind::InputBytes,
            ..
        }
    ));

    let message_limits = RewriteLimits {
        max_demo_messages: 2,
        ..RewriteLimits::default()
    };
    let message_error = rewrite_demo_with_backend(
        &input,
        &output,
        &request(),
        &message_limits,
        &FixtureBackend {
            mode: FixtureMode::Success,
        },
    )
    .unwrap_err();
    assert!(matches!(
        message_error,
        RewriteError::LimitExceeded {
            kind: LimitKind::DemoMessages,
            ..
        }
    ));

    let entity_limits = RewriteLimits {
        max_distinct_entities: 1,
        ..RewriteLimits::default()
    };
    let entity_error =
        rewrite_demo_with_backend(&input, &output, &request(), &entity_limits, &ExcessEntities)
            .unwrap_err();
    assert!(matches!(
        entity_error,
        RewriteError::LimitExceeded {
            kind: LimitKind::DistinctEntities,
            ..
        }
    ));
    assert!(!output.exists());
}

#[test]
fn bounded_output_refuses_oversized_backend_writes() {
    let temp = TempDir::new().unwrap();
    let (input, output) = fixture_paths(&temp);
    let source = synthetic_demo(20);
    fs::write(&input, source).unwrap();
    let limits = RewriteLimits {
        max_output_bytes: 32,
        ..RewriteLimits::default()
    };

    let error = rewrite_demo_with_backend(
        &input,
        &output,
        &request(),
        &limits,
        &FixtureBackend {
            mode: FixtureMode::Success,
        },
    )
    .unwrap_err();

    assert!(matches!(
        error,
        RewriteError::LimitExceeded {
            kind: LimitKind::OutputBytes,
            ..
        }
    ));
    assert!(!output.exists());
    assert!(staging_files(&temp).is_empty());
}

#[test]
fn malformed_magic_and_envelope_are_rejected_before_staging() {
    let temp = TempDir::new().unwrap();
    let (input, output) = fixture_paths(&temp);
    fs::write(&input, b"NOTDEMO!12345678").unwrap();
    let magic_error = rewrite_demo_with_backend(
        &input,
        &output,
        &request(),
        &RewriteLimits::default(),
        &FixtureBackend {
            mode: FixtureMode::Success,
        },
    )
    .unwrap_err();
    assert!(matches!(magic_error, RewriteError::InvalidMagic { .. }));

    let mut truncated = synthetic_demo(0);
    truncated.push(0x80);
    fs::write(&input, truncated).unwrap();
    let envelope_error = rewrite_demo_with_backend(
        &input,
        &output,
        &request(),
        &RewriteLimits::default(),
        &FixtureBackend {
            mode: FixtureMode::Success,
        },
    )
    .unwrap_err();
    assert!(matches!(
        envelope_error,
        RewriteError::MalformedEnvelope { .. }
    ));
    assert!(staging_files(&temp).is_empty());
}

#[test]
fn existing_output_is_never_overwritten() {
    let temp = TempDir::new().unwrap();
    let (input, output) = fixture_paths(&temp);
    fs::write(&input, synthetic_demo(0)).unwrap();
    fs::write(&output, b"keep me").unwrap();

    let error = rewrite_demo_with_backend(
        &input,
        &output,
        &request(),
        &RewriteLimits::default(),
        &FixtureBackend {
            mode: FixtureMode::Success,
        },
    )
    .unwrap_err();

    assert!(matches!(error, RewriteError::OutputAlreadyExists { .. }));
    assert_eq!(fs::read(&output).unwrap(), b"keep me");
}

#[test]
fn production_writer_returns_no_match_instead_of_claiming_success() {
    let temp = TempDir::new().unwrap();
    let (input, output) = fixture_paths(&temp);
    fs::write(&input, synthetic_demo(0)).unwrap();

    let error = rewrite_demo(&input, &output, &request(), &RewriteLimits::default()).unwrap_err();

    assert!(matches!(error, RewriteError::NoMatchingFields));
    assert!(!output.exists());
    assert!(staging_files(&temp).is_empty());
}

#[test]
fn injected_backend_cannot_forge_unrequested_field_hits() {
    #[derive(Debug)]
    struct ForgedReport;
    impl DemoRewriteBackend for ForgedReport {
        fn rewrite(
            &self,
            input: &mut dyn ReadSeek,
            output: &mut dyn WriteSeek,
            request: &RewriteRequest,
            _limits: &RewriteLimits,
        ) -> Result<BackendReport, BackendError> {
            input.seek(SeekFrom::Start(0)).unwrap();
            let mut bytes = Vec::new();
            input.read_to_end(&mut bytes).unwrap();
            output.write_all(&bytes).unwrap();
            let mut report = report_for(request, 1);
            report.patches[0].field_hits.push(FieldHit {
                field: CosmeticField::Wear,
                hits: 1,
            });
            Ok(report)
        }
    }
    let temp = TempDir::new().unwrap();
    let (input, output) = fixture_paths(&temp);
    fs::write(&input, synthetic_demo(0)).unwrap();

    let error = rewrite_demo_with_backend(
        &input,
        &output,
        &request(),
        &RewriteLimits::default(),
        &ForgedReport,
    )
    .unwrap_err();

    assert!(matches!(error, RewriteError::Backend(_)));
    assert!(!output.exists());
}
