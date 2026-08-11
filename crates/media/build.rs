use std::{env, fs, path::PathBuf};

fn main() {
    println!("cargo:rerun-if-env-changed=FFMPEG_DIR");
    let Some(sdk) = env::var_os("FFMPEG_DIR").map(PathBuf::from) else {
        return;
    };
    let bin = sdk.join("bin");
    println!("cargo:rerun-if-changed={}", bin.display());
    let Some(profile_dir) = PathBuf::from(env::var_os("OUT_DIR").expect("OUT_DIR"))
        .ancestors()
        .nth(3)
        .map(PathBuf::from)
    else {
        return;
    };
    let destinations = [profile_dir.clone(), profile_dir.join("deps")];
    let entries = fs::read_dir(&bin).unwrap_or_else(|error| {
        panic!(
            "unable to read FFmpeg SDK directory {}: {error}",
            bin.display()
        )
    });
    for entry in entries {
        let path = entry.expect("FFmpeg SDK entry").path();
        let is_runtime_file = path
            .extension()
            .is_some_and(|extension| extension.eq_ignore_ascii_case("dll"));
        if is_runtime_file {
            let name = path.file_name().expect("FFmpeg DLL name");
            for destination in &destinations {
                fs::create_dir_all(destination).expect("create Cargo profile directory");
                fs::copy(&path, destination.join(name)).unwrap_or_else(|error| {
                    panic!("unable to stage FFmpeg DLL {}: {error}", path.display())
                });
            }
        }
    }
}
