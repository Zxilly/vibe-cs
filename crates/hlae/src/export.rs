use std::{
    io::Write,
    path::{Component, Path, PathBuf},
};

use cap_std::{
    ambient_authority,
    fs::{Dir, OpenOptions},
};

use crate::validate::validate_safe_path;
use crate::{
    CompiledHlaePlan, ExportedHlaePlan, GeneratedArtifact, HlaeError, HlaePlan, compile_hlae_plan,
};

const COMPLETION_MARKER: &str = "vibe_cs_bundle.complete.json";
const COMPLETION_CONTENTS: &str =
    "{\"schemaVersion\":1,\"state\":\"complete\",\"producer\":\"vibe-cs-hlae\"}\n";

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
) -> Result<ExportedHlaePlan, HlaeError> {
    validate_safe_path(managed_root, "managedRoot", true)?;
    validate_bundle_name(bundle_name)?;
    let root = Dir::open_ambient_dir(managed_root, ambient_authority())
        .map_err(|error| io_error("open managed HLAE directory", &error))?;
    match root.create_dir(bundle_name) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err(HlaeError::ArtifactBundleExists(
                managed_root.join(bundle_name),
            ));
        }
        Err(error) => return Err(io_error("reserve HLAE artifact bundle", &error)),
    }
    let bundle = root
        .open_dir(bundle_name)
        .map_err(|error| io_error("open reserved HLAE artifact bundle", &error))?;
    let destination = managed_root.join(bundle_name);
    let compiled = compile_hlae_plan(plan, &destination)?;
    let mut files = write_bundle_files(&bundle, &compiled, &destination)?;
    write_new_file(&bundle, Path::new(COMPLETION_MARKER), COMPLETION_CONTENTS)?;
    let completion_marker = destination.join(COMPLETION_MARKER);
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
    compiled: &CompiledHlaePlan,
    destination: &Path,
) -> Result<Vec<PathBuf>, HlaeError> {
    let artifacts = std::iter::once(&compiled.bootstrap_config)
        .chain(std::iter::once(&compiled.command_system))
        .chain(compiled.camera_paths.iter());
    let mut files = Vec::new();
    for artifact in artifacts {
        let relative = safe_artifact_relative_path(artifact, destination)?;
        write_new_file(bundle, relative, &artifact.contents)?;
        files.push(artifact.path.clone());
    }
    Ok(files)
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
        HLAE_PLAN_SCHEMA_VERSION, HlaePlanMode, PositionInterpolation, RotationInterpolation,
    };

    use super::*;

    fn plan(output: PathBuf) -> HlaePlan {
        HlaePlan {
            schema_version: HLAE_PLAN_SCHEMA_VERSION,
            mode: HlaePlanMode::Preview,
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

    #[test]
    fn exports_a_complete_reviewable_bundle() {
        let root = tempfile::tempdir().unwrap();
        let exported =
            export_hlae_plan(&plan(root.path().join("capture")), root.path(), "session_1").unwrap();

        assert_eq!(exported.files.len(), 4);
        assert!(exported.directory.join("vibe_cs_hlae.cfg").is_file());
        assert!(exported.directory.join("vibe_cs_commands.xml").is_file());
        assert!(exported.directory.join("camera_shot_1.xml").is_file());
        assert_eq!(
            fs::read_to_string(&exported.completion_marker).unwrap(),
            COMPLETION_CONTENTS
        );
    }

    #[test]
    fn never_overwrites_an_existing_bundle() {
        let root = tempfile::tempdir().unwrap();
        let destination = root.path().join("session_1");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("keep.txt"), b"keep").unwrap();

        let error = export_hlae_plan(&plan(root.path().join("capture")), root.path(), "session_1")
            .unwrap_err();

        assert!(matches!(error, HlaeError::ArtifactBundleExists(_)));
        assert_eq!(fs::read(destination.join("keep.txt")).unwrap(), b"keep");
    }

    #[test]
    fn concurrent_exports_publish_exactly_one_complete_bundle() {
        let root = Arc::new(tempfile::tempdir().unwrap());
        let barrier = Arc::new(Barrier::new(2));
        let threads = (0..2)
            .map(|_| {
                let root = Arc::clone(&root);
                let barrier = Arc::clone(&barrier);
                std::thread::spawn(move || {
                    let plan = plan(root.path().join("capture"));
                    barrier.wait();
                    export_hlae_plan(&plan, root.path(), "shared")
                })
            })
            .collect::<Vec<_>>();
        let results = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Vec<_>>();

        assert_eq!(results.iter().filter(|result| result.is_ok()).count(), 1);
        assert_eq!(
            results
                .iter()
                .filter(|result| matches!(result, Err(HlaeError::ArtifactBundleExists(_))))
                .count(),
            1
        );
        assert!(root.path().join("shared").join(COMPLETION_MARKER).is_file());
    }

    #[test]
    fn rejects_bundle_path_traversal() {
        let root = tempfile::tempdir().unwrap();
        assert!(
            export_hlae_plan(&plan(root.path().join("capture")), root.path(), "../escape",)
                .is_err()
        );
    }
}
