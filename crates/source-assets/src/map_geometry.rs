//! Static world collision geometry, in Source coordinates (Z up, game units).
//! Physics shape layout follows `ValveResourceFormat` `RubikonPhysics` at the
//! revision cited by `kv3`; see ../licenses/ValveResourceFormat-MIT.txt.
use std::collections::HashMap;

use crate::{Kv3Value, Result, SourceAssetError, decode_physics_kv3};

const MAX_TRIANGLES: usize = 2_000_000;
const QUANTIZATION: f32 = 16.0;

#[derive(Debug, Default)]
pub struct MapGeometry {
    pub vertices: Vec<[f32; 3]>,
    pub triangles: Vec<[u32; 3]>,
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

// Collision geometry approximates visibility: tool clips, sky, and transparent
// windows do not form occluders. Unknown tag sets fail explicitly, so a game
// update cannot silently produce an apparently complete but empty map.
fn is_occluder(attribute: &Kv3Value) -> Result<bool> {
    let tags = array(field(attribute, "m_InteractAsStrings")?)?;
    if tags.is_empty() {
        return Ok(true);
    }
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
        ) {
            return Err(invalid(format!("unknown world collision tag {tag:?}")));
        }
    }
    Ok(false)
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
    let mut builder = Builder::default();
    for part in array(field(root, "m_parts")?)? {
        let shape = field(part, "m_rnShape")?;
        for name in ["m_spheres", "m_capsules"] {
            if !array(field(shape, name)?)?.is_empty() {
                return Err(invalid(format!("world {name} are not supported")));
            }
        }
        for (collection, key) in [("m_meshes", "m_Mesh"), ("m_hulls", "m_Hull")] {
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
                    for bytes in blob(data, "m_Triangles", 12)?.chunks_exact(12) {
                        let indices = std::array::from_fn(|axis| {
                            u32::from_le_bytes(bytes[axis * 4..axis * 4 + 4].try_into().unwrap())
                                as usize
                        });
                        builder.triangle(&vertices, indices)?;
                    }
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
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use super::*;

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
