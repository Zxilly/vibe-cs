fn main() {
    if let Ok(target) = std::env::var("TARGET") {
        println!("cargo:rustc-env=VIBE_CS_TARGET_TRIPLE={target}");
        let manifest = format!("binaries/vibe-cs-agent-{target}.exe.sha256");
        println!("cargo:rerun-if-changed={manifest}");
        let hash = std::fs::read_to_string(&manifest).unwrap_or_default();
        let hash = hash.trim();
        assert!(
            hash.is_empty()
                || hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "agent sidecar SHA-256 manifest is invalid"
        );
        if std::env::var("PROFILE").as_deref() == Ok("release") {
            assert!(
                !hash.is_empty(),
                "release builds require a generated agent sidecar SHA-256 manifest"
            );
        }
        println!("cargo:rustc-env=VIBE_CS_AGENT_SIDECAR_SHA256={hash}");
    }
    tauri_build::build();
}
