"""Generate an original floor/wall/boxes VPK fixture; contains no Valve assets.

The deliberately uncompressed KV3 v5 writer is a fixture generator, not a
product encoder. Regenerate with Python, then use the Rust geometry_export
example to produce the browser fixture from the real extraction/VMAP path.
"""
from pathlib import Path
import struct
import zlib


def u32(value):
    return struct.pack("<I", value)


vertices = [(-2048.0, -2048.0, 0.0), (2048.0, -2048.0, 0.0),
            (2048.0, 2048.0, 0.0), (-2048.0, 2048.0, 0.0)]
triangles = [(0, 1, 2), (0, 2, 3)]
for low, high in [((-512, 256, 0), (512, 288, 192)),
                  ((-192, -128, 0), (64, 128, 96)),
                  ((256, -512, 0), (512, -256, 160))]:
    base = len(vertices)
    vertices.extend([(x, y, z) for z in (low[2], high[2])
                     for y in (low[1], high[1]) for x in (low[0], high[0])])
    for a, b, c in [(0, 2, 1), (1, 2, 3), (4, 5, 6), (5, 7, 6),
                    (0, 1, 4), (1, 5, 4), (2, 6, 3), (3, 6, 7),
                    (0, 4, 2), (2, 4, 6), (1, 3, 5), (3, 7, 5)]:
        triangles.append((base + a, base + b, base + c))

root = {
    "m_bindPose": [],
    "m_collisionAttributes": [{"m_InteractAsStrings": []}],
    "m_parts": [{"m_rnShape": {
        "m_spheres": [], "m_capsules": [], "m_hulls": [],
        "m_meshes": [{"m_nCollisionAttributeIndex": 0, "m_Mesh": {
            "m_Vertices": b"".join(struct.pack("<3f", *point) for point in vertices),
            "m_Triangles": b"".join(struct.pack("<3I", *triangle) for triangle in triangles),
        }}],
    }}],
}
strings = {}
types = bytearray()
four = bytearray()
object_lengths = bytearray()
blobs = []


def string_id(value):
    return strings.setdefault(value, len(strings))


def value_kind(value):
    return {dict: 9, list: 8, bytes: 7, int: 12}[type(value)]


def emit(value):
    if isinstance(value, dict):
        object_lengths.extend(u32(len(value)))
        for key, child in value.items():
            types.append(value_kind(child))
            four.extend(u32(string_id(key)))
            emit(child)
    elif isinstance(value, list):
        four.extend(u32(len(value)))
        for child in value:
            types.append(value_kind(child))
            emit(child)
    elif isinstance(value, bytes):
        blobs.append(value)
    else:
        four.extend(u32(value))


types.append(9)
emit(root)
string_bytes = b"".join(value.encode() + b"\0" for value in strings)
first = string_bytes + b"\0" * (-len(string_bytes) % 4) + u32(len(strings))
second = object_lengths + four + types + b"".join(u32(len(blob)) for blob in blobs) + u32(0xFFEEDD00)
header = [0x4B563305, 0, 0, 0, 0, 0, 0, len(string_bytes), 1, 0, len(types), 0,
          len(first) + len(second), 0, len(blobs), sum(map(len, blobs)), 0, 0,
          len(first), 0, len(second), 0, 0, 0, len(four) // 4, 0, 0,
          len(object_lengths) // 4, 0, 0]
kv3 = b"".join(map(u32, header)) + first + second + b"".join(blobs) + u32(0xFFEEDD00)
resource = u32(28 + len(kv3)) + struct.pack("<HHII", 12, 1, 8, 1)
resource += b"PHYS" + u32(8) + u32(len(kv3)) + kv3
entry = struct.pack("<IHHIIH", zlib.crc32(resource), 0, 0x7FFF, 0, len(resource), 0xFFFF)
tree = b"vmdl_c\0maps/de_fixture\0world_physics\0" + entry + b"\0\0\0"
vpk = struct.pack("<7I", 0x55AA1234, 2, len(tree), len(resource), 0, 0, 0) + tree + resource
output = Path(__file__).resolve().parent.parent / "crates/source-assets/tests/fixtures/de_fixture.vpk"
output.parent.mkdir(parents=True, exist_ok=True)
output.write_bytes(vpk)
print(f"{output}: {len(vertices)} vertices, {len(triangles)} triangles, {len(vpk)} bytes")
