//! Connected, closed oriented components of an original physics triangle mesh.
//! Connectivity uses source indices, never coordinate welding across shapes.

/// Return closed oriented triangle chains: every edge has equally many forward
/// and reverse uses. This includes closed shells touching along an edge, which
/// still have a well-defined signed winding. Open or inconsistently wound chains
/// stay surface geometry. The caller retains source grouping for cavity shells.
pub fn closed_triangle_components(triangles: &[[u32; 3]]) -> Vec<Vec<usize>> {
    let mut parents = (0..triangles.len()).collect::<Vec<_>>();
    let mut valid = vec![true; triangles.len()];
    let mut edges = Vec::with_capacity(triangles.len() * 3);
    for (triangle, &[a, b, c]) in triangles.iter().enumerate() {
        for (start, end) in [(a, b), (b, c), (c, a)] {
            edges.push((start.min(end), start.max(end), triangle, start < end));
            if start == end {
                valid[triangle] = false;
            }
        }
    }
    edges.sort_unstable_by_key(|edge| (edge.0, edge.1));
    let mut cursor = 0;
    while cursor < edges.len() {
        let first = edges[cursor];
        let mut end = cursor + 1;
        while end < edges.len() && (edges[end].0, edges[end].1) == (first.0, first.1) {
            end += 1;
        }
        let forward = edges[cursor..end].iter().filter(|edge| edge.3).count();
        let closed = forward * 2 == end - cursor;
        for edge in &edges[cursor..end] {
            let left = root(&mut parents, first.2);
            let right = root(&mut parents, edge.2);
            // A stable minimum root makes output independent of sort tie order.
            parents[left.max(right)] = left.min(right);
            valid[edge.2] &= closed;
        }
        cursor = end;
    }
    let mut components = vec![Vec::new(); triangles.len()];
    let mut closed = vec![true; triangles.len()];
    for (triangle, is_valid) in valid.into_iter().enumerate() {
        let root = root(&mut parents, triangle);
        components[root].push(triangle);
        closed[root] &= is_valid;
    }
    components
        .into_iter()
        .zip(closed)
        .filter_map(|(component, closed)| (closed && component.len() >= 4).then_some(component))
        .collect()
}

fn root(parents: &mut [usize], mut index: usize) -> usize {
    while parents[index] != index {
        parents[index] = parents[parents[index]];
        index = parents[index];
    }
    index
}

#[cfg(test)]
mod tests {
    use super::*;

    const TETRA: [[u32; 3]; 4] = [[0, 2, 1], [0, 1, 3], [0, 3, 2], [1, 2, 3]];

    #[test]
    fn separates_closed_shells_from_open_surfaces_without_merging_shared_vertices() {
        let mut triangles = TETRA.to_vec();
        triangles.extend(
            TETRA.map(|triangle| triangle.map(|index| if index == 0 { 0 } else { index + 3 })),
        );
        triangles.push([7, 8, 9]);
        assert_eq!(
            closed_triangle_components(&triangles),
            vec![vec![0, 1, 2, 3], vec![4, 5, 6, 7]]
        );
    }

    #[test]
    fn rejects_boundaries_unbalanced_edges_and_inconsistent_winding() {
        assert!(closed_triangle_components(&TETRA[..3]).is_empty());
        let mut triangles = TETRA.to_vec();
        triangles.push(TETRA[0]);
        assert!(closed_triangle_components(&triangles).is_empty());
        let mut triangles = TETRA;
        triangles[0].swap(0, 1);
        assert!(closed_triangle_components(&triangles).is_empty());
        assert!(closed_triangle_components(&[[0, 0, 0]; 4]).is_empty());
    }

    #[test]
    fn touching_closed_shells_remain_a_closed_oriented_chain() {
        let mut triangles = TETRA.to_vec();
        triangles.extend(
            TETRA.map(|triangle| triangle.map(|index| if index < 2 { index } else { index + 2 })),
        );
        assert_eq!(
            closed_triangle_components(&triangles),
            vec![(0..8).collect::<Vec<_>>()]
        );
    }

    #[test]
    fn retains_inward_shell_winding_for_cavities() {
        let mut triangles = TETRA;
        for triangle in &mut triangles {
            triangle.swap(0, 1);
        }
        assert_eq!(
            closed_triangle_components(&triangles),
            vec![vec![0, 1, 2, 3]]
        );
    }
}
