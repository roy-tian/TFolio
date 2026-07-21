import {
  ChevronDown,
  Download,
  Highlighter,
  Redo2,
  Save,
  Square,
  Stamp,
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
import { cn } from "@/lib/utils"

const splitMenuButtonClassName =
  "relative w-5 border-input px-0 before:pointer-events-none before:absolute before:inset-y-1.5 before:left-0 before:w-px before:bg-border before:opacity-0 before:transition-opacity hover:before:opacity-100"

/** The tool the reader is drawing with, or none. */
export type AnnotationTool = "highlight" | "rect" | "textNote" | null

type AnnotationToolbarProps = {
  activeTool: AnnotationTool
  canRedo: boolean
  canUndo: boolean
  disabled: boolean
  /** Whether the document merged in other files; like a watermark, that may
      only be exported as a copy, never saved back over the first file. */
  hasMergedFiles: boolean
  /** Whether the document has a file of its own for the save key to write
      back to; one opened from bytes does not until an export gives it one. */
  hasSourceFile: boolean
  /** Whether a watermark this session added is still on the document; one may
      only be exported as a copy, never written back over the reader's file. */
  hasWatermark: boolean
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
  onWatermark: () => void
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
  hasMergedFiles,
  hasSourceFile,
  hasWatermark,
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
  onWatermark,
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
  const watermarkLabel = t("watermark.open")
  const saveLabel = t("annotate.save")
  const exportLabel = t("annotate.export")
  // Only where the reason is not already in front of the reader: a watermark or
  // merged files they can see, or a document with no file of its own. A
  // watermark is named first — it is the stricter, less recoverable of the two.
  const saveTitle = hasWatermark
    ? t("annotate.saveWatermarked")
    : hasMergedFiles
      ? t("annotate.saveMerged")
      : hasSourceFile
        ? saveLabel
        : t("annotate.saveNoSource")

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
      </ButtonGroup>

      <ButtonGroup>
        <Button
          aria-label={saveLabel}
          className="border-r-transparent peer/save"
          disabled={
            disabled || !hasSourceFile || !isDirty || hasWatermark || hasMergedFiles
          }
          onClick={onSave}
          size="icon"
          title={disabled ? saveLabel : saveTitle}
          variant="outline"
        >
          <Save />
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                aria-label={t("annotate.saveOptions")}
                className={cn(
                  splitMenuButtonClassName,
                  "peer-hover/save:before:opacity-100",
                )}
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
