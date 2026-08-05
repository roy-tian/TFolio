import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { RefObject } from "react"
import { Check, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { ColorSwatchPicker } from "@/components/ColorSwatchPicker"
import { SliderRow } from "@/components/SliderRow"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  fractionToClientPoint,
  pagePointToFraction,
} from "@/lib/annotationGeometry"
import { ZOOM_PREVIEW_EVENT } from "@/lib/zoom"
import type { TextNoteFontFamily, TextNoteStyle } from "@/lib/annotations"
import {
  isTextNoteFontFamily,
  TEXT_NOTE_MAX_FONT_SIZE,
  TEXT_NOTE_MIN_FONT_SIZE,
  TEXT_NOTE_MIN_OPACITY,
  textNoteFontFamilies,
  textNoteSwatches,
} from "@/lib/annotationStyles"
import { dimensionsForRotation, type PdfPageInfo } from "@/lib/pdf"
import { usesEmbeddedFont, type TextNoteDraft } from "@/lib/textNoteDraft"
import { cn } from "@/lib/utils"

type TextNoteEditorProps = {
  draft: TextNoteDraft
  editorRef: RefObject<HTMLElement | null>
  onCancel: () => void
  onCommit: () => void
  onStyleChange: (style: TextNoteStyle) => void
  onTextChange: (text: string) => void
  page: PdfPageInfo
  rotation: number
  style: TextNoteStyle
  viewerRef: RefObject<HTMLElement | null>
}

/** The gap between the text box and its options, in pixels — Tailwind's `2`. */
const OPTIONS_GAP = 8

/** The editor's own width, in pixels — Tailwind's `w-64`. */
const EDITOR_WIDTH = 256

/** How close the editor may come to the window's edge before it is pulled in. */
const VIEWPORT_MARGIN = 8

/** The CSS the three offered families map to while a note is being typed. */
const previewFontFamily: Record<TextNoteFontFamily, string> = {
  mono: "ui-monospace, monospace",
  sans: "Helvetica, Arial, sans-serif",
  serif: "'Times New Roman', Times, serif",
}

/** Spelled out rather than built from the family: a key assembled at runtime is
    not one the locale schema can check at build time. */
const familyLabelKey: Record<
  TextNoteFontFamily,
  | "annotate.textNoteFont_sans"
  | "annotate.textNoteFont_serif"
  | "annotate.textNoteFont_mono"
> = {
  mono: "annotate.textNoteFont_mono",
  sans: "annotate.textNoteFont_sans",
  serif: "annotate.textNoteFont_serif",
}

/**
 * Where a note is typed, floating over the page at the point it was placed.
 *
 * Rendered in screen space rather than inside the page's own layer, which turns
 * with the page: at 90° a reader would be typing sideways. The cost is that
 * nothing moves it when the page does, so it has to watch for that itself —
 * scrolling, zooming, rotating, and resizing all shift the point it is pinned
 * to.
 */
export function TextNoteEditor({
  draft,
  editorRef,
  onCancel,
  onCommit,
  onStyleChange,
  onTextChange,
  page,
  rotation,
  style,
  viewerRef,
}: TextNoteEditorProps) {
  const { t } = useTranslation()
  const textareaRef = useRef<HTMLTextAreaElement | null>(null)
  const optionsRef = useRef<HTMLDivElement | null>(null)
  // The options sit above the text box, which is where a reader expects them —
  // until the note is near the top of the window and there is no room, and they
  // would be cut off by its edge. Then they go below it instead.
  const [optionsBelow, setOptionsBelow] = useState(false)
  const [placement, setPlacement] = useState<{
    left: number
    pxPerPoint: number
    top: number
  } | null>(null)

  const measure = useCallback(() => {
    const pageElement = viewerRef.current?.querySelector(
      `[data-page-number="${draft.pageNumber}"]`,
    )

    if (!pageElement) {
      setPlacement(null)
      return
    }

    const box = pageElement.getBoundingClientRect()
    const point = fractionToClientPoint(
      box,
      pagePointToFraction(draft.origin, page, rotation),
    )
    // The footprint is the page's box after both rotations, so this is the one
    // scale that holds however the page is turned.
    const footprint = dimensionsForRotation(rotation, page.width, page.height)

    // Held inside the window: placed at a click near an edge the editor would
    // otherwise run off it, taking its confirm and discard buttons with it.
    // Pulled back only as far as it has to be, so it still reads as belonging
    // to the point it was placed at.
    //
    // Defensive, and not covered by a test: every arrangement tried — including
    // a page zoomed well past the viewport — left the editor on screen anyway,
    // because a note's origin is clamped inside the page and the page's own
    // margin then keeps the box in view. Removing this changed nothing that
    // could be measured, so treat it as a guard rather than a fix for a
    // reproduced bug.
    const left = Math.max(
      VIEWPORT_MARGIN,
      Math.min(point.x, window.innerWidth - EDITOR_WIDTH - VIEWPORT_MARGIN),
    )
    const height = editorRef.current?.offsetHeight ?? 0
    const top = Math.max(
      VIEWPORT_MARGIN,
      Math.min(point.y, window.innerHeight - height - VIEWPORT_MARGIN),
    )

    setPlacement({
      left,
      pxPerPoint: footprint.width > 0 ? box.width / footprint.width : 1,
      top,
    })
    setOptionsBelow((optionsRef.current?.offsetHeight ?? 0) + OPTIONS_GAP > top)
  }, [draft.origin, draft.pageNumber, editorRef, page, rotation, viewerRef])

  // Laid out before paint, so the editor never shows for a frame at the wrong
  // place — which at this size would read as a jump.
  useLayoutEffect(measure, [measure])

  useEffect(() => {
    const viewer = viewerRef.current

    if (!viewer) {
      return
    }

    // Capture, because the page scrolls inside the viewer rather than the
    // window: without it a scroll on an inner element would not be heard.
    viewer.addEventListener("scroll", measure, { capture: true, passive: true })
    // Ctrl+wheel previews move the page on the compositor before its layout box
    // is committed. Follow that one lightweight event so the screen-space editor
    // stays pinned to its point throughout the gesture, not only after it ends.
    viewer.addEventListener(ZOOM_PREVIEW_EVENT, measure)
    window.addEventListener("resize", measure)

    // Scrolling moves the page; zooming resizes it, and does so by writing the
    // page's own CSS width — which fires neither of the events above when the
    // page already fits the viewer and its scroll offset stays clamped at zero.
    // Watching the element itself catches every way it can change, rather than
    // a list of the ways it was known to.
    const pageElement = viewer.querySelector(
      `[data-page-number="${draft.pageNumber}"]`,
    )
    const observer = new ResizeObserver(measure)

    if (pageElement) {
      observer.observe(pageElement)
    }

    return () => {
      observer.disconnect()
      viewer.removeEventListener("scroll", measure, { capture: true })
      viewer.removeEventListener(ZOOM_PREVIEW_EVENT, measure)
      window.removeEventListener("resize", measure)
    }
  }, [draft.pageNumber, measure, viewerRef])

  // A note is placed to be typed in, so the caret starts here rather than
  // making the reader click the box they just opened.
  //
  // Keyed to which note this is, not to mounting: placing one while another is
  // open swaps the draft inside a single render, so this editor stays mounted
  // and an effect that ran once would leave every note after the first without
  // a caret.
  useEffect(() => {
    textareaRef.current?.focus()
  }, [draft.pageNumber, draft.origin.left, draft.origin.top])

  if (!placement) {
    return null
  }

  const embedded = usesEmbeddedFont(draft.text)
  // Big enough to type in whatever the note's own size, so a 6pt note is not
  // edited through a slit, while a large one still previews at its real size.
  const previewSize = Math.max(12, style.fontSize * placement.pxPerPoint)

  return (
    <div
      className="fixed z-50"
      ref={editorRef as RefObject<HTMLDivElement>}
      style={{ left: placement.left, top: placement.top }}
    >
      {/* Lifted out of the flow so the text box — not the options beside it —
          starts at the point that was clicked, which is where the note will
          actually be drawn. */}
      <div
        className={cn(
          "absolute flex w-64 flex-col gap-3 rounded-lg border bg-popover p-3 text-popover-foreground shadow-md",
          optionsBelow ? "top-full mt-2" : "bottom-full mb-2",
        )}
        ref={optionsRef}
      >
        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium" id="text-note-color-label">
            {t("annotate.textNoteColor")}
          </p>
          <ColorSwatchPicker
            labelledBy="text-note-color-label"
            onChange={(color) => {
              if (color) {
                onStyleChange({ ...style, color })
              }
            }}
            swatches={textNoteSwatches}
            value={style.color}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <p className="text-xs font-medium" id="text-note-family-label">
            {t("annotate.textNoteFont")}
          </p>
          {/* Disabled the moment the note leaves Latin-1: the bundled face is
              the only one that can draw it, so offering a choice here would be
              offering one the note would not be given. */}
          <ToggleGroup
            aria-labelledby="text-note-family-label"
            disabled={embedded}
            onValueChange={([next]) => {
              // Base UI empties the array when the active item is pressed
              // again, but a note is always drawn in some font.
              if (isTextNoteFontFamily(next)) {
                onStyleChange({ ...style, fontFamily: next })
              }
            }}
            spacing={0}
            value={[style.fontFamily]}
            variant="outline"
          >
            {textNoteFontFamilies.map((family) => (
              <ToggleGroupItem
                className="flex-1 text-xs"
                key={family}
                value={family}
              >
                {t(familyLabelKey[family])}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
          {embedded ? (
            <p className="text-xs text-muted-foreground">
              {t("annotate.textNoteFontFixed")}
            </p>
          ) : null}
        </div>

        <SliderRow
          display={t("annotate.textNoteSizeValue", { size: style.fontSize })}
          label={t("annotate.textNoteSize")}
          max={TEXT_NOTE_MAX_FONT_SIZE}
          min={TEXT_NOTE_MIN_FONT_SIZE}
          onChange={(fontSize) => onStyleChange({ ...style, fontSize })}
          step={1}
          value={style.fontSize}
        />

        <SliderRow
          display={`${Math.round(style.opacity * 100)}%`}
          label={t("annotate.opacity")}
          max={100}
          min={TEXT_NOTE_MIN_OPACITY * 100}
          onChange={(value) => onStyleChange({ ...style, opacity: value / 100 })}
          step={5}
          value={Math.round(style.opacity * 100)}
        />
      </div>

      <div className="flex w-64 flex-col gap-2 rounded-lg border bg-popover p-2 shadow-md">
        {/* Styled as the note will be drawn, so what is typed is what lands. */}
        <Textarea
          aria-label={t("annotate.textNoteInput")}
          className={cn("min-h-20 resize-none border-0 shadow-none focus-visible:ring-0")}
          onChange={(event) => onTextChange(event.target.value)}
          placeholder={t("annotate.textNotePlaceholder")}
          ref={textareaRef}
          rows={3}
          style={{
            color: style.color,
            fontFamily: previewFontFamily[style.fontFamily],
            fontSize: previewSize,
            lineHeight: 1.2,
            opacity: style.opacity,
          }}
          value={draft.text}
        />
        <div className="flex justify-end gap-1">
          <Button
            aria-label={t("annotate.textNoteCancel")}
            onClick={onCancel}
            size="icon"
            title={t("annotate.textNoteCancel")}
            variant="ghost"
          >
            <X />
          </Button>
          <Button
            aria-label={t("annotate.textNoteConfirm")}
            onClick={onCommit}
            size="icon"
            title={t("annotate.textNoteConfirm")}
            variant="outline"
          >
            <Check />
          </Button>
        </div>
      </div>
    </div>
  )
}
