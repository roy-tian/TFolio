import {
  ChevronDown,
  Download,
  Highlighter,
  Redo2,
  Square,
  Undo2,
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

/** The tool the reader is drawing with, or none. */
export type AnnotationTool = "highlight" | "rect" | null

type AnnotationToolbarProps = {
  activeTool: AnnotationTool
  canRedo: boolean
  canUndo: boolean
  disabled: boolean
  /** Whether the layout has text to mark; the grid of thumbnails does not. */
  highlightApplies: boolean
  highlightColor: HexColor
  onExport: () => void
  onHighlightColorChange: (color: HexColor) => void
  onRectStyleChange: (style: RectStyle) => void
  onRedo: () => void
  onToolChange: (tool: AnnotationTool) => void
  onUndo: () => void
  /** Whether a page is on show to draw on; the thumbnail grid is not. */
  rectApplies: boolean
  rectStyle: RectStyle
}

export function AnnotationToolbar({
  activeTool,
  canRedo,
  canUndo,
  disabled,
  highlightApplies,
  highlightColor,
  onExport,
  onHighlightColorChange,
  onRectStyleChange,
  onRedo,
  onToolChange,
  onUndo,
  rectApplies,
  rectStyle,
}: AnnotationToolbarProps) {
  const { t } = useTranslation()
  const undoLabel = t("annotate.undo")
  const redoLabel = t("annotate.redo")
  const highlightLabel = t("annotate.highlight")
  const rectLabel = t("annotate.rect")
  const exportLabel = t("annotate.export")

  return (
    <>
      <ButtonGroup>
        <Button
          aria-label={undoLabel}
          disabled={disabled || !canUndo}
          onClick={onUndo}
          size="icon"
          title={undoLabel}
          variant="outline"
        >
          <Undo2 />
        </Button>
        <Button
          aria-label={redoLabel}
          disabled={disabled || !canRedo}
          onClick={onRedo}
          size="icon"
          title={redoLabel}
          variant="outline"
        >
          <Redo2 />
        </Button>
      </ButtonGroup>

      {highlightApplies ? (
        <ButtonGroup>
          {/* A Toggle rather than a Button: unlike the fit control next to it, a
              tool really is on or off, and pressing the active one puts it away. */}
          <Toggle
            aria-label={highlightLabel}
            disabled={disabled}
            onPressedChange={(pressed) => onToolChange(pressed ? "highlight" : null)}
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
                  className="px-1"
                  disabled={disabled}
                  size="icon"
                  title={t("annotate.highlightOptions")}
                  variant="outline"
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
        </ButtonGroup>
      ) : null}

      {rectApplies ? (
        <ButtonGroup>
          <Toggle
            aria-label={rectLabel}
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
                  className="px-1"
                  disabled={disabled}
                  size="icon"
                  title={t("annotate.rectOptions")}
                  variant="outline"
                />
              }
            >
              <ChevronDown />
            </PopoverTrigger>
            <PopoverContent align="end" className="w-auto p-3">
              <RectStylePopover onChange={onRectStyleChange} style={rectStyle} />
            </PopoverContent>
          </Popover>
        </ButtonGroup>
      ) : null}

      <Button
        aria-label={exportLabel}
        disabled={disabled}
        onClick={onExport}
        size="icon"
        title={exportLabel}
        variant="outline"
      >
        <Download />
      </Button>
    </>
  )
}
