fn main() {
    if let Ok(target) = std::env::var("TARGET") {
        println!("cargo:rustc-env=VIBE_CS_TARGET_TRIPLE={target}");
        let demo_worker = format!("binaries/vibe-cs-demo-worker-{target}.exe");
        let demo_manifest = format!("{demo_worker}.sha256");
        println!("cargo:rerun-if-changed={demo_worker}");
        println!("cargo:rerun-if-changed={demo_manifest}");
        let demo_hash = std::fs::read_to_string(&demo_manifest).unwrap_or_default();
        let demo_hash = demo_hash.trim();
        assert!(
            demo_hash.is_empty()
                || demo_hash.len() == 64 && demo_hash.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "demo worker sidecar SHA-256 manifest is invalid"
        );
        if std::env::var("PROFILE").as_deref() == Ok("release") {
            assert!(
                std::path::Path::new(&demo_worker).is_file() && !demo_hash.is_empty(),
                "release builds require a generated demo worker sidecar and SHA-256 manifest"
            );
        }
        println!("cargo:rustc-env=VIBE_CS_DEMO_WORKER_SHA256={demo_hash}");
    }
    tauri_build::build();
}
