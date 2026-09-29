//! Static world collision geometry, in Source coordinates (Z up, game units).
//! Physics shape layout follows `ValveResourceFormat` `RubikonPhysics` at the
//! revision cited by `kv3`; see ../licenses/ValveResourceFormat-MIT.txt.
use std::collections::HashMap;

use crate::{Kv3Value, Result, SourceAssetError, closed_triangle_components, decode_physics_kv3};

// Current Inferno has more than two million opaque collision triangles.
const MAX_TRIANGLES: usize = 4_000_000;
const QUANTIZATION: f32 = 16.0;

#[derive(Debug, Default, PartialEq)]
pub struct MapGeometry {
    pub vertices: Vec<[f32; 3]>,
    pub triangles: Vec<[u32; 3]>,
    /// Vertex indices of original convex physics solids, before triangle welding
    /// can connect them to an open world mesh. Open surfaces are not solids.
    pub convex_solids: Vec<Vec<u32>>,
    /// Triangle indices of closed oriented shells, grouped by original mesh.
    /// Opposite winding is preserved so a nested inner shell remains a cavity.
    pub closed_meshes: Vec<Vec<u32>>,
    pub included_shapes: usize,
    pub excluded_shapes: usize,
}

fn invalid(message: impl Into<String>) -> SourceAssetError {
    SourceAssetError::InvalidPhysics(message.into())
}

fn field<'a>(value: &'a Kv3Value, name: &str) -> Result<&'a Kv3Value> {
    let Kv3Value::Object(object) = value else {
        return Err(invalid("expected physics object"));
    };
    object
        .get(name)
        .ok_or_else(|| invalid(format!("missing physics field {name}")))
}

fn array(value: &Kv3Value) -> Result<&[Kv3Value]> {
    let Kv3Value::Array(array) = value else {
        return Err(invalid("expected physics array"));
    };
    Ok(array)
}

fn blob<'a>(value: &'a Kv3Value, name: &str, stride: usize) -> Result<&'a [u8]> {
    let Kv3Value::Blob(bytes) = field(value, name)? else {
        return Err(invalid(format!("expected binary physics field {name}")));
    };
    if bytes.len() % stride != 0 {
        return Err(invalid(format!("misaligned physics field {name}")));
    }
    Ok(bytes)
}

fn index(value: &Kv3Value) -> Result<usize> {
    match value {
        Kv3Value::Integer(value) => {
            usize::try_from(*value).map_err(|_| invalid("negative physics index"))
        }
        Kv3Value::Unsigned(value) => {
            usize::try_from(*value).map_err(|_| invalid("physics index overflow"))
        }
        _ => Err(invalid("expected physics index")),
    }
}

#[allow(
    clippy::cast_possible_truncation,
    reason = "finite Source coordinates and radii are bounded before conversion"
)]
fn scalar(value: &Kv3Value) -> Result<f32> {
    let Kv3Value::Float(value) = value else {
        return Err(invalid("expected physics float"));
    };
    if !value.is_finite() || value.abs() > 1_000_000.0 {
        return Err(invalid("invalid physics scalar"));
    }
    Ok(*value as f32)
}

fn vector(value: &Kv3Value) -> Result<[f32; 3]> {
    let values = array(value)?;
    if values.len() != 3 {
        return Err(invalid("expected physics three-vector"));
    }
    Ok([
        scalar(&values[0])?,
        scalar(&values[1])?,
        scalar(&values[2])?,
    ])
}

// Evidence: CS2 scripts/collision_properties.txt and core tools materials.
// Untagged/default geometry and explicit solid/LOS geometry block vision.
// Sound/light-only and navigation/player/grenade tool clips do not. Nuke has
// [blocklight, blocklos, blocksound, solid], which must not be discarded merely
// because one of its tags is a non-visual tool tag.
fn is_occluder(attribute: &Kv3Value) -> Result<bool> {
    let tags = array(field(attribute, "m_InteractAsStrings")?)?;
    if tags.is_empty() {
        return Ok(true);
    }
    let mut blocks_vision = false;
    let mut passes_vision = false;
    for tag in tags {
        let Kv3Value::String(tag) = tag else {
            return Err(invalid("non-string collision tag"));
        };
        if !matches!(
            tag.as_str(),
            "playerclip"
                | "npcclip"
                | "csgo_grenadeclip"
                | "sky"
                | "ladder"
                | "passbullets"
                | "window"
                | "blocklight"
                | "navclip"
                | "blocksound"
                | "blocklos"
                | "solid"
                | "CONTENTS_SOLID"
                | "CONTENTS_SOLID_NO_BLOCK_LOS"
                | "csgo_droneclip"
                | ""
        ) {
            return Err(invalid(format!("unknown world collision tag {tag:?}")));
        }
        blocks_vision |= matches!(tag.as_str(), "solid" | "CONTENTS_SOLID" | "blocklos");
        passes_vision |= matches!(tag.as_str(), "window" | "CONTENTS_SOLID_NO_BLOCK_LOS");
    }
    Ok(blocks_vision && !passes_vision)
}

/// Extract opaque static hulls and triangle meshes from a world PHYS resource.
/// Unsupported transformed/animated shapes return an error rather than a mesh
/// in the wrong coordinate frame. Game resources are read locally, never bundled.
pub fn extract_world_geometry(resource: &[u8]) -> Result<MapGeometry> {
    let root = decode_physics_kv3(resource)?;
    extract(&root)
}

fn extract(root: &Kv3Value) -> Result<MapGeometry> {
    if !array(field(root, "m_bindPose")?)?.is_empty() {
        return Err(invalid("transformed world physics parts are not supported"));
    }
    let include = array(field(root, "m_collisionAttributes")?)?
        .iter()
        .map(is_occluder)
        .collect::<Result<Vec<_>>>()?;
    extract_selected(root, &include)
}

fn extract_selected(root: &Kv3Value, include: &[bool]) -> Result<MapGeometry> {
    let mut builder = Builder::default();
    for part in array(field(root, "m_parts")?)? {
        let shape = field(part, "m_rnShape")?;
        for (collection, key) in [
            ("m_meshes", "m_Mesh"),
            ("m_hulls", "m_Hull"),
            ("m_spheres", "m_Sphere"),
            ("m_capsules", "m_Capsule"),
        ] {
            for descriptor in array(field(shape, collection)?)? {
                let attribute = index(field(descriptor, "m_nCollisionAttributeIndex")?)?;
                if !*include
                    .get(attribute)
                    .ok_or_else(|| invalid("collision attribute outside table"))?
                {
                    builder.geometry.excluded_shapes += 1;
                    continue;
                }
                let data = field(descriptor, key)?;
                if matches!(key, "m_Sphere" | "m_Capsule") {
                    let radius = scalar(field(data, "m_flRadius")?)?;
                    let centers = field(data, "m_vCenter")?;
                    let (start, end) = if key == "m_Sphere" {
                        let center = vector(centers)?;
                        (center, center)
                    } else {
                        let centers = array(centers)?;
                        if centers.len() != 2 {
                            return Err(invalid("capsule requires two centers"));
                        }
                        (vector(&centers[0])?, vector(&centers[1])?)
                    };
                    builder.capsule(start, end, radius)?;
                    builder.geometry.included_shapes += 1;
                    continue;
                }
                let Kv3Value::Object(fields) = data else {
                    return Err(invalid("expected shape object"));
                };
                let vertex_name = if fields.contains_key("m_VertexPositions") {
                    "m_VertexPositions"
                } else {
                    "m_Vertices"
                };
                let positions = blob(data, vertex_name, 12)?;
                let mut vertices = Vec::new();
                for bytes in positions.chunks_exact(12) {
                    let point = std::array::from_fn(|axis| {
                        f32::from_le_bytes(bytes[axis * 4..axis * 4 + 4].try_into().unwrap())
                    });
                    vertices.push(builder.vertex(point)?);
                }
                if key == "m_Mesh" {
                    let mut triangles = Vec::new();
                    for bytes in blob(data, "m_Triangles", 12)?.chunks_exact(12) {
                        let indices = std::array::from_fn(|axis| {
                            u32::from_le_bytes(bytes[axis * 4..axis * 4 + 4].try_into().unwrap())
                        });
                        triangles.push(indices);
                    }
                    builder.mesh(&vertices, &triangles)?;
                } else {
                    builder.hull(data, &vertices)?;
                }
                builder.geometry.included_shapes += 1;
            }
        }
    }
    if builder.geometry.triangles.is_empty() {
        return Err(invalid("world physics contains no opaque triangles"));
    }
    Ok(builder.geometry)
}

#[derive(Default)]
struct Builder {
    geometry: MapGeometry,
    welded: HashMap<[i32; 3], u32>,
}

impl Builder {
    fn mesh(&mut self, vertices: &[u32], triangles: &[[u32; 3]]) -> Result<()> {
        if triangles.len() > MAX_TRIANGLES {
            return Err(invalid("world triangle limit exceeded"));
        }
        let mut emitted = Vec::with_capacity(triangles.len());
        for triangle in triangles {
            let before = self.geometry.triangles.len();
            self.triangle(vertices, triangle.map(|index| index as usize))?;
            emitted.push((self.geometry.triangles.len() > before).then_some(before));
        }
        let mut closed_mesh = Vec::new();
        for component in closed_triangle_components(triangles) {
            let indices = component
                .into_iter()
                .filter_map(|index| emitted[index])
                .collect::<Vec<_>>();
            let quantized = indices
                .iter()
                .map(|index| self.geometry.triangles[*index])
                .collect::<Vec<_>>();
            // Welding can collapse edges or join faces. Do not certify a shell
            // unless all its surviving triangles still form closed components.
            let retained = closed_triangle_components(&quantized);
            if !quantized.is_empty()
                && retained.iter().map(Vec::len).sum::<usize>() == quantized.len()
            {
                closed_mesh.extend(
                    indices
                        .into_iter()
                        .map(|index| u32::try_from(index).expect("bounded triangle table")),
                );
            }
        }
        if !closed_mesh.is_empty() {
            closed_mesh.sort_unstable();
            self.geometry.closed_meshes.push(closed_mesh);
        }
        Ok(())
    }

    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_sign_loss,
        clippy::cast_precision_loss,
        reason = "tessellation count is checked in 8..=256 before casts"
    )]
    fn capsule(&mut self, start: [f32; 3], end: [f32; 3], radius: f32) -> Result<()> {
        if !radius.is_finite() || radius <= 0.0 {
            return Err(invalid("invalid sphere/capsule radius"));
        }
        // Maximum radial chord error 0.25 game units before vertex quantization.
        let segments = (std::f32::consts::PI / (1.0 - 0.25 / radius).clamp(-1.0, 1.0).acos())
            .ceil()
            .max(8.0);
        if segments > 256.0 {
            return Err(invalid("sphere/capsule tessellation exceeds limit"));
        }
        let segments = segments as usize;
        let hemisphere_steps = segments.div_ceil(4);
        let direction = std::array::from_fn(|axis| end[axis] - start[axis]);
        let length = dot(direction, direction).sqrt();
        let axis = if length > 0.0 {
            direction.map(|value| value / length)
        } else {
            [0.0, 0.0, 1.0]
        };
        let reference = if axis[2].abs() < 0.9 {
            [0.0, 0.0, 1.0]
        } else {
            [0.0, 1.0, 0.0]
        };
        let tangent = cross(axis, reference);
        let magnitude = dot(tangent, tangent).sqrt();
        let tangent = tangent.map(|value| value / magnitude);
        let bitangent = cross(axis, tangent);
        let mut rings = Vec::new();
        for (hemisphere, center) in [end, start].into_iter().enumerate() {
            for step in 0..=hemisphere_steps {
                let angle = (hemisphere as f32 + step as f32 / hemisphere_steps as f32)
                    * std::f32::consts::FRAC_PI_2;
                let mut ring = Vec::new();
                for segment in 0..segments {
                    let azimuth = segment as f32 / segments as f32 * std::f32::consts::TAU;
                    let point = std::array::from_fn(|dimension| {
                        center[dimension]
                            + radius
                                * (axis[dimension] * angle.cos()
                                    + angle.sin()
                                        * (tangent[dimension] * azimuth.cos()
                                            + bitangent[dimension] * azimuth.sin()))
                    });
                    ring.push(self.vertex(point)?);
                }
                rings.push(ring);
            }
        }
        for pair in rings.windows(2) {
            for segment in 0..segments {
                let next = (segment + 1) % segments;
                let quad = [
                    pair[0][segment],
                    pair[1][segment],
                    pair[1][next],
                    pair[0][next],
                ];
                self.triangle(&quad, [0, 1, 2])?;
                self.triangle(&quad, [0, 2, 3])?;
            }
        }
        let mut solid = rings.into_iter().flatten().collect::<Vec<_>>();
        solid.sort_unstable();
        solid.dedup();
        self.geometry.convex_solids.push(solid);
        Ok(())
    }
    #[allow(
        clippy::cast_possible_truncation,
        clippy::cast_precision_loss,
        reason = "bounded Source coordinates are quantized to 1/16 unit"
    )]
    fn vertex(&mut self, point: [f32; 3]) -> Result<u32> {
        if point
            .iter()
            .any(|value| !value.is_finite() || value.abs() > 1_000_000.0)
        {
            return Err(invalid("invalid world vertex"));
        }
        let key = point.map(|value| (value * QUANTIZATION).round() as i32);
        if let Some(index) = self.welded.get(&key) {
            return Ok(*index);
        }
        if self.geometry.vertices.len() >= MAX_TRIANGLES * 3 {
            return Err(invalid("world vertex limit exceeded"));
        }
        let index = u32::try_from(self.geometry.vertices.len())
            .map_err(|_| invalid("world vertex index overflow"))?;
        self.geometry
            .vertices
            .push(key.map(|value| value as f32 / QUANTIZATION));
        self.welded.insert(key, index);
        Ok(index)
    }

    fn triangle(&mut self, vertices: &[u32], indices: [usize; 3]) -> Result<()> {
        let mut triangle = [0; 3];
        for (out, index) in triangle.iter_mut().zip(indices) {
            *out = *vertices
                .get(index)
                .ok_or_else(|| invalid("triangle vertex outside shape"))?;
        }
        // Quantization can collapse small collision triangles; do not feed
        // degenerate index triples to the render/collision engines.
        if triangle[0] == triangle[1] || triangle[1] == triangle[2] || triangle[2] == triangle[0] {
            return Ok(());
        }
        if self.geometry.triangles.len() >= MAX_TRIANGLES {
            return Err(invalid("world triangle limit exceeded"));
        }
        self.geometry.triangles.push(triangle);
        Ok(())
    }

    fn hull(&mut self, data: &Kv3Value, vertices: &[u32]) -> Result<()> {
        let edges = blob(data, "m_Edges", 4)?;
        for (face_index, first) in blob(data, "m_Faces", 1)?.iter().enumerate() {
            let mut edge_index = usize::from(*first);
            let mut visited = [false; 256];
            let mut polygon = Vec::new();
            loop {
                if visited[edge_index] {
                    return Err(invalid("hull face contains a non-closing edge cycle"));
                }
                visited[edge_index] = true;
                let edge = edges
                    .get(edge_index * 4..edge_index * 4 + 4)
                    .ok_or_else(|| invalid("hull edge outside table"))?;
                if usize::from(edge[3]) != face_index {
                    return Err(invalid("hull half-edge belongs to another face"));
                }
                polygon.push(usize::from(edge[2]));
                edge_index = usize::from(edge[0]);
                if edge_index == usize::from(*first) {
                    break;
                }
            }
            if polygon.len() < 3 {
                return Err(invalid("hull face has fewer than three vertices"));
            }
            for pair in polygon[1..].windows(2) {
                self.triangle(vertices, [polygon[0], pair[0], pair[1]])?;
            }
        }
        let mut solid = vertices.to_vec();
        solid.sort_unstable();
        solid.dedup();
        // Quantization may collapse very thin solids to a plane. The runtime's
        // convex constructor verifies volume; keep source membership intact.
        self.geometry.convex_solids.push(solid);
        Ok(())
    }
}

fn dot(a: [f32; 3], b: [f32; 3]) -> f32 {
    a.into_iter().zip(b).map(|(left, right)| left * right).sum()
}

fn cross(a: [f32; 3], b: [f32; 3]) -> [f32; 3] {
    [
        a[1] * b[2] - a[2] * b[1],
        a[2] * b[0] - a[0] * b[2],
        a[0] * b[1] - a[1] * b[0],
    ]
}

#[cfg(test)]
#[path = "../examples/support/ground_alignment.rs"]
mod alignment;

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

    #[test]
    fn mesh_membership_survives_unrelated_welded_surfaces_but_never_seals_an_open_source() {
        let mut builder = Builder::default();
        let vertices = [
            [0.0, 0.0, 0.0],
            [128.0, 0.0, 0.0],
            [0.0, 128.0, 0.0],
            [0.0, 0.0, 128.0],
        ]
        .map(|point| builder.vertex(point).unwrap());
        let tetra = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];
        builder.mesh(&vertices, &tetra).unwrap();
        builder.mesh(&vertices, &tetra[..3]).unwrap();
        assert_eq!(builder.geometry.closed_meshes, vec![vec![0, 1, 2, 3]]);
        assert_eq!(builder.geometry.triangles.len(), 7);
        assert!(builder.mesh(&vertices, &[[0, 1, 99]]).is_err());
    }

    #[test]
    #[ignore = "requires VIBE_CS2_INSTALL and VIBE_ALIGNMENT_SAMPLES from a real Demo"]
    fn real_landing_coordinates_align_with_player_support() {
        let install = std::path::PathBuf::from(std::env::var_os("VIBE_CS2_INSTALL").unwrap());
        let evidence: serde_json::Value = serde_json::from_slice(
            &std::fs::read(std::env::var_os("VIBE_ALIGNMENT_SAMPLES").unwrap()).unwrap(),
        )
        .unwrap();
        let map = evidence["map_name"].as_str().unwrap();
        let archive =
            crate::VpkArchive::open(install.join(format!("game/csgo/maps/{map}.vpk"))).unwrap();
        let root = decode_physics_kv3(
            &archive
                .read(&format!("maps/{map}/world_physics.vmdl_c"))
                .unwrap(),
        )
        .unwrap();
        let opaque = extract(&root).unwrap();
        // Only this diagnostic includes invisible player support. Rendering and
        // camera LOS continue to use extract(), which excludes playerclip.
        let support_mask = array(field(&root, "m_collisionAttributes").unwrap())
            .unwrap()
            .iter()
            .map(|attribute| {
                is_occluder(attribute).unwrap()
                    || array(field(attribute, "m_InteractAsStrings").unwrap())
                        .unwrap()
                        .iter()
                        .any(|tag| matches!(tag, Kv3Value::String(value) if value == "playerclip"))
            })
            .collect::<Vec<_>>();
        let support = extract_selected(&root, &support_mask).unwrap();
        let samples = evidence["samples"].as_array().unwrap();
        assert!(samples.len() >= 32);
        let mut recovered = 0;
        let mut maximum = 0.0_f64;
        for sample in samples {
            assert_eq!(sample["flags_before"].as_u64().unwrap() & 1, 0);
            assert_eq!(sample["flags"].as_u64().unwrap() & 1, 1);
            let point = std::array::from_fn(|axis| sample["position"][axis].as_f64().unwrap());
            let surface = alignment::ground_below(&support, point, 16.0).unwrap();
            let error = (surface - point[2]).abs();
            maximum = maximum.max(error);
            assert!(
                error < 2.0,
                "tick {} has support error {error}",
                sample["tick"]
            );
            let opaque_error = alignment::ground_below(&opaque, point, 16.0)
                .map_or(f64::INFINITY, |height| (height - point[2]).abs());
            if opaque_error >= 2.0 {
                recovered += 1;
                println!(
                    "tick={} opaque_error={opaque_error:.6} support_z={surface:.6} support_error={error:.6}",
                    sample["tick"]
                );
            }
        }
        assert!(
            recovered > 0,
            "fixture must exercise invisible player support"
        );
        println!(
            "map={map} samples={} recovered={recovered} maximum_support_error={maximum:.6}",
            samples.len()
        );
    }

    fn object(fields: impl IntoIterator<Item = (&'static str, Kv3Value)>) -> Kv3Value {
        Kv3Value::Object(
            fields
                .into_iter()
                .map(|(key, value)| (key.to_owned(), value))
                .collect::<BTreeMap<_, _>>(),
        )
    }

    fn attribute(tags: &[&str]) -> Kv3Value {
        object([(
            "m_InteractAsStrings",
            Kv3Value::Array(
                tags.iter()
                    .map(|tag| Kv3Value::String((*tag).to_owned()))
                    .collect(),
            ),
        )])
    }

    #[test]
    fn keeps_solids_and_filters_tool_collision_without_guessing_unknown_tags() {
        assert!(is_occluder(&attribute(&[])).unwrap());
        assert!(
            is_occluder(&attribute(&[
                "blocklight",
                "blocklos",
                "blocksound",
                "solid"
            ]))
            .unwrap()
        );
        assert!(is_occluder(&attribute(&["blocksound", "CONTENTS_SOLID"])).unwrap());
        assert!(!is_occluder(&attribute(&["blocksound"])).unwrap());
        assert!(!is_occluder(&attribute(&["blocklight", "navclip"])).unwrap());
        assert!(!is_occluder(&attribute(&["CONTENTS_SOLID_NO_BLOCK_LOS"])).unwrap());
        for tags in [
            vec!["playerclip", "npcclip"],
            vec!["sky"],
            vec!["window", "passbullets"],
            vec!["csgo_grenadeclip"],
        ] {
            assert!(!is_occluder(&attribute(&tags)).unwrap());
        }
        assert!(is_occluder(&attribute(&["new_game_tag"])).is_err());
    }

    #[test]
    fn welds_quantized_vertices_and_rejects_invalid_geometry() {
        let mut builder = Builder::default();
        let a = builder.vertex([0.0; 3]).unwrap();
        assert_eq!(a, builder.vertex([0.01; 3]).unwrap());
        let b = builder.vertex([1.0, 0.0, 0.0]).unwrap();
        let c = builder.vertex([0.0, 1.0, 0.0]).unwrap();
        assert!(builder.vertex([f32::NAN; 3]).is_err());
        assert!(builder.vertex([f32::INFINITY; 3]).is_err());
        assert!(builder.vertex([1_000_001.0; 3]).is_err());
        builder.triangle(&[a, b, c], [0, 1, 2]).unwrap();
        builder.triangle(&[a, b, c], [0, 0, 2]).unwrap();
        assert!(builder.triangle(&[a, b, c], [0, 1, 3]).is_err());
        assert_eq!(builder.geometry.triangles, vec![[a, b, c]]);
    }

    #[test]
    fn triangulates_convex_faces_and_rejects_broken_edge_cycles() {
        let mut builder = Builder::default();
        let vertices = [
            [0.0, 0.0, 0.0],
            [1.0, 0.0, 0.0],
            [1.0, 1.0, 0.0],
            [0.0, 1.0, 0.0],
        ]
        .into_iter()
        .map(|point| builder.vertex(point).unwrap())
        .collect::<Vec<_>>();
        let edges = vec![1, 0, 0, 0, 2, 0, 1, 0, 3, 0, 2, 0, 0, 0, 3, 0];
        let shape = |bytes| {
            object([
                ("m_Edges", Kv3Value::Blob(bytes)),
                ("m_Faces", Kv3Value::Blob(vec![0])),
            ])
        };
        builder.hull(&shape(edges.clone()), &vertices).unwrap();
        assert_eq!(builder.geometry.triangles, [[0, 1, 2], [0, 2, 3]]);
        let mut cycle = edges.clone();
        cycle[12] = 1;
        assert!(builder.hull(&shape(cycle), &vertices).is_err());
        let mut out_of_range = edges;
        out_of_range[0] = 255;
        assert!(builder.hull(&shape(out_of_range), &vertices).is_err());
    }

    #[test]
    fn curved_shapes_are_closed_outward_surfaces_with_bounded_radial_error() {
        for end in [[1.0, 2.0, 3.0], [21.0, 12.0, 43.0]] {
            let start = [1.0, 2.0, 3.0];
            let mut builder = Builder::default();
            builder.capsule(start, end, 24.0).unwrap();
            let direction = std::array::from_fn(|axis| end[axis] - start[axis]);
            let length_squared = dot(direction, direction);
            let from_axis = |point: [f32; 3]| {
                let offset = std::array::from_fn(|axis| point[axis] - start[axis]);
                let t = if length_squared > 0.0 {
                    (dot(offset, direction) / length_squared).clamp(0.0, 1.0)
                } else {
                    0.0
                };
                std::array::from_fn(|axis| offset[axis] - t * direction[axis])
            };
            let mut edge_counts = HashMap::new();
            for triangle in &builder.geometry.triangles {
                let [a, b, c] = triangle.map(|index| builder.geometry.vertices[index as usize]);
                let normal = cross(
                    std::array::from_fn(|axis| b[axis] - a[axis]),
                    std::array::from_fn(|axis| c[axis] - a[axis]),
                );
                let centroid = std::array::from_fn(|axis| (a[axis] + b[axis] + c[axis]) / 3.0);
                let radial = from_axis(centroid);
                assert!(dot(normal, radial) > 0.0, "outward winding");
                assert!(
                    (dot(radial, radial).sqrt() - 24.0).abs() < 0.55,
                    "bounded surface approximation"
                );
                for [mut left, mut right] in [
                    [triangle[0], triangle[1]],
                    [triangle[1], triangle[2]],
                    [triangle[2], triangle[0]],
                ] {
                    if left > right {
                        std::mem::swap(&mut left, &mut right);
                    }
                    *edge_counts.entry((left, right)).or_insert(0) += 1;
                }
            }
            assert!(
                edge_counts.values().all(|count| *count == 2),
                "closed manifold"
            );
        }
        let mut builder = Builder::default();
        for radius in [0.0, -1.0, f32::NAN, f32::INFINITY, 1_000_000.0] {
            assert!(builder.capsule([0.0; 3], [1.0; 3], radius).is_err());
        }
    }

    #[test]
    #[ignore = "requires VIBE_CS2_INSTALL pointing at a real CS2 installation"]
    fn extracts_real_competitive_maps() {
        let root = std::path::PathBuf::from(
            std::env::var_os("VIBE_CS2_INSTALL").expect("VIBE_CS2_INSTALL"),
        );
        for map in [
            "de_mirage",
            "de_dust2",
            "de_inferno",
            "de_nuke",
            "de_ancient",
            "de_anubis",
            "de_train",
            "de_overpass",
        ] {
            let archive =
                crate::VpkArchive::open(root.join(format!("game/csgo/maps/{map}.vpk"))).unwrap();
            let bytes = archive
                .read(&format!("maps/{map}/world_physics.vmdl_c"))
                .unwrap();
            let geometry =
                extract_world_geometry(&bytes).unwrap_or_else(|error| panic!("{map}: {error}"));
            assert!(geometry.triangles.len() > 10_000, "{map}");
            assert!(geometry.excluded_shapes > 0, "{map}");
            assert!(
                geometry
                    .triangles
                    .iter()
                    .flatten()
                    .all(|index| (*index as usize) < geometry.vertices.len()),
                "{map}"
            );
            let encoded = crate::encode_map_geometry(&geometry).unwrap();
            assert!(encoded.len() < 10 * 1024 * 1024, "{map}");
            assert_eq!(
                crate::decode_map_geometry(&encoded).unwrap(),
                geometry,
                "{map}"
            );
            assert!(!geometry.convex_solids.is_empty(), "{map}");
            eprintln!(
                "{map}: {} vertices, {} triangles, {} convex solids, {} closed meshes ({} triangles), {} bytes (exact v3 round trip)",
                geometry.vertices.len(),
                geometry.triangles.len(),
                geometry.convex_solids.len(),
                geometry.closed_meshes.len(),
                geometry.closed_meshes.iter().map(Vec::len).sum::<usize>(),
                encoded.len()
            );
        }
    }

    #[test]
    #[ignore = "requires VIBE_CS2_INSTALL pointing at a real CS2 installation"]
    fn extracts_real_mirage_mesh_below_roadmap_size_budget() {
        let root = std::path::PathBuf::from(
            std::env::var_os("VIBE_CS2_INSTALL").expect("VIBE_CS2_INSTALL"),
        );
        let archive = crate::VpkArchive::open(root.join("game/csgo/maps/de_mirage.vpk")).unwrap();
        let bytes = archive.read("maps/de_mirage/world_physics.vmdl_c").unwrap();
        let geometry = extract_world_geometry(&bytes).unwrap();
        assert!(geometry.triangles.len() > 10_000);
        assert!(geometry.excluded_shapes > 0);
        assert!((geometry.vertices.len() + geometry.triangles.len()) * 12 < 10_000_000);
        assert!(
            geometry
                .triangles
                .iter()
                .flatten()
                .all(|index| (*index as usize) < geometry.vertices.len())
        );
    }
}
