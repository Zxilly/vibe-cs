/*
 * Domain layer, 2 of 3 — `domain/map/`: the shared "this layer has no data" node.
 *
 * Every layer needs an empty path, and the one thing it must not do is draw.
 * A heat grid of zero-weight cells, a path of one repeated point, an
 * engagement line of length zero — each of those reads as measured data that
 * happens to be flat, which is the failure the product forbids in as many
 * words: 「不显示虚构百分比」, 「有真实分母时才用进度条」.
 *
 * So the empty rendering is a labelled, empty group. It occupies no pixels and
 * carries the reason as an SVG `<desc>`, which is the native way to describe a
 * graphics node; `role="note"` plus `aria-label` makes the same sentence
 * reachable to a screen reader walking the canvas. `data-layer-state="empty"`
 * gives the tests — and a page that wants to grey a legend row — something
 * exact to match on.
 *
 * A visible 「无数据」 caption is deliberately not drawn here: with four layers
 * stacked, four such captions would pile up in the same corner. Whole-canvas
 * emptiness is `MapCanvas`'s job and it uses `design/data/Empty` for it.
 */

export interface LayerEmptyProps {
  /** Which layer, and why it is empty. Rendered as the node's description. */
  readonly label: string;
  /** Layer id, so a caller can find this exact group. */
  readonly layer: string;
}

export function LayerEmpty({ label, layer }: LayerEmptyProps) {
  return (
    <g role="note" aria-label={label} data-layer={layer} data-layer-state="empty">
      <desc>{label}</desc>
    </g>
  );
}
