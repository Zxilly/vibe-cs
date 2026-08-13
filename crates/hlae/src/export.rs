use std::{
    collections::{BTreeMap, BTreeSet},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
};

use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};
use sha2::{Digest as _, Sha256};

use crate::validate::validate_safe_path;
use crate::{
    ExportedHlaePlan, GeneratedArtifact, HLAE_BUNDLE_LAUNCH_PROFILE_FILE,
    HLAE_BUNDLE_MANIFEST_FILE, HLAE_BUNDLE_MANIFEST_PRODUCER, HLAE_BUNDLE_README_FILE,
    HlaeBundleArtifactManifest, HlaeBundleLaunchHandoff, HlaeBundleLaunchInputs,
    HlaeBundleManifest, HlaeError, HlaePlan, build_hlae_launch_profile, compile_hlae_plan,
};

/// Exports a validated plan below an application-managed directory.
///
/// The managed root is opened as a directory capability. The bundle name is a
/// restricted direct child, reserving that child uses no-clobber directory
/// creation, and every fixed planner-owned file uses `create_new`. A completion
/// marker is synchronized last and is the only signal that a consumer may use
/// the bundle. Existing or incomplete bundle names are never replaced.
///
/// This is intentionally a recoverable transaction rather than an atomic
/// directory publication: a storage failure can leave a clearly incomplete
/// directory without a completion marker. No generated file is executed.
///
/// # Errors
///
/// Returns [`HlaeError`] for an invalid plan, unsafe managed path or bundle
/// name, existing destination, or file-system failure.
pub fn export_hlae_plan(
    plan: &HlaePlan,
    managed_root: &Path,
    bundle_name: &str,
    launch_inputs: &HlaeBundleLaunchInputs,
) -> Result<ExportedHlaePlan, HlaeError> {
    validate_safe_path(managed_root, "managedRoot", true)?;
    validate_bundle_name(bundle_name)?;
    if plan.capture.width != launch_inputs.resolution.width
        || plan.capture.height != launch_inputs.resolution.height
    {
        return Err(HlaeError::InvalidPlan(
            "capture dimensions must match the managed CS2 launch resolution".to_owned(),
        ));
    }
    let destination = managed_root.join(bundle_name);
    let compiled = compile_hlae_plan(plan, &destination)?;
    let handoff = compile_handoff(plan, &destination, launch_inputs)?;
    let artifacts = std::iter::once(&compiled.bootstrap_config)
        .chain(std::iter::once(&compiled.command_system))
        .chain(compiled.camera_paths.iter())
        .chain(handoff.iter())
        .collect::<Vec<_>>();
    let manifest = HlaeBundleManifest {
        state: "complete".to_owned(),
        producer: HLAE_BUNDLE_MANIFEST_PRODUCER.to_owned(),
        artifacts: artifacts
            .iter()
            .map(|artifact| artifact_manifest(artifact, &destination))
            .collect::<Result<Vec<_>, _>>()?,
    };
    let manifest_contents =
        serde_json::to_string_pretty(&manifest).map_err(|error| HlaeError::ArtifactIo {
            operation: "serialize HLAE bundle manifest",
            message: error.to_string(),
        })? + "\n";
    let root = Dir::open_ambient_dir(managed_root, ambient_authority())
        .map_err(|error| io_error("open managed HLAE directory", &error))?;
    let resuming = match root.create_dir(bundle_name) {
        Ok(()) => false,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => true,
        Err(error) => return Err(io_error("reserve HLAE artifact bundle", &error)),
    };
    let directory_metadata = root
        .symlink_metadata(bundle_name)
        .map_err(|error| io_error("inspect reserved HLAE artifact bundle", &error))?;
    if !directory_metadata.is_dir() || directory_metadata.file_type().is_symlink() {
        return Err(bundle_conflict(
            &destination,
            "existing bundle is not a regular direct-child directory",
        ));
    }
    let bundle = root
        .open_dir(bundle_name)
        .map_err(|error| io_error("open reserved HLAE artifact bundle", &error))?;
    if resuming {
        validate_resumable_bundle(&bundle, &destination, &artifacts, false)?;
    }
    let mut files = write_bundle_files(&bundle, &artifacts, &destination, resuming)?;
    validate_resumable_bundle(&bundle, &destination, &artifacts, true)?;
    write_manifest_file(
        &bundle,
        Path::new(HLAE_BUNDLE_MANIFEST_FILE),
        &manifest_contents,
        &destination,
    )?;
    let completion_marker = destination.join(HLAE_BUNDLE_MANIFEST_FILE);
    files.push(completion_marker.clone());

    Ok(ExportedHlaePlan {
        directory: destination,
        files,
        completion_marker,
        compiled,
    })
}

fn validate_bundle_name(value: &str) -> Result<(), HlaeError> {
    if value.is_empty()
        || value.len() > 80
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        return Err(HlaeError::UnsafePath {
            field: "bundleName",
            reason: "use 1-80 ASCII letters, digits, '-' or '_'",
        });
    }
    Ok(())
}

fn write_bundle_files(
    bundle: &Dir,
    artifacts: &[&GeneratedArtifact],
    destination: &Path,
    resuming: bool,
) -> Result<Vec<PathBuf>, HlaeError> {
    let mut files = Vec::new();
    for artifact in artifacts {
        let relative = safe_artifact_relative_path(artifact, destination)?;
        let missing = if resuming {
            match bundle.symlink_metadata(relative) {
                Ok(_) => false,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => true,
                Err(error) => {
                    return Err(io_error("inspect resumable HLAE artifact", &error));
                }
            }
        } else {
            true
        };
        if missing {
            write_new_file(bundle, relative, &artifact.contents).map_err(|error| match error {
                HlaeError::ArtifactIo { .. } if resuming => {
                    HlaeError::ArtifactBundleExists(destination.to_path_buf())
                }
                other => other,
            })?;
        }
        files.push(artifact.path.clone());
    }
    Ok(files)
}

fn artifact_manifest(
    artifact: &GeneratedArtifact,
    destination: &Path,
) -> Result<HlaeBundleArtifactManifest, HlaeError> {
    let relative = safe_artifact_relative_path(artifact, destination)?;
    Ok(HlaeBundleArtifactManifest {
        path: relative.to_string_lossy().into_owned(),
        size: u64::try_from(artifact.contents.len()).map_err(|error| HlaeError::ArtifactIo {
            operation: "measure HLAE artifact",
            message: error.to_string(),
        })?,
        sha256: hex::encode(Sha256::digest(artifact.contents.as_bytes())),
    })
}

fn validate_resumable_bundle(
    bundle: &Dir,
    destination: &Path,
    artifacts: &[&GeneratedArtifact],
    require_all: bool,
) -> Result<(), HlaeError> {
    match bundle.symlink_metadata(HLAE_BUNDLE_MANIFEST_FILE) {
        Ok(_) => return Err(HlaeError::ArtifactBundleExists(destination.to_path_buf())),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(io_error("inspect HLAE bundle manifest", &error)),
    }

    let mut expected = BTreeMap::new();
    for artifact in artifacts {
        let name = artifact
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| bundle_conflict(destination, "expected artifact name is invalid"))?;
        if expected.insert(name, *artifact).is_some() {
            return Err(bundle_conflict(
                destination,
                "expected artifact allowlist contains a duplicate",
            ));
        }
    }

    let mut seen = BTreeSet::new();
    let entries = bundle
        .entries()
        .map_err(|error| io_error("enumerate resumable HLAE bundle", &error))?;
    for entry in entries {
        let entry = entry.map_err(|error| io_error("inspect resumable HLAE artifact", &error))?;
        let name = entry
            .file_name()
            .into_string()
            .map_err(|_| bundle_conflict(destination, "bundle contains a non-Unicode file"))?;
        if name == HLAE_BUNDLE_MANIFEST_FILE {
            return Err(HlaeError::ArtifactBundleExists(destination.to_path_buf()));
        }
        let Some(artifact) = expected.get(name.as_str()) else {
            return Err(bundle_conflict(
                destination,
                "bundle contains an unknown file outside the fixed allowlist",
            ));
        };
        let metadata = bundle
            .symlink_metadata(&name)
            .map_err(|error| io_error("inspect resumable HLAE artifact metadata", &error))?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return Err(bundle_conflict(
                destination,
                "bundle contains a non-regular or linked artifact",
            ));
        }
        let expected_size =
            u64::try_from(artifact.contents.len()).map_err(|error| HlaeError::ArtifactIo {
                operation: "measure resumable HLAE artifact",
                message: error.to_string(),
            })?;
        if metadata.len() != expected_size {
            return Err(bundle_conflict(
                destination,
                "existing artifact size differs from the confirmed plan",
            ));
        }
        let maximum_bytes = artifact.contents.len().checked_add(1).ok_or_else(|| {
            bundle_conflict(destination, "resumable artifact size limit overflow")
        })?;
        let mut contents = Vec::with_capacity(artifact.contents.len());
        bundle
            .open(&name)
            .map_err(|error| io_error("open resumable HLAE artifact", &error))?
            .take(
                u64::try_from(maximum_bytes).map_err(|error| HlaeError::ArtifactIo {
                    operation: "bound resumable HLAE artifact read",
                    message: error.to_string(),
                })?,
            )
            .read_to_end(&mut contents)
            .map_err(|error| io_error("read resumable HLAE artifact", &error))?;
        let actual_hash = Sha256::digest(&contents);
        let expected_hash = Sha256::digest(artifact.contents.as_bytes());
        if contents.len() != artifact.contents.len() || actual_hash != expected_hash {
            return Err(bundle_conflict(
                destination,
                "existing artifact hash differs from the confirmed plan",
            ));
        }
        seen.insert(name);
    }
    if require_all && seen.len() != expected.len() {
        return Err(bundle_conflict(
            destination,
            "bundle is still missing a required artifact",
        ));
    }
    Ok(())
}

fn bundle_conflict(path: &Path, reason: &str) -> HlaeError {
    HlaeError::ArtifactBundleConflict {
        path: path.to_path_buf(),
        reason: reason.to_owned(),
    }
}

fn write_manifest_file(
    bundle: &Dir,
    relative: &Path,
    contents: &str,
    destination: &Path,
) -> Result<(), HlaeError> {
    write_new_file(bundle, relative, contents).map_err(|error| match error {
        HlaeError::ArtifactIo { .. } => HlaeError::ArtifactBundleExists(destination.to_path_buf()),
        other => other,
    })
}

fn compile_handoff(
    plan: &HlaePlan,
    destination: &Path,
    inputs: &HlaeBundleLaunchInputs,
) -> Result<[GeneratedArtifact; 2], HlaeError> {
    let profile = build_hlae_launch_profile(
        &inputs.installation,
        &inputs.game_executable,
        &inputs.steam_executable,
        destination,
        inputs.resolution,
    )?;
    let instructions = vec![
        "Review README.txt, the completion manifest, and every generated artifact before use."
            .to_owned(),
        "Enter the typed launch-profile paths, arguments, and environment values as separate fields in the official HLAE custom loader; never use a shell."
            .to_owned(),
        "Launch only an offline demo session with -insecure; VAC-protected servers are prohibited."
            .to_owned(),
        "Open the target demo, then enter the reviewed vibe_cs_hlae.cfg lines in the CS2 console in their listed order."
            .to_owned(),
    ];
    let handoff = HlaeBundleLaunchHandoff {
        launch_profile: profile,
        demo_path: plan.demo_path.clone(),
        bootstrap_config: "vibe_cs_hlae.cfg".to_owned(),
        instructions,
    };
    let launch_profile =
        serde_json::to_string_pretty(&handoff).map_err(|error| HlaeError::ArtifactIo {
            operation: "serialize HLAE launch handoff",
            message: error.to_string(),
        })? + "\n";
    let readme = format!(
        "Vibe CS — HLAE offline demo handoff\n\nSAFETY BOUNDARY\n- Offline demo playback only.\n- -insecure is mandatory.\n- VAC-protected servers are prohibited.\n- Vibe CS does not launch HLAE, CS2, a shell, or console commands.\n\nTARGETS\n- HLAE: {}\n- Source 2 hook: {}\n- CS2: {}\n- Demo: {}\n- Bootstrap: {}\n- Typed profile: {}\n\nSTEPS\n1. Review {} and all files covered by it.\n2. Open the official HLAE custom loader. Copy each path, argument, and environment value from {} into its matching field. Keep -insecure enabled.\n3. Start CS2 only for offline demo playback; do not connect to a VAC-protected server.\n4. Open the target demo, then enter the reviewed lines from {} in the CS2 console in their listed order.\n5. Preview mode draws the camera path; capture mode writes the configured lossless image sequence and optional WAV.\n",
        handoff.launch_profile.hlae_executable.display(),
        handoff.launch_profile.hook_library.display(),
        handoff.launch_profile.game_executable.display(),
        handoff.demo_path.display(),
        handoff.bootstrap_config,
        HLAE_BUNDLE_LAUNCH_PROFILE_FILE,
        HLAE_BUNDLE_MANIFEST_FILE,
        HLAE_BUNDLE_LAUNCH_PROFILE_FILE,
        handoff.bootstrap_config,
    );
    let handoff_bytes = readme
        .len()
        .checked_add(launch_profile.len())
        .ok_or_else(|| HlaeError::InvalidPlan("HLAE handoff size overflow".to_owned()))?;
    if handoff_bytes > 256 * 1024 {
        return Err(HlaeError::InvalidPlan(
            "HLAE handoff exceeds the 256 KiB limit".to_owned(),
        ));
    }
    Ok([
        GeneratedArtifact {
            path: destination.join(HLAE_BUNDLE_README_FILE),
            media_type: "text/plain".to_owned(),
            contents: readme,
        },
        GeneratedArtifact {
            path: destination.join(HLAE_BUNDLE_LAUNCH_PROFILE_FILE),
            media_type: "application/json".to_owned(),
            contents: launch_profile,
        },
    ])
}

fn write_new_file(bundle: &Dir, relative: &Path, contents: &str) -> Result<(), HlaeError> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    let mut file = bundle
        .open_with(relative, &options)
        .map_err(|error| io_error("create HLAE artifact", &error))?;
    file.write_all(contents.as_bytes())
        .and_then(|()| file.sync_all())
        .map_err(|error| io_error("write HLAE artifact", &error))
}

fn safe_artifact_relative_path<'a>(
    artifact: &'a GeneratedArtifact,
    destination: &Path,
) -> Result<&'a Path, HlaeError> {
    let relative = artifact
        .path
        .strip_prefix(destination)
        .map_err(|_| HlaeError::UnsafePath {
            field: "artifactPath",
            reason: "artifact escaped its bundle directory",
        })?;
    let mut components = relative.components();
    let is_one_normal_component =
        matches!(components.next(), Some(Component::Normal(_))) && components.next().is_none();
    if !is_one_normal_component {
        return Err(HlaeError::UnsafePath {
            field: "artifactPath",
            reason: "artifact must be a direct child of its bundle directory",
        });
    }
    Ok(relative)
}

fn io_error(operation: &'static str, error: &std::io::Error) -> HlaeError {
    HlaeError::ArtifactIo {
        operation,
        message: error.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use std::{
        fs,
        sync::{Arc, Barrier},
    };

    use crate::{
        CameraKeyframe, CameraPosition, CameraRotation, CameraShot, CaptureSettings,
        HlaeBundleLaunchHandoff, HlaeDiscoverySource, HlaeInstallation, HlaePlanMode,
        LaunchResolution, PositionInterpolation, RotationInterpolation,
    };

    use super::*;

    fn plan(output: PathBuf) -> HlaePlan {
        HlaePlan {
            mode: HlaePlanMode::Preview,
            tick_rate: 64.0,
            demo_path: PathBuf::from("match.dem"),
            output_directory: output,
            pre_roll_ticks: 128,
            capture: CaptureSettings::default(),
            shots: vec![CameraShot {
                id: "shot_1".to_owned(),
                start_tick: 1_000,
                end_tick: 1_300,
                position_interpolation: PositionInterpolation::Cubic,
                rotation_interpolation: RotationInterpolation::SphericalCubic,
                keyframes: [1_000, 1_100, 1_200, 1_300]
                    .into_iter()
                    .map(|tick| CameraKeyframe {
                        tick,
                        position: CameraPosition {
                            x: 1.0,
                            y: 2.0,
                            z: 3.0,
                        },
                        rotation: CameraRotation {
                            pitch: 4.0,
                            yaw: 5.0,
                            roll: 6.0,
                        },
                        fov: 90.0,
                    })
                    .collect(),
            }],
        }
    }

    fn launch_inputs(root: &Path) -> HlaeBundleLaunchInputs {
        let installation_root = root.join("HLAE");
        let executable = installation_root.join("HLAE.exe");
        let source2_hook = installation_root.join("x64/AfxHookSource2.dll");
        let game_executable = root.join("game/bin/win64/cs2.exe");
        let steam_executable = root.join("Steam/steam.exe");
        fs::create_dir_all(source2_hook.parent().unwrap()).unwrap();
        fs::create_dir_all(game_executable.parent().unwrap()).unwrap();
        fs::create_dir_all(steam_executable.parent().unwrap()).unwrap();
        fs::write(&executable, b"hlae").unwrap();
        fs::write(&source2_hook, b"hook").unwrap();
        fs::write(&game_executable, b"cs2").unwrap();
        fs::write(&steam_executable, b"steam").unwrap();
        HlaeBundleLaunchInputs {
            installation: HlaeInstallation {
                root: installation_root,
                executable,
                source2_hook,
                source: HlaeDiscoverySource::Managed,
            },
            game_executable,
            steam_executable,
            resolution: LaunchResolution {
                width: 1920,
                height: 1080,
            },
        }
    }

    fn expected_artifacts(
        plan: &HlaePlan,
        root: &Path,
        bundle_name: &str,
        inputs: &HlaeBundleLaunchInputs,
    ) -> Vec<GeneratedArtifact> {
        let destination = root.join(bundle_name);
        let compiled = compile_hlae_plan(plan, &destination).unwrap();
        let handoff = compile_handoff(plan, &destination, inputs).unwrap();
        std::iter::once(compiled.bootstrap_config)
            .chain(std::iter::once(compiled.command_system))
            .chain(compiled.camera_paths)
            .chain(handoff)
            .collect()
    }

    #[test]
    fn exports_a_complete_reviewable_bundle() {
        let root = tempfile::tempdir().unwrap();
        let inputs = launch_inputs(root.path());
        let exported = export_hlae_plan(
            &plan(root.path().join("capture")),
            root.path(),
            "session_1",
            &inputs,
        )
        .unwrap();

        assert_eq!(exported.files.len(), 6);
        assert!(exported.directory.join("vibe_cs_hlae.cfg").is_file());
        assert!(exported.directory.join("vibe_cs_commands.xml").is_file());
        assert!(exported.directory.join("camera_shot_1.xml").is_file());
        let manifest: HlaeBundleManifest =
            serde_json::from_str(&fs::read_to_string(&exported.completion_marker).unwrap())
                .unwrap();
        let manifest_json = serde_json::to_value(&manifest).unwrap();
        let mut invalid_manifest = manifest_json;
        invalid_manifest
            .as_object_mut()
            .unwrap()
            .insert("unexpected".to_owned(), serde_json::json!(true));
        assert!(serde_json::from_value::<HlaeBundleManifest>(invalid_manifest).is_err());
        assert_eq!(manifest.artifacts.len(), 5);
        for artifact in manifest.artifacts {
            let contents = fs::read(exported.directory.join(&artifact.path)).unwrap();
            assert_eq!(artifact.size, u64::try_from(contents.len()).unwrap());
            assert_eq!(artifact.sha256, hex::encode(Sha256::digest(contents)));
        }

        let error = export_hlae_plan(
            &plan(root.path().join("capture")),
            root.path(),
            "session_1",
            &inputs,
        )
        .unwrap_err();
        assert!(matches!(error, HlaeError::ArtifactBundleExists(_)));
    }

    #[test]
    fn exports_a_typed_offline_launch_handoff() {
        let root = tempfile::tempdir().unwrap();
        let inputs = launch_inputs(root.path());

        let exported = export_hlae_plan(
            &plan(root.path().join("capture")),
            root.path(),
            "session_handoff",
            &inputs,
        )
        .unwrap();

        let handoff: HlaeBundleLaunchHandoff = serde_json::from_str(
            &fs::read_to_string(exported.directory.join(HLAE_BUNDLE_LAUNCH_PROFILE_FILE)).unwrap(),
        )
        .unwrap();
        let handoff_json = serde_json::to_value(&handoff).unwrap();
        let mut invalid_handoff = handoff_json;
        invalid_handoff
            .as_object_mut()
            .unwrap()
            .insert("unexpected".to_owned(), serde_json::json!(true));
        assert!(serde_json::from_value::<HlaeBundleLaunchHandoff>(invalid_handoff).is_err());
        assert!(
            handoff
                .launch_profile
                .arguments
                .iter()
                .any(|value| value == "-insecure")
        );
        assert!(handoff.launch_profile.safety.vac_servers_prohibited);
        assert!(exported.directory.join(HLAE_BUNDLE_README_FILE).is_file());
        let manifest: HlaeBundleManifest =
            serde_json::from_str(&fs::read_to_string(exported.completion_marker).unwrap()).unwrap();
        assert!(
            manifest
                .artifacts
                .iter()
                .any(|item| item.path == HLAE_BUNDLE_README_FILE)
        );
        assert!(
            manifest
                .artifacts
                .iter()
                .any(|item| item.path == HLAE_BUNDLE_LAUNCH_PROFILE_FILE)
        );
    }

    #[test]
    fn rejects_a_launch_resolution_that_differs_from_the_capture_contract() {
        let root = tempfile::tempdir().unwrap();
        let mut inputs = launch_inputs(root.path());
        inputs.resolution = LaunchResolution {
            width: 1280,
            height: 720,
        };

        let error = export_hlae_plan(
            &plan(root.path().join("capture")),
            root.path(),
            "resolution_mismatch",
            &inputs,
        )
        .unwrap_err();

        assert!(matches!(error, HlaeError::InvalidPlan(message) if message.contains("dimensions")));
        assert!(!root.path().join("resolution_mismatch").exists());
    }

    #[test]
    fn never_overwrites_an_existing_bundle() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("session_1");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("keep.txt"), b"keep").unwrap();
        let inputs = launch_inputs(root.path());

        let error = export_hlae_plan(
            &plan(root.path().join("capture")),
            root.path(),
            "session_1",
            &inputs,
        )
        .unwrap_err();

        assert!(matches!(error, HlaeError::ArtifactBundleConflict { .. }));
        assert_eq!(fs::read(destination.join("keep.txt")).unwrap(), b"keep");
        assert!(!destination.join(HLAE_BUNDLE_MANIFEST_FILE).exists());
    }

    #[test]
    fn resumes_an_exact_incomplete_bundle_without_overwriting() {
        let root = tempfile::tempdir().unwrap();
        let inputs = launch_inputs(root.path());
        let plan = plan(root.path().join("capture"));
        let destination = root.path().join("interrupted");
        fs::create_dir(&destination).unwrap();
        let expected = expected_artifacts(&plan, root.path(), "interrupted", &inputs);
        for artifact in expected.iter().take(2) {
            fs::write(&artifact.path, &artifact.contents).unwrap();
        }
        let preserved = fs::read(&expected[0].path).unwrap();

        let exported = export_hlae_plan(&plan, root.path(), "interrupted", &inputs).unwrap();

        assert_eq!(fs::read(&expected[0].path).unwrap(), preserved);
        assert!(exported.completion_marker.is_file());
        assert_eq!(exported.files.len(), expected.len() + 1);
    }

    #[test]
    fn unknown_incomplete_file_is_preserved_and_never_manifested() {
        let root = tempfile::tempdir().unwrap();
        let inputs = launch_inputs(root.path());
        let destination = root.path().join("unknown");
        fs::create_dir(&destination).unwrap();
        let sentinel = destination.join("keep.txt");
        fs::write(&sentinel, b"do not touch").unwrap();

        let error = export_hlae_plan(
            &plan(root.path().join("capture")),
            root.path(),
            "unknown",
            &inputs,
        )
        .unwrap_err();

        assert!(matches!(error, HlaeError::ArtifactBundleConflict { .. }));
        assert_eq!(fs::read(&sentinel).unwrap(), b"do not touch");
        assert!(!destination.join(HLAE_BUNDLE_MANIFEST_FILE).exists());
    }

    #[test]
    fn drifted_incomplete_artifact_is_preserved_and_never_overwritten() {
        let root = tempfile::tempdir().unwrap();
        let inputs = launch_inputs(root.path());
        let plan = plan(root.path().join("capture"));
        let destination = root.path().join("drifted");
        fs::create_dir(&destination).unwrap();
        let expected = expected_artifacts(&plan, root.path(), "drifted", &inputs);
        let drifted = &expected[0].path;
        fs::write(drifted, vec![b'x'; expected[0].contents.len()]).unwrap();

        let error = export_hlae_plan(&plan, root.path(), "drifted", &inputs).unwrap_err();

        assert!(matches!(error, HlaeError::ArtifactBundleConflict { .. }));
        assert_eq!(
            fs::read(drifted).unwrap(),
            vec![b'x'; expected[0].contents.len()]
        );
        assert!(!destination.join(HLAE_BUNDLE_MANIFEST_FILE).exists());
    }

    #[test]
    fn concurrent_exports_publish_exactly_one_complete_bundle() {
        let root = Arc::new(tempfile::tempdir().unwrap());
        let inputs = Arc::new(launch_inputs(root.path()));
        let barrier = Arc::new(Barrier::new(2));
        let threads = (0..2)
            .map(|_| {
                let root = Arc::clone(&root);
                let inputs = Arc::clone(&inputs);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let plan = plan(root.path().join("capture"));
                    barrier.wait();
                    export_hlae_plan(&plan, root.path(), "shared", &inputs)
                })
            })
            .collect::<Vec<_>>();
        let results = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(results.iter().filter(|result| result.is_err()).count(), 1);
        assert!(
            root.path()
                .join("shared")
                .join(HLAE_BUNDLE_MANIFEST_FILE)
                .is_file()
        );
    }

    #[test]
    fn rejects_bundle_path_traversal() {
        let root = tempfile::tempdir().unwrap();
        let inputs = launch_inputs(root.path());
        assert!(
            export_hlae_plan(
                &plan(root.path().join("capture")),
                root.path(),
                "../escape",
                &inputs,
            )
            .is_err()
        );
    }
}
