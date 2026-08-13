use vibe_cs_platform_windows::{
    HLAE_STAGING_MAXIMUM_BYTES, HLAE_STAGING_MINIMUM_SAFETY_RESERVE_BYTES,
    HlaeDiskSpacePreflightError, assess_hlae_staging_disk_space, preflight_hlae_staging_disk_space,
    recommended_hlae_staging_safety_reserve,
};

const GIBIBYTE: u64 = 1_024 * 1_024 * 1_024;

#[test]
fn recommended_reserve_keeps_one_gibibyte_or_ten_percent_whichever_is_larger() {
    assert_eq!(
        recommended_hlae_staging_safety_reserve(512 * 1_024 * 1_024)
            .expect("bounded staging estimate"),
        HLAE_STAGING_MINIMUM_SAFETY_RESERVE_BYTES
    );
    assert_eq!(
        recommended_hlae_staging_safety_reserve(20 * GIBIBYTE).expect("bounded staging estimate"),
        2 * GIBIBYTE
    );
    assert_eq!(
        recommended_hlae_staging_safety_reserve(10 * GIBIBYTE + 1)
            .expect("bounded staging estimate"),
        GIBIBYTE + 1
    );
}

#[test]
fn assessment_fails_closed_when_available_bytes_do_not_cover_staging_and_reserve() {
    let staging_bytes = 2 * GIBIBYTE;
    let required_bytes = 3 * GIBIBYTE;

    let error = assess_hlae_staging_disk_space(required_bytes - 1, staging_bytes)
        .expect_err("one missing byte must reject capture");

    assert!(matches!(
        error,
        HlaeDiskSpacePreflightError::Insufficient {
            available_bytes,
            required_bytes: actual_required,
        } if available_bytes == required_bytes - 1 && actual_required == required_bytes
    ));
}

#[test]
fn assessment_returns_auditable_evidence_at_the_exact_required_boundary() {
    let staging_bytes = 2 * GIBIBYTE;
    let required_bytes = 3 * GIBIBYTE;

    let evidence = assess_hlae_staging_disk_space(required_bytes, staging_bytes)
        .expect("the exact staging and reserve requirement is sufficient");

    assert_eq!(evidence.available_bytes, required_bytes);
    assert_eq!(evidence.required_bytes, required_bytes);
    assert_eq!(evidence.staging_bytes, staging_bytes);
    assert_eq!(evidence.safety_reserve_bytes, GIBIBYTE);
}

#[test]
fn staging_estimates_must_be_nonzero_and_within_the_reviewed_capture_ceiling() {
    for staging_bytes in [0, HLAE_STAGING_MAXIMUM_BYTES + 1] {
        assert!(matches!(
            assess_hlae_staging_disk_space(u64::MAX, staging_bytes),
            Err(HlaeDiskSpacePreflightError::InvalidRequest(_))
        ));
    }
}

#[test]
fn volume_probe_rejects_a_relative_directory_before_querying_the_filesystem() {
    assert!(matches!(
        preflight_hlae_staging_disk_space(std::path::Path::new("relative/staging"), 1),
        Err(HlaeDiskSpacePreflightError::InvalidRequest(message))
            if message.contains("absolute")
    ));
}

#[test]
fn volume_probe_requires_an_existing_directory_instead_of_a_file_or_future_path() {
    let temporary = tempfile::tempdir().expect("temporary volume fixture");
    let file = temporary.path().join("capture.tmp");
    std::fs::write(&file, b"fixture").expect("temporary file");

    assert!(matches!(
        preflight_hlae_staging_disk_space(&file, 1),
        Err(HlaeDiskSpacePreflightError::InvalidRequest(message))
            if message.contains("directory")
    ));
    assert!(matches!(
        preflight_hlae_staging_disk_space(&temporary.path().join("not-created"), 1),
        Err(HlaeDiskSpacePreflightError::DirectoryUnavailable { .. })
    ));
}

#[test]
#[ignore = "queries the live free-space state of the local temporary volume"]
fn live_volume_probe_reports_truthful_evidence_without_allocating_a_reservation() {
    let temporary = tempfile::tempdir().expect("temporary volume fixture");
    let expected_required = HLAE_STAGING_MINIMUM_SAFETY_RESERVE_BYTES + 1;

    match preflight_hlae_staging_disk_space(temporary.path(), 1) {
        Ok(evidence) => {
            assert!(evidence.available_bytes >= evidence.required_bytes);
            assert_eq!(evidence.required_bytes, expected_required);
            assert_eq!(evidence.staging_bytes, 1);
        }
        Err(HlaeDiskSpacePreflightError::Insufficient {
            available_bytes,
            required_bytes,
        }) => {
            assert!(available_bytes < required_bytes);
            assert_eq!(required_bytes, expected_required);
        }
        Err(error) => panic!("local volume query failed unexpectedly: {error}"),
    }

    assert_eq!(
        std::fs::read_dir(temporary.path())
            .expect("read temporary directory")
            .count(),
        0,
        "preflight must not create a fake allocation or reservation"
    );
}
