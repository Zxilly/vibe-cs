//! Camera queries over the same filtered VMAP geometry used by the renderer.
//! Open mesh surfaces only support distance/ray queries. VMAP retains original
//! convex physics solids separately so rooms and holes are not called interiors.
use parry3d::{
    bounding_volume::Aabb,
    math::Vector,
    query::{PointQuery, Ray, RayCast},
    shape::{ConvexPolyhedron, Shape, TriMesh},
};
use vibe_cs_application::CameraPoseDiagnostic;
use vibe_cs_domain::{DomainError, ReplayFrame};
use vibe_cs_hlae::CameraSample;
use vibe_cs_source_assets::MapGeometry;

const WALL_CLEARANCE: f32 = 16.0;
const RAY_ENDPOINT_MARGIN: f32 = 0.125;

/// Resident acceleration structure. Construction happens once per map revision.
#[derive(Debug)]
pub struct CameraGeometry {
    mesh: TriMesh,
    solids: Vec<(Aabb, ConvexPolyhedron)>,
}

impl CameraGeometry {
    /// Builds a BVH over decoded, validated Source-coordinate geometry.
    ///
    /// # Errors
    /// Rejects an empty or invalid mesh.
    pub fn new(geometry: MapGeometry) -> Result<Self, DomainError> {
        if geometry
            .vertices
            .iter()
            .flatten()
            .any(|value| !value.is_finite())
            || geometry
                .triangles
                .iter()
                .flatten()
                .any(|index| *index as usize >= geometry.vertices.len())
            || geometry
                .convex_solids
                .iter()
                .flatten()
                .any(|index| *index as usize >= geometry.vertices.len())
        {
            return Err(DomainError::InvalidInput(
                "camera geometry contains an invalid vertex or index".to_owned(),
            ));
        }
        let solids = geometry
            .convex_solids
            .iter()
            .filter_map(|indices| {
                let vertices = indices
                    .iter()
                    .map(|index| Vector::from_array(geometry.vertices[*index as usize]))
                    .collect::<Vec<_>>();
                // Quantization can collapse a thin hull to a plane. It still exists
                // in the surface BVH, but has no three-dimensional interior.
                ConvexPolyhedron::from_convex_hull(&vertices)
                    .filter(|solid| solid.mass_properties(1.0).mass() > 0.0)
                    .map(|solid| (solid.local_aabb(), solid))
            })
            .collect();
        let mesh = TriMesh::new(
            geometry
                .vertices
                .into_iter()
                .map(Vector::from_array)
                .collect(),
            geometry.triangles,
        )
        .map_err(|error| DomainError::InvalidInput(format!("camera geometry: {error}")))?;
        Ok(Self { mesh, solids })
    }

    fn inside_solid(&self, position: Vector) -> bool {
        self.solids.iter().any(|(bounds, solid)| {
            bounds.contains_local_point(position)
                && solid.faces().iter().all(|face| {
                    let vertex = solid.vertices_adj_to_face()[face.first_vertex_or_edge as usize];
                    // Use convex half-spaces directly: support-map GJK can miss
                    // thin, translated hull interiors. Subtract a face vertex first
                    // to avoid cancellation in n.dot(world_position) - plane_offset.
                    face.normal.dot(position - solid.points()[vertex as usize]) <= 0.0
                })
        })
    }

    fn occluded(&self, start: Vector, end: Vector) -> bool {
        let delta = end - start;
        let distance = delta.length();
        if distance <= 2.0 * RAY_ENDPOINT_MARGIN {
            return false;
        }
        let direction = delta / distance;
        let ray = Ray::new(start + direction * RAY_ENDPOINT_MARGIN, direction);
        self.mesh
            .cast_local_ray(&ray, distance - 2.0 * RAY_ENDPOINT_MARGIN, false)
            .is_some()
    }

    /// Queries Rust campath poses without independently interpolating the camera.
    /// Replay targets interpolate only across adjacent observations up to 32 ticks
    /// apart, never through a missing/dead player or a long network-data gap.
    /// `aspect_ratio` is the intended capture width divided by height. Source FOV
    /// is the horizontal angle at 4:3, with horizontal expansion at wider aspects.
    ///
    /// # Errors
    /// Rejects an invalid capture aspect ratio.
    pub fn diagnose(
        &self,
        samples: &[CameraSample],
        frames: &[ReplayFrame],
        player_id: &str,
        aspect_ratio: f64,
    ) -> Result<Vec<CameraPoseDiagnostic>, DomainError> {
        if !aspect_ratio.is_finite() || !(0.25..=8.0).contains(&aspect_ratio) {
            return Err(DomainError::InvalidInput(
                "invalid camera aspect ratio".to_owned(),
            ));
        }
        let mut previous = None;
        Ok(samples
            .iter()
            .map(|sample| {
                let position = camera_position(sample);
                let projected = self.mesh.project_local_point(position, false);
                let distance = (projected.point - position).length();
                let crossed_surface = previous.is_some_and(|start| self.occluded(start, position));
                previous = Some(position);
                let target = target_at(frames, player_id, sample.tick);
                CameraPoseDiagnostic {
                    time_seconds: sample.time_seconds,
                    tick: sample.tick,
                    wall_distance: f64::from(distance),
                    near_wall: distance < WALL_CLEARANCE,
                    inside_solid: self.inside_solid(position),
                    crossed_surface,
                    head_occluded: target.map(|points| self.occluded(position, points[0])),
                    chest_occluded: target.map(|points| self.occluded(position, points[1])),
                    target_in_view: target.map(|points| {
                        points
                            .into_iter()
                            .any(|point| in_view(sample, point, aspect_ratio))
                    }),
                }
            })
            .collect())
    }
}

// VMAP already represents Source coordinates as f32. Camera and replay values
// originate from the same bounded world coordinates; narrowing matches the BVH.
#[allow(clippy::cast_possible_truncation)]
fn camera_position(sample: &CameraSample) -> Vector {
    Vector::new(
        sample.position.x as f32,
        sample.position.y as f32,
        sample.position.z as f32,
    )
}

#[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
fn target_at(frames: &[ReplayFrame], player_id: &str, tick: f64) -> Option<[Vector; 2]> {
    let next = frames.partition_point(|frame| (frame.tick as f64) < tick);
    let right = frames.get(next)?;
    // partition_point chose the first observation at or after this tick.
    let left = if right.tick as f64 <= tick {
        right
    } else {
        frames.get(next.checked_sub(1)?)?
    };
    if right.tick - left.tick > 32 {
        return None;
    }
    let find = |frame: &ReplayFrame| {
        frame
            .players
            .iter()
            .find(|player| player.id == player_id && player.alive)
            .map(|player| {
                let feet = Vector::from_array(player.position.map(|value| value as f32));
                let crouched = player.input.is_some_and(|input| input.crouch);
                [
                    feet + Vector::Z * if crouched { 46.0 } else { 64.0 },
                    feet + Vector::Z * if crouched { 32.0 } else { 48.0 },
                ]
            })
    };
    let from = find(left)?;
    let to = find(right)?;
    let weight = if left.tick == right.tick {
        0.0
    } else {
        ((tick - left.tick as f64) / (right.tick - left.tick) as f64) as f32
    };
    Some([from[0].lerp(to[0], weight), from[1].lerp(to[1], weight)])
}

fn in_view(sample: &CameraSample, point: Vector, aspect_ratio: f64) -> bool {
    let [x, y, z, w] = sample.quaternion;
    let delta = [
        f64::from(point.x) - sample.position.x,
        f64::from(point.y) - sample.position.y,
        f64::from(point.z) - sample.position.z,
    ];
    // Dot with the quaternion's rotated Source +X forward, +Y left and +Z up.
    let forward = [
        1.0 - 2.0 * (y * y + z * z),
        2.0 * (x * y + z * w),
        2.0 * (x * z - y * w),
    ];
    let left = [
        2.0 * (x * y - z * w),
        1.0 - 2.0 * (x * x + z * z),
        2.0 * (y * z + x * w),
    ];
    let up = [
        2.0 * (x * z + y * w),
        2.0 * (y * z - x * w),
        1.0 - 2.0 * (x * x + y * y),
    ];
    let dot = |axis: [f64; 3]| axis.into_iter().zip(delta).map(|(a, b)| a * b).sum::<f64>();
    let depth = dot(forward);
    let vertical = (sample.fov.to_radians() * 0.5).tan() / (4.0 / 3.0);
    depth > 0.0
        && dot(left).abs() <= depth * vertical * aspect_ratio
        && dot(up).abs() <= depth * vertical
}

#[cfg(test)]
mod tests {
    use super::*;
    use vibe_cs_hlae::CameraPosition;

    fn wall() -> CameraGeometry {
        CameraGeometry::new(MapGeometry {
            vertices: vec![
                [0.0, -100.0, -100.0],
                [0.0, 100.0, -100.0],
                [0.0, 100.0, 100.0],
                [0.0, -100.0, 100.0],
            ],
            triangles: vec![[0, 1, 2], [0, 2, 3]],
            ..MapGeometry::default()
        })
        .unwrap()
    }

    #[test]
    fn detects_solid_interior_far_from_surfaces_without_filling_open_meshes_or_bounds() {
        let source = MapGeometry {
            vertices: vec![
                [0.0, 0.0, 0.0],
                [128.0, 0.0, 0.0],
                [0.0, 128.0, 0.0],
                [0.0, 0.0, 128.0],
            ],
            triangles: vec![[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]],
            convex_solids: vec![vec![0, 1, 2, 3]],
            ..MapGeometry::default()
        };
        let geometry = CameraGeometry::new(source).unwrap();
        let mut sample = pose(32.0);
        sample.position.y = 32.0;
        sample.position.z = 32.0;
        let diagnostics = geometry
            .diagnose(&[sample], &[], "missing", 16.0 / 9.0)
            .unwrap();
        assert!(diagnostics[0].inside_solid);
        assert!(!diagnostics[0].near_wall);
        assert!(diagnostics[0].wall_distance > 16.0);
        assert!(!diagnostics[0].crossed_surface);
        // Inside its bounding box, but outside the tetrahedron.
        assert!(!geometry.inside_solid(Vector::splat(80.0)));
        assert!(!geometry.inside_solid(Vector::splat(-32.0)));
        assert!(!wall().inside_solid(Vector::new(-32.0, 0.0, 0.0)));
        assert!(!wall().inside_solid(Vector::new(32.0, 0.0, 0.0)));
    }

    #[test]
    fn collapsed_solids_have_no_interior_and_invalid_membership_is_rejected() {
        let mut source = MapGeometry {
            vertices: vec![[0.0, 0.0, 0.0], [128.0, 0.0, 0.0], [0.0, 128.0, 0.0]],
            triangles: vec![[0, 1, 2]],
            convex_solids: vec![vec![0, 1, 2]],
            ..MapGeometry::default()
        };
        source.convex_solids[0].push(3);
        assert!(CameraGeometry::new(source).is_err());
        let geometry = CameraGeometry::new(MapGeometry {
            vertices: vec![[0.0, 0.0, 0.0], [128.0, 0.0, 0.0], [0.0, 128.0, 0.0]],
            triangles: vec![[0, 1, 2]],
            convex_solids: vec![vec![0, 1, 2]],
            ..MapGeometry::default()
        })
        .unwrap();
        assert!(geometry.solids.is_empty());
        assert!(!geometry.inside_solid(Vector::new(16.0, 16.0, 1.0)));
        assert!(!geometry.inside_solid(Vector::new(16.0, 16.0, -1.0)));
    }

    fn pose(x: f64) -> CameraSample {
        CameraSample {
            time_seconds: 0.0,
            tick: 100.0,
            position: CameraPosition { x, y: 0.0, z: 0.0 },
            quaternion: [0.0, 0.0, 0.0, 1.0],
            fov: 90.0,
        }
    }

    #[test]
    fn rays_are_segments_and_query_both_sides_of_open_walls() {
        let map = wall();
        assert!(map.occluded(Vector::new(-50.0, 0.0, 0.0), Vector::new(50.0, 0.0, 0.0)));
        assert!(map.occluded(Vector::new(50.0, 0.0, 0.0), Vector::new(-50.0, 0.0, 0.0)));
        assert!(!map.occluded(Vector::new(-50.0, 0.0, 0.0), Vector::new(-20.0, 0.0, 0.0)));
        assert!(!map.occluded(
            Vector::new(-50.0, 200.0, 0.0),
            Vector::new(50.0, 200.0, 0.0)
        ));
        let result = map
            .diagnose(
                &[pose(-16.0), pose(-15.0), pose(20.0)],
                &[],
                "missing",
                16.0 / 9.0,
            )
            .unwrap();
        assert!(!result[0].near_wall);
        assert!(result[1].near_wall);
        assert!(result[2].crossed_surface);
        assert_eq!(result[2].head_occluded, None);
        assert_eq!(result[2].target_in_view, None);
    }

    #[test]
    fn source_axes_and_widescreen_frustum_are_consistent() {
        let mut camera = pose(0.0);
        assert!(in_view(&camera, Vector::new(100.0, 0.0, 0.0), 4.0 / 3.0));
        assert!(!in_view(&camera, Vector::new(-100.0, 0.0, 0.0), 4.0 / 3.0));
        assert!(!in_view(&camera, Vector::new(100.0, 120.0, 0.0), 4.0 / 3.0));
        assert!(in_view(&camera, Vector::new(100.0, 120.0, 0.0), 16.0 / 9.0));
        assert!(!in_view(&camera, Vector::new(100.0, 0.0, 80.0), 16.0 / 9.0));
        camera.quaternion = [
            0.0,
            0.0,
            std::f64::consts::FRAC_1_SQRT_2,
            std::f64::consts::FRAC_1_SQRT_2,
        ];
        assert!(in_view(&camera, Vector::new(0.0, 100.0, 0.0), 16.0 / 9.0));
        assert!(!in_view(&camera, Vector::new(100.0, 0.0, 0.0), 16.0 / 9.0));
    }

    fn frame(tick: u64, x: f64) -> ReplayFrame {
        ReplayFrame {
            tick,
            players: vec![vibe_cs_domain::ReplayPlayer {
                id: "target".to_owned(),
                name: "Target".to_owned(),
                team: "T".to_owned(),
                position: [x, 0.0, 0.0],
                yaw: 0.0,
                pitch: 0.0,
                health: 100,
                armor: 0,
                alive: true,
                weapon: String::new(),
                input: None,
            }],
            projectiles: vec![],
            bomb: None,
        }
    }

    #[test]
    fn observed_targets_interpolate_without_fabricating_missing_or_dead_players() {
        let mut frames = vec![frame(100, 20.0), frame(116, 36.0)];
        assert_eq!(
            target_at(&frames, "target", 108.0).unwrap()[0],
            Vector::new(28.0, 0.0, 64.0)
        );
        let result = wall()
            .diagnose(&[pose(-50.0)], &frames, "target", 16.0 / 9.0)
            .unwrap();
        assert_eq!(result[0].head_occluded, Some(true));
        assert_eq!(result[0].chest_occluded, Some(true));
        assert_eq!(result[0].target_in_view, Some(true));
        assert!(target_at(&frames, "target", 99.0).is_none());
        assert!(target_at(&frames, "target", 117.0).is_none());
        frames[1].players[0].alive = false;
        assert!(target_at(&frames, "target", 108.0).is_none());
        frames[1].players.clear();
        assert!(target_at(&frames, "target", 108.0).is_none());
        frames[1] = frame(140, 60.0);
        assert!(target_at(&frames, "target", 108.0).is_none());
    }

    #[test]
    fn invalid_geometry_returns_an_error_before_entering_the_bvh_builder() {
        let mut geometry = MapGeometry {
            vertices: vec![[0.0; 3]],
            triangles: vec![[0, 1, 2]],
            ..MapGeometry::default()
        };
        assert!(CameraGeometry::new(geometry).is_err());
        geometry = MapGeometry {
            vertices: vec![[f32::NAN; 3]],
            triangles: vec![[0, 0, 0]],
            ..MapGeometry::default()
        };
        assert!(CameraGeometry::new(geometry).is_err());
        assert!(CameraGeometry::new(MapGeometry::default()).is_err());
    }

    #[test]
    #[ignore = "requires real Mirage VIBE_MAP_GEOMETRY and VIBE_ALIGNMENT_SAMPLES"]
    #[allow(clippy::cast_precision_loss, clippy::cast_possible_truncation)]
    fn real_mirage_solid_centers_and_demo_player_heads_are_distinct() {
        let bytes = std::fs::read(std::env::var_os("VIBE_MAP_GEOMETRY").unwrap()).unwrap();
        let source = vibe_cs_source_assets::decode_map_geometry(&bytes).unwrap();
        let original_count = source.convex_solids.len();
        let started = std::time::Instant::now();
        let map = CameraGeometry::new(source).unwrap();
        assert!(map.solids.len() > 1_000);
        let build_ms = started.elapsed().as_millis();
        let mut deep = 0;
        for (_, solid) in &map.solids {
            let center =
                solid.points().iter().copied().sum::<Vector>() / solid.points().len() as f32;
            let mut sample = pose(f64::from(center.x));
            sample.position.y = f64::from(center.y);
            sample.position.z = f64::from(center.z);
            let result = map.diagnose(&[sample], &[], "none", 16.0 / 9.0).unwrap();
            assert!(
                result[0].inside_solid,
                "solid center {center:?}; volume={}; points={:?}; contains={}",
                solid.mass_properties(1.0).mass(),
                solid.points(),
                solid.contains_local_point(center)
            );
            if !result[0].near_wall {
                deep += 1;
            }
        }
        assert!(
            deep > 0,
            "fixture must contain interiors farther than the clearance threshold"
        );
        let evidence: serde_json::Value = serde_json::from_slice(
            &std::fs::read(std::env::var_os("VIBE_ALIGNMENT_SAMPLES").unwrap()).unwrap(),
        )
        .unwrap();
        let samples = evidence["samples"].as_array().unwrap();
        assert!(samples.len() >= 32);
        for sample in samples {
            let p = &sample["position"];
            let height = if sample["flags"].as_u64().unwrap() & 2 != 0 {
                46.0
            } else {
                64.0
            };
            let head = Vector::new(
                p[0].as_f64().unwrap() as f32,
                p[1].as_f64().unwrap() as f32,
                p[2].as_f64().unwrap() as f32 + height,
            );
            assert!(
                !map.inside_solid(head),
                "observed player head at tick {}: {head:?}",
                sample["tick"]
            );
        }
        eprintln!(
            "Mirage original_solids={original_count} volumetric_solids={} deep_centers={deep} player_heads={} build_ms={build_ms}",
            map.solids.len(),
            samples.len()
        );
    }

    #[test]
    #[ignore = "requires VIBE_CAMERA_SAMPLES_JSON, VIBE_DENSE_REPLAY_JSON and VIBE_MAP_GEOMETRY"]
    fn real_major_camera_paths_are_queried_against_real_mirage_geometry() {
        #[derive(serde::Deserialize)]
        struct Probe {
            samples: Vec<CameraSample>,
            shot: vibe_cs_hlae::CameraShot,
        }
        let read = |name| std::fs::read(std::env::var(name).unwrap()).unwrap();
        let geometry =
            vibe_cs_source_assets::decode_map_geometry(&read("VIBE_MAP_GEOMETRY")).unwrap();
        let start = std::time::Instant::now();
        let map = CameraGeometry::new(geometry).unwrap();
        eprintln!("real Mirage BVH: {} ms", start.elapsed().as_millis());
        let replay: vibe_cs_domain::ReplayArtifact =
            serde_json::from_slice(&read("VIBE_DENSE_REPLAY_JSON")).unwrap();
        let probes: Vec<Probe> = serde_json::from_slice(&read("VIBE_CAMERA_SAMPLES_JSON")).unwrap();
        let player_id = &replay
            .frames
            .iter()
            .flat_map(|frame| &frame.players)
            .find(|player| player.name == "FalleN")
            .unwrap()
            .id;
        let mut output = Vec::new();
        for probe in probes {
            let start = std::time::Instant::now();
            let diagnostics = map
                .diagnose(&probe.samples, &replay.frames, player_id, 16.0 / 9.0)
                .unwrap();
            let near = diagnostics.iter().filter(|item| item.near_wall).count();
            let crossed = diagnostics
                .iter()
                .filter(|item| item.crossed_surface)
                .count();
            let hidden = diagnostics
                .iter()
                .filter(|item| {
                    item.head_occluded == Some(true) && item.chest_occluded == Some(true)
                })
                .count();
            let outside = diagnostics
                .iter()
                .filter(|item| item.target_in_view == Some(false))
                .count();
            eprintln!(
                "{}: {} poses; near={near}, crossed={crossed}, hidden={hidden}, outside={outside}, {} ms",
                probe.shot.id,
                diagnostics.len(),
                start.elapsed().as_millis()
            );
            assert_eq!(diagnostics.len(), probe.samples.len());
            assert!(
                diagnostics
                    .iter()
                    .all(|item| item.wall_distance.is_finite())
            );
            assert!(diagnostics.iter().all(|item| item.head_occluded.is_some()));
            output.push(serde_json::json!({"shot": probe.shot, "diagnostics": diagnostics}));
        }
        if let Ok(path) = std::env::var("VIBE_CAMERA_DIAGNOSTICS_OUTPUT") {
            std::fs::write(path, serde_json::to_vec_pretty(&output).unwrap()).unwrap();
        }
    }
}
