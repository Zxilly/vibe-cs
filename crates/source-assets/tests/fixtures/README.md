# Original geometry fixture

`de_fixture.vpk` contains an original synthetic floor, one wall and two boxes:
28 vertices and 38 triangles. It contains no game resources. The fixture passes
through the same VPK reader, PHYS/KV3 decoder, collision filter, mesh builder and
VMAP encoder as installed CS2 maps.

Regenerate from the repository root:

```powershell
python scripts/generate-geometry-fixture.py
cargo run --locked -p vibe-cs-source-assets --example geometry_export -- crates/source-assets/tests/fixtures/de_fixture.vpk apps/web/src/dev/fixtures/scene3d.vmap
```

The runtime cache tests use the VPK. The browser development backend and VMAP
contract tests use the resulting VMAP. Both files are intentionally small and
can be committed; locally exported game maps must remain outside Git.
