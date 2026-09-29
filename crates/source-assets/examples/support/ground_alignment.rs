use super::MapGeometry;

pub(super) fn ground_below(
    geometry: &MapGeometry,
    point: [f64; 3],
    half_width: f64,
) -> Option<f64> {
    let mut highest: Option<f64> = None;
    for triangle in &geometry.triangles {
        let [a, b, c] = triangle.map(|index| geometry.vertices[index as usize].map(f64::from));
        let normal = [
            (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
            (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
            (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
        ];
        let magnitude = normal.iter().map(|value| value * value).sum::<f64>().sqrt();
        if magnitude == 0.0 || normal[2].abs() / magnitude < 0.7 {
            continue;
        }
        let mut polygon = vec![a, b, c];
        for axis in 0..2 {
            for (boundary, sign) in [
                (point[axis] - half_width, 1.0),
                (point[axis] + half_width, -1.0),
            ] {
                if polygon.is_empty() {
                    break;
                }
                let mut clipped = Vec::new();
                let mut previous = *polygon.last().unwrap();
                for vertex in &polygon {
                    let before = (previous[axis] - boundary) * sign;
                    let after = (vertex[axis] - boundary) * sign;
                    if (before >= 0.0) != (after >= 0.0) {
                        let t = before / (before - after);
                        clipped.push(std::array::from_fn(|dimension| {
                            previous[dimension] + t * (vertex[dimension] - previous[dimension])
                        }));
                    }
                    if after >= 0.0 {
                        clipped.push(*vertex);
                    }
                    previous = *vertex;
                }
                polygon = clipped;
            }
        }
        let Some(z) = polygon
            .iter()
            .map(|vertex| vertex[2])
            .max_by(f64::total_cmp)
        else {
            continue;
        };
        if z <= point[2] + 16.0 && highest.is_none_or(|current| z > current) {
            highest = Some(z);
        }
    }
    highest
}
