import type { TextNotePreview as HeldNote } from "@/hooks/useTextNoteTool"
import {
  noteAscentRatio,
  noteFontFamily,
  TEXT_NOTE_LINE_HEIGHT,
} from "@/lib/textNoteLayout"

type TextNotePreviewProps = {
  layoutHeight: number
  layoutWidth: number
  note: HeldNote
}

/** A written note standing in for its pixels. SVG because only a `<text>` puts
    a baseline exactly where `add_text_note` places lines; CSS adds half-leading. */
export function TextNotePreview({
  layoutHeight,
  layoutWidth,
  note,
}: TextNotePreviewProps) {
  const { origin, style, text } = note
  const ascent = noteAscentRatio(text) * style.fontSize
  const family = noteFontFamily(text)

  return (
    <svg
      aria-hidden
      className="absolute inset-0 size-full"
      data-slot="text-note-preview"
      // Stretched, not fitted: the box is already the page's own shape, so a
      // fit would only letterbox the sub-pixel a rounded layout box is out by.
      preserveAspectRatio="none"
      viewBox={`0 0 ${layoutWidth} ${layoutHeight}`}
    >
      {text.split("\n").map((line, index) =>
        line === "" ? null : (
          <text
            fill={style.color}
            fillOpacity={style.opacity}
            fontFamily={family}
            fontSize={style.fontSize}
            key={index}
            x={origin.left}
            // A reader clicks where the text starts, so the origin is its top;
            // lines then step by the baseline, as the backend steps them.
            y={
              origin.top +
              ascent +
              index * style.fontSize * TEXT_NOTE_LINE_HEIGHT
            }
            xmlSpace="preserve"
          >
            {line}
          </text>
        ),
      )}
    </svg>
  )
}
