import {
  ChevronDown,
  Download,
  Highlighter,
  Redo2,
  Save,
  Square,
  Type,
  Undo2,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { ColorSwatchPicker } from "@/components/ColorSwatchPicker"
import { RectStylePopover } from "@/components/RectStylePopover"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Toggle } from "@/components/ui/toggle"
import type { HexColor, RectStyle } from "@/lib/annotations"
import { highlightSwatches } from "@/lib/annotationStyles"

/** The tool the reader is drawing with, or none. */
export type AnnotationTool = "highlight" | "rect" | "textNote" | null

type AnnotationToolbarProps = {
  activeTool: AnnotationTool
  canRedo: boolean
  canUndo: boolean
  disabled: boolean
  /** Whether the document has a file of its own for the save key to write
      back to; one opened from bytes does not until an export gives it one. */
  hasSourceFile: boolean
  /** Whether the layout has text to mark; the grid of thumbnails does not. */
  highlightApplies: boolean
  highlightColor: HexColor
  isDirty: boolean
  onExport: () => void
  onHighlightColorChange: (color: HexColor) => void
  onRectStyleChange: (style: RectStyle) => void
  onRedo: () => void
  onSave: () => void
  onToolChange: (tool: AnnotationTool) => void
  onUndo: () => void
  /** Whether a page is on show to draw on; the thumbnail grid is not. */
  rectApplies: boolean
  rectStyle: RectStyle
  /** Whether a page is on show to type on; the thumbnail grid is not. */
  textNoteApplies: boolean
}

export function AnnotationToolbar({
  activeTool,
  canRedo,
  canUndo,
  disabled,
  hasSourceFile,
  highlightApplies,
  highlightColor,
  isDirty,
  onExport,
  onHighlightColorChange,
  onRectStyleChange,
  onRedo,
  onSave,
  onToolChange,
  onUndo,
  rectApplies,
  rectStyle,
  textNoteApplies,
}: AnnotationToolbarProps) {
  const { t } = useTranslation()
  const undoLabel = t("annotate.undo")
  const redoLabel = t("annotate.redo")
  const highlightLabel = t("annotate.highlight")
  const rectLabel = t("annotate.rect")
  const textNoteLabel = t("annotate.textNote")
  const saveLabel = t("annotate.save")
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

      {textNoteApplies ? (
        <Toggle
          aria-label={textNoteLabel}
          disabled={disabled}
          onPressedChange={(pressed) => onToolChange(pressed ? "textNote" : null)}
          pressed={activeTool === "textNote"}
          title={textNoteLabel}
          variant="outline"
        >
          <Type />
        </Toggle>
      ) : null}

      <ButtonGroup>
        <Button
          aria-label={saveLabel}
          disabled={disabled || !hasSourceFile || !isDirty}
          onClick={onSave}
          size="icon"
          // The tooltip explains a disabled key only where the reason is not
          // in front of the reader: a document with no file of its own.
          title={!disabled && !hasSourceFile ? t("annotate.saveNoSource") : saveLabel}
          variant="outline"
        >
          <Save />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={t("annotate.saveOptions")}
                className="px-1"
                disabled={disabled}
                size="icon"
                title={t("annotate.saveOptions")}
                variant="outline"
              />
            }
          >
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-auto min-w-40">
            <DropdownMenuGroup>
              <DropdownMenuItem onClick={onExport}>
                <Download />
                {exportLabel}
              </DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </ButtonGroup>
    </>
  )
}
