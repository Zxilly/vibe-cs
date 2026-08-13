fn main() {
    // maps.rs, message_type.rs, and protobuf.rs are pinned generated artifacts
    // from the audited upstream commit. Do not regenerate them during a build.
    println!("cargo::rerun-if-changed=../csgoproto/src/protobuf.rs");
    println!("cargo::rerun-if-changed=../csgoproto/src/maps.rs");
    println!("cargo::rerun-if-changed=../csgoproto/src/message_type.rs");
}
