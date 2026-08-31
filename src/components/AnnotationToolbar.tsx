import {
  ChevronDown,
  Hash,
  Highlighter,
  Square,
  Stamp,
  Type,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { ColorSwatchPicker } from "@/components/ColorSwatchPicker"
import { RectStylePopover } from "@/components/RectStylePopover"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Toggle } from "@/components/ui/toggle"
import type { HexColor, RectStyle } from "@/lib/annotations"
import { highlightSwatches } from "@/lib/annotationStyles"
import { cn } from "@/lib/utils"

const splitMenuButtonClassName =
  "relative w-5 border-input px-0 before:pointer-events-none before:absolute before:inset-y-1.5 before:left-0 before:w-px before:bg-border before:opacity-0 before:transition-opacity hover:before:opacity-100"

/** The tool the reader is drawing with, or none. */
export type AnnotationTool = "highlight" | "rect" | "textNote" | null

type AnnotationToolbarProps = {
  activeTool: AnnotationTool
  disabled: boolean
  /** Whether the layout has text to mark; the grid of thumbnails does not. */
  highlightApplies: boolean
  highlightColor: HexColor
  onHighlightColorChange: (color: HexColor) => void
  onRectStyleChange: (style: RectStyle) => void
  onPageNumbers: () => void
  onToolChange: (tool: AnnotationTool) => void
  onWatermark: () => void
  /** Whether a page is on show to draw on; the thumbnail grid is not. */
  rectApplies: boolean
  rectStyle: RectStyle
  /** Whether a page is on show to type on; the thumbnail grid is not. */
  textNoteApplies: boolean
}

export function AnnotationToolbar({
  activeTool,
  disabled,
  highlightApplies,
  highlightColor,
  onHighlightColorChange,
  onPageNumbers,
  onRectStyleChange,
  onToolChange,
  onWatermark,
  rectApplies,
  rectStyle,
  textNoteApplies,
}: AnnotationToolbarProps) {
  const { t } = useTranslation()
  const highlightLabel = t("annotate.highlight")
  const rectLabel = t("annotate.rect")
  const textNoteLabel = t("annotate.textNote")
  const watermarkLabel = t("watermark.open")
  const pageNumbersLabel = t("pageNumbers.open")

  return (
    <ButtonGroup>
      {highlightApplies ? (
        <>
          {/* A Toggle rather than a Button: unlike the fit control next to it, a
              tool really is on or off, and pressing the active one puts it away. */}
          <Toggle
            aria-label={highlightLabel}
            className="size-8 border-r-transparent p-0 peer/highlight"
            disabled={disabled}
            onPressedChange={(pressed) =>
              onToolChange(pressed ? "highlight" : null)
            }
            pressed={activeTool === "highlight"}
            title={highlightLabel}
            variant="outline"
          >
            <Highlighter />
          </Toggle>
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  aria-label={t("annotate.highlightOptions")}
                  className={cn(
                    splitMenuButtonClassName,
                    "peer-hover/highlight:before:opacity-100",
                  )}
                  disabled={disabled}
                  size="icon"
                  title={t("annotate.highlightOptions")}
                  variant="ghost"
                />
              }
            >
              <ChevronDown />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto p-3">
              <div className="space-y-2">
                <p className="text-xs font-medium" id="highlight-color-label">
                  {t("annotate.highlightColor")}
                </p>
                <ColorSwatchPicker
                  labelledBy="highlight-color-label"
                  onChange={(color) => {
                    if (color) {
                      onHighlightColorChange(color)
                    }
                  }}
                  swatches={highlightSwatches}
                  value={highlightColor}
                />
              </div>
            </PopoverContent>
          </Popover>
        </>
      ) : null}

      {rectApplies ? (
        <>
          <Toggle
            aria-label={rectLabel}
            className="size-8 border-r-transparent p-0 peer/rect"
            disabled={disabled}
            onPressedChange={(pressed) => onToolChange(pressed ? "rect" : null)}
            pressed={activeTool === "rect"}
            title={rectLabel}
            variant="outline"
          >
            <Square />
          </Toggle>
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  aria-label={t("annotate.rectOptions")}
                  className={cn(
                    splitMenuButtonClassName,
                    "peer-hover/rect:before:opacity-100",
                  )}
                  disabled={disabled}
                  size="icon"
                  title={t("annotate.rectOptions")}
                  variant="ghost"
                />
              }
            >
              <ChevronDown />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto p-3">
              <RectStylePopover onChange={onRectStyleChange} style={rectStyle} />
            </PopoverContent>
          </Popover>
        </>
      ) : null}

      {textNoteApplies ? (
        <Toggle
          aria-label={textNoteLabel}
          className="size-8 p-0"
          disabled={disabled}
          onPressedChange={(pressed) => onToolChange(pressed ? "textNote" : null)}
          pressed={activeTool === "textNote"}
          title={textNoteLabel}
          variant="outline"
        >
          <Type />
        </Toggle>
      ) : null}

      <Button
        aria-label={watermarkLabel}
        className="border-input"
        disabled={disabled}
        onClick={onWatermark}
        size="icon"
        title={watermarkLabel}
        variant="ghost"
      >
        <Stamp />
      </Button>

      <Button
        aria-label={pageNumbersLabel}
        className="border-input"
        disabled={disabled}
        onClick={onPageNumbers}
        size="icon"
        title={pageNumbersLabel}
        variant="ghost"
      >
        <Hash />
      </Button>
    </ButtonGroup>
  )
}
