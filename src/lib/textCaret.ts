import { clientPointToFraction, rotateFraction, unrotateFraction } from "@/lib/annotationGeometry"

export type TextCaret = { node: Text; offset: number }
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" })
const measured = new WeakMap<Text, {
  text: string
  rotation: number
  boundaries: number[]
  positions?: { offset: number; x: number }[]
}>()

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null
  caretRangeFromPoint?: (x: number, y: number) => Range | null
}

/** Constrain native caret lookup to the chosen run's interior. The browser
    knows resolved bidi direction (including digits and neutral characters),
    whereas a character's Unicode block cannot tell us its visual direction. */
export function caretInTextRun(span: HTMLElement, inline: number, rotation: number): TextCaret | null {
  const node = span.firstChild
  if (!(node instanceof Text)) return null
  const box = span.getBoundingClientRect()
  let cached = measured.get(node)
  if (!cached || cached.text !== node.data || cached.rotation !== rotation) {
    cached = {
      text: node.data,
      rotation,
      boundaries: [...graphemes.segment(node.data)].map(part => part.index).concat(node.length),
    }
    measured.set(node, cached)
  }
  // Stay just inside the run at its visual midline, including at line ends.
  const fraction = rotateFraction({ x: Math.max(0.0001, Math.min(0.9999, inline)), y: 0.5 }, rotation)
  const x = box.left + fraction.x * box.width
  const y = box.top + fraction.y * box.height
  const owner = span.ownerDocument as CaretDocument
  const position = owner.caretPositionFromPoint?.(x, y)
  const range = position ? null : owner.caretRangeFromPoint?.(x, y)
  const nativeNode = position?.offsetNode ?? range?.startContainer
  const nativeOffset = position?.offset ?? range?.startOffset
  if (nativeNode === node && nativeOffset !== undefined) {
    const offset = cached.boundaries.reduce((best, next) =>
      Math.abs(next - nativeOffset) < Math.abs(best - nativeOffset) ? next : best,
    )
    return { node, offset }
  }

  // Offscreen text or an overlapping element can make native lookup miss the
  // chosen run. Measure collapsed carets, not glyph edges with guessed RTL.
  // Fractions survive translation/zoom; rotation and changed text invalidate.
  if (!cached.positions) {
    const range = owner.createRange()
    cached.positions = cached.boundaries.flatMap(offset => {
      range.setStart(node, offset)
      range.collapse(true)
      const rect = range.getClientRects()[0]
      if (!rect) return []
      const fraction = clientPointToFraction(box, rect.left + rect.width / 2, rect.top + rect.height / 2)
      return [{ offset, x: unrotateFraction(fraction, rotation).x }]
    })
  }
  if (!cached.positions.length) return null
  const best = cached.positions.reduce((best, next) =>
    Math.abs(next.x - inline) < Math.abs(best.x - inline) ? next : best,
  )
  return { node, offset: best.offset }
}
