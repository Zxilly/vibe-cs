# Third-party notices

This crate uses the following third-party Rust packages:

| Package | Version | License | Source |
| --- | --- | --- | --- |
| `source2-demo` | `0.5.10` | MIT OR Apache-2.0 | <https://github.com/Rupas1k/source2-demo> |
| `parser` | `0.1.1` | MIT | [`LaihoE/demoparser` at `45ca85aeac8fb0de9d385124d2c7fe0e7b8ff0c8`](https://github.com/LaihoE/demoparser/tree/45ca85aeac8fb0de9d385124d2c7fe0e7b8ff0c8) |
| `csgoproto` | `0.1.5` | MIT | [`LaihoE/demoparser` at `45ca85aeac8fb0de9d385124d2c7fe0e7b8ff0c8`](https://github.com/LaihoE/demoparser/tree/45ca85aeac8fb0de9d385124d2c7fe0e7b8ff0c8) |

`source2-demo` is used only through its published crates.io API and has no
downstream patches. The `parser` and `csgoproto` sources are kept under
`vendor/demoparser` as an audited fork for deterministic offline compilation
from generated modules committed at the pin, hard parser resource and
decompression limits, checked decoding, the POV capture projection, exact-roster
and identity corrections, and reviewed performance patches. The upstream MIT
text at the pinned commit retains placeholder copyright fields, so
redistribution requires release/legal review. See the repository
[third-party notice](../../THIRD_PARTY.md),
[dependency provenance](../../docs/DEPENDENCY_PROVENANCE.md), and
[vendored upstream record](../../vendor/demoparser/UPSTREAM.md) for the exact
import scope, exclusions, hashes, and patch policy.
