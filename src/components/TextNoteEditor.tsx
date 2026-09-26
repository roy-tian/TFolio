import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import type { RefObject } from "react"
import { Check, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { ColorSwatchPicker } from "@/components/ColorSwatchPicker"
import { SliderRow } from "@/components/SliderRow"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import {
  fractionToClientPoint,
  pagePointToFraction,
} from "@/lib/annotationGeometry"
import { ZOOM_PREVIEW_EVENT } from "@/lib/zoom"
import type { TextNoteStyle } from "@/lib/annotations"
import {
  TEXT_NOTE_MAX_FONT_SIZE,
  TEXT_NOTE_MIN_FONT_SIZE,
  TEXT_NOTE_MIN_OPACITY,
  textNoteSwatches,
} from "@/lib/annotationStyles"
import { dimensionsForRotation, type PdfPageInfo } from "@/lib/pdf"
import type { TextNoteDraft } from "@/lib/textNoteDraft"
import {
  noteFontFamily,
  TEXT_NOTE_LINE_HEIGHT,
} from "@/lib/textNoteLayout"
import { cn } from "@/lib/utils"

type TextNoteEditorProps = {
  draft: TextNoteDraft
  editorRef: RefObject<HTMLElement | null>
  onCancel: () => void
  onCommit: () => void
  /** `transient` for a slider's drag, which is shown but not stored. */
  onStyleChange: (style: TextNoteStyle, transient?: boolean) => void
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

const VIEWPORT_MARGIN = 8

/** Floating in screen space, not the page's layer — at 90° a reader would be
    typing sideways. Nothing moves it when the page changes, so it watches. */
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
  // Options sit above the text box, where a reader expects them — until the
  // note nears the window's top, where there is no room, and they go below.
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

    // Held inside the window, only as far as needed. Defensive — no arrangement
    // tried left it off screen — so treat it as a guard, not a bug fix.
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
    // Ctrl+wheel previews move the page on the compositor before layout lands;
    // follow that event so the editor stays pinned throughout the gesture.
    viewer.addEventListener(ZOOM_PREVIEW_EVENT, measure)
    window.addEventListener("resize", measure)

    // Zooming writes the page's own CSS width, firing neither event above when
    // the scroll offset stays clamped; watching the element catches every way.
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

  // Keyed to which note this is, not to mounting: placing one while another is
  // open swaps drafts in place, and a run-once effect would leave no caret.
  useEffect(() => {
    textareaRef.current?.focus()
  }, [draft.pageNumber, draft.origin.left, draft.origin.top])

  if (!placement) {
    return null
  }

  // Big enough to type in whatever the note's own size, so a 6pt note is not
  // edited through a slit, while a large one still previews at its real size.
  const previewSize = Math.max(12, style.fontSize * placement.pxPerPoint)

  return (
    <div
      className="fixed z-50"
      ref={editorRef as RefObject<HTMLDivElement>}
      style={{ left: placement.left, top: placement.top }}
    >
      {/* Out of the flow so the text box — not the options beside it — starts
          at the point clicked, which is where the note will be drawn. */}
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
            onChange={(color) => onStyleChange({ ...style, color })}
            swatches={textNoteSwatches}
            value={style.color}
          />
        </div>

        <SliderRow
          display={t("annotate.textNoteSizeValue", { size: style.fontSize })}
          label={t("annotate.textNoteSize")}
          max={TEXT_NOTE_MAX_FONT_SIZE}
          min={TEXT_NOTE_MIN_FONT_SIZE}
          onChange={(fontSize, transient) =>
            onStyleChange({ ...style, fontSize }, transient)
          }
          step={1}
          value={style.fontSize}
        />

        <SliderRow
          display={`${Math.round(style.opacity * 100)}%`}
          label={t("annotate.opacity")}
          max={100}
          min={TEXT_NOTE_MIN_OPACITY * 100}
          onChange={(value, transient) =>
            onStyleChange({ ...style, opacity: value / 100 }, transient)
          }
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
            fontFamily: noteFontFamily(draft.text),
            fontSize: previewSize,
            lineHeight: TEXT_NOTE_LINE_HEIGHT,
            opacity: style.opacity,
          }}
          value={draft.text}
        />
        <div className="flex justify-end gap-1">
          <ToolbarTooltip label={t("annotate.textNoteCancel")}>
            <Button
              aria-label={t("annotate.textNoteCancel")}
              onClick={onCancel}
              size="icon"
              variant="ghost"
            >
              <X />
            </Button>
          </ToolbarTooltip>
          <ToolbarTooltip label={t("annotate.textNoteConfirm")}>
            <Button
              aria-label={t("annotate.textNoteConfirm")}
              onClick={onCommit}
              size="icon"
              variant="outline"
            >
              <Check />
            </Button>
          </ToolbarTooltip>
        </div>
      </div>
    </div>
  )
}
