//! Interior queries for certified closed, possibly concave physics mesh shells.
use parry3d::{bounding_volume::Aabb, math::Vector};
use vibe_cs_domain::DomainError;
use vibe_cs_source_assets::{MapGeometry, closed_triangle_components};

#[derive(Debug)]
struct Shell {
    bounds: Aabb,
    // Retain exact VMAP f32 coordinates; widen only queried candidates rather
    // than keeping a second double-sized copy of large closed meshes.
    triangles: Vec<[[f32; 3]; 3]>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::CameraGeometry;
    use parry3d::query::PointQuery;

    fn prism(polygon: &[[f32; 2]], faces: &[[u32; 3]], low: f32, high: f32) -> MapGeometry {
        let count = u32::try_from(polygon.len()).unwrap();
        let vertices = [low, high]
            .into_iter()
            .flat_map(|z| polygon.iter().map(move |&[x, y]| [x, y, z]))
            .collect();
        let mut triangles = Vec::new();
        for &[a, b, c] in faces {
            triangles.push([c, b, a]);
            triangles.push([a + count, b + count, c + count]);
        }
        for a in 0..count {
            let b = (a + 1) % count;
            triangles.extend([[a, b, b + count], [a, b + count, a + count]]);
        }
        let closed_meshes = vec![(0..u32::try_from(triangles.len()).unwrap()).collect()];
        MapGeometry {
            vertices,
            triangles,
            closed_meshes,
            ..MapGeometry::default()
        }
    }

    fn cube(low: f32, high: f32) -> MapGeometry {
        prism(
            &[[low, low], [high, low], [high, high], [low, high]],
            &[[0, 1, 2], [0, 2, 3]],
            low,
            high,
        )
    }

    #[test]
    fn concave_mesh_does_not_fill_its_empty_arm_or_require_a_nearby_wall() {
        let source = prism(
            &[
                [0.0, 0.0],
                [192.0, 0.0],
                [192.0, 64.0],
                [64.0, 64.0],
                [64.0, 192.0],
                [0.0, 192.0],
            ],
            &[[0, 1, 3], [1, 2, 3], [0, 3, 5], [3, 4, 5]],
            0.0,
            128.0,
        );
        let map = CameraGeometry::new(source).unwrap();
        for point in [[32.0, 96.0, 64.0], [96.0, 32.0, 64.0], [32.0, 32.0, 64.0]] {
            assert!(map.inside_solid(Vector::from_array(point)), "{point:?}");
            assert!(
                map.mesh
                    .distance_to_local_point(Vector::from_array(point), false)
                    > 16.0
            );
        }
        for point in [[96.0, 96.0, 64.0], [32.0, 32.0, 160.0], [-1.0, 32.0, 64.0]] {
            assert!(!map.inside_solid(Vector::from_array(point)), "{point:?}");
        }
    }

    #[test]
    fn inward_shell_keeps_a_cavity_and_overlapping_outward_shells_stay_solid() {
        for cavity in [true, false] {
            let mut source = cube(0.0, 256.0);
            let inner = cube(64.0, 192.0);
            let vertex_offset = u32::try_from(source.vertices.len()).unwrap();
            source.vertices.extend(inner.vertices);
            source
                .triangles
                .extend(inner.triangles.into_iter().map(|mut triangle| {
                    if cavity {
                        triangle.swap(0, 1);
                    }
                    triangle.map(|index| index + vertex_offset)
                }));
            source.closed_meshes =
                vec![(0..u32::try_from(source.triangles.len()).unwrap()).collect()];
            let map = CameraGeometry::new(source).unwrap();
            assert!(map.inside_solid(Vector::splat(32.0)));
            assert_eq!(map.inside_solid(Vector::splat(128.0)), !cavity);
            assert!(!map.inside_solid(Vector::splat(300.0)));
        }
    }

    #[test]
    fn rejects_untrusted_membership_that_does_not_describe_closed_shells() {
        let mut source = cube(0.0, 128.0);
        source.closed_meshes[0].pop();
        assert!(CameraGeometry::new(source).is_err());
        let mut source = cube(0.0, 128.0);
        source.closed_meshes[0][0] = u32::MAX;
        assert!(CameraGeometry::new(source).is_err());
    }

    // Independent reference: count oriented ray crossings, rejecting probes
    // that hit a triangle edge. Production uses solid angles, not ray parity.
    fn ray_winding(mesh: &MeshInterior, point: Vector, direction: [f64; 3]) -> Option<bool> {
        let origin = point.to_array().map(f64::from);
        let subtract = |a: [f64; 3], b: [f64; 3]| std::array::from_fn(|axis| a[axis] - b[axis]);
        let cross = |a: [f64; 3], b: [f64; 3]| {
            [
                a[1] * b[2] - a[2] * b[1],
                a[2] * b[0] - a[0] * b[2],
                a[0] * b[1] - a[1] * b[0],
            ]
        };
        let mut winding = 0;
        for triangle in mesh.shells.iter().flat_map(|shell| &shell.triangles) {
            let [a, b, c] = triangle.map(|vertex| vertex.map(f64::from));
            let edge1 = subtract(b, a);
            let edge2 = subtract(c, a);
            let direction_cross = cross(direction, edge2);
            let determinant = dot(edge1, direction_cross);
            if determinant.abs() < 1e-10 {
                continue;
            }
            let offset = subtract(origin, a);
            let bary_u = dot(offset, direction_cross) / determinant;
            let offset_cross = cross(offset, edge1);
            let bary_v = dot(direction, offset_cross) / determinant;
            let distance = dot(edge2, offset_cross) / determinant;
            if distance < -1e-7 || bary_u < -1e-7 || bary_v < -1e-7 || bary_u + bary_v > 1.0 + 1e-7
            {
                continue;
            }
            if distance.abs() < 1e-7
                || bary_u.abs() < 1e-7
                || bary_v.abs() < 1e-7
                || (1.0 - bary_u - bary_v).abs() < 1e-7
            {
                return None;
            }
            winding += if determinant < 0.0 { 1 } else { -1 };
        }
        Some(winding != 0)
    }

    #[test]
    #[ignore = "requires VIBE_CS2_INSTALL with the eight competitive maps"]
    fn real_maps_build_closed_interiors_and_measure_candidate_queries() {
        let install = std::path::PathBuf::from(std::env::var_os("VIBE_CS2_INSTALL").unwrap());
        for name in [
            "de_mirage",
            "de_dust2",
            "de_inferno",
            "de_nuke",
            "de_ancient",
            "de_anubis",
            "de_train",
            "de_overpass",
        ] {
            let archive = vibe_cs_source_assets::VpkArchive::open(
                install.join(format!("game/csgo/maps/{name}.vpk")),
            )
            .unwrap();
            let source = vibe_cs_source_assets::extract_world_geometry(
                &archive
                    .read(&format!("maps/{name}/world_physics.vmdl_c"))
                    .unwrap(),
            )
            .unwrap();
            let started = std::time::Instant::now();
            let interiors = MeshInterior::build(&source).unwrap();
            let build_ms = started.elapsed().as_millis();
            let shells = interiors
                .iter()
                .flat_map(|mesh| &mesh.shells)
                .collect::<Vec<_>>();
            let mut ordered = shells.clone();
            ordered.sort_by_key(|shell| std::cmp::Reverse(shell.triangles.len()));
            let candidates = ordered
                .iter()
                .take(128)
                .map(|shell| shell.bounds.center())
                .collect::<Vec<_>>();
            let started = std::time::Instant::now();
            let inside = candidates
                .iter()
                .filter(|&&point| interiors.iter().any(|mesh| mesh.contains(point)))
                .count();
            eprintln!(
                "{name}: groups={} shells={} max_shell_triangles={} build_ms={build_ms} queries={} inside={inside} query_ms={:.3}",
                interiors.len(),
                shells.len(),
                ordered[0].triangles.len(),
                candidates.len(),
                started.elapsed().as_secs_f64() * 1000.0
            );
            assert!(!interiors.is_empty());
            let mut verified = 0;
            for mesh in &interiors {
                let mut shells = mesh.shells.iter().collect::<Vec<_>>();
                shells.sort_by_key(|shell| std::cmp::Reverse(shell.triangles.len()));
                for shell in shells.into_iter().take(8) {
                    for fraction in [0.31, 0.53, 0.79] {
                        let point =
                            shell.bounds.mins + (shell.bounds.maxs - shell.bounds.mins) * fraction;
                        let reference = [
                            [1.0, 0.371, 0.529],
                            [0.213, 1.0, 0.727],
                            [0.613, 0.317, 1.0],
                        ]
                        .into_iter()
                        .find_map(|direction| ray_winding(mesh, point, direction));
                        if let Some(reference) = reference {
                            assert_eq!(mesh.contains(point), reference, "{name} point={point:?}");
                            verified += 1;
                        }
                    }
                }
            }
            assert!(
                verified >= 16,
                "insufficient non-grazing reference probes: {name}"
            );
            eprintln!(
                "{name}: independent oriented-ray agreement at {verified} non-grazing probes"
            );
        }
    }
}

#[derive(Debug)]
pub(super) struct MeshInterior {
    shells: Vec<Shell>,
}

impl MeshInterior {
    pub(super) fn build(geometry: &MapGeometry) -> Result<Vec<Self>, DomainError> {
        geometry
            .closed_meshes
            .iter()
            .map(|membership| {
                let triangles = membership
                    .iter()
                    .map(|&index| {
                        geometry
                            .triangles
                            .get(index as usize)
                            .copied()
                            .ok_or_else(|| {
                                DomainError::InvalidInput(
                                    "closed mesh triangle outside table".to_owned(),
                                )
                            })
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                let components = closed_triangle_components(&triangles);
                if triangles.is_empty()
                    || components.iter().map(Vec::len).sum::<usize>() != triangles.len()
                {
                    return Err(DomainError::InvalidInput(
                        "camera mesh interior requires closed oriented shells".to_owned(),
                    ));
                }
                let shells = components
                    .into_iter()
                    .map(|component| {
                        let mut bounds = Aabb::new_invalid();
                        let triangles = component
                            .into_iter()
                            .map(|index| {
                                triangles[index].map(|vertex| {
                                    let point =
                                        Vector::from_array(geometry.vertices[vertex as usize]);
                                    bounds.take_point(point);
                                    point.to_array()
                                })
                            })
                            .collect();
                        Shell { bounds, triangles }
                    })
                    .collect();
                Ok(Self { shells })
            })
            .collect()
    }

    pub(super) fn contains(&self, position: Vector) -> bool {
        let point = position.to_array().map(f64::from);
        // A closed shell's winding is zero outside its AABB. Sum signed solid
        // angles in f64 inside candidate bounds. Unlike a convex hull or nearest
        // face sign, this retains concavities, inward cavity shells and overlapping
        // outward shells. Source mesh groups remain independent solids.
        let angle: f64 = self
            .shells
            .iter()
            .filter(|shell| shell.bounds.contains_local_point(position))
            .flat_map(|shell| &shell.triangles)
            .map(|triangle| {
                let [a, b, c] = triangle.map(|vertex| {
                    std::array::from_fn(|axis| f64::from(vertex[axis]) - point[axis])
                });
                let [la, lb, lc] = [dot(a, a).sqrt(), dot(b, b).sqrt(), dot(c, c).sqrt()];
                let cross = [
                    b[1] * c[2] - b[2] * c[1],
                    b[2] * c[0] - b[0] * c[2],
                    b[0] * c[1] - b[1] * c[0],
                ];
                2.0 * dot(a, cross)
                    .atan2(la * lb * lc + dot(a, b) * lc + dot(b, c) * la + dot(c, a) * lb)
            })
            .sum();
        angle.abs() > std::f64::consts::TAU
    }
}

fn dot(left: [f64; 3], right: [f64; 3]) -> f64 {
    left.into_iter().zip(right).map(|(a, b)| a * b).sum()
}
