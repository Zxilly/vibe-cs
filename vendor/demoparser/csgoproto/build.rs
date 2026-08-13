fn main() {
    // The audited upstream commit already contains the generated protobuf module.
    // Keep vendored builds deterministic and offline instead of cloning mutable
    // GameTracking-CS2 data during compilation.
    println!("cargo::rerun-if-changed=src/protobuf.rs");
}
