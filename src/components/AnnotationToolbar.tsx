import {
  ChevronDown,
  Eraser,
  FileScan,
  Highlighter,
  SquarePen,
  Stamp,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { ColorSwatchPicker } from "@/components/ColorSwatchPicker"
import { MergeWizardButton } from "@/components/MergeWizardButton"
import { RectEffectIcon } from "@/components/RectEffectIcon"
import { RectStylePopover } from "@/components/RectStylePopover"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
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
import { shortcuts } from "@/lib/shortcuts"
import { toolbarSelectionBarClassName } from "@/lib/toolbarStyles"
import { cn } from "@/lib/utils"

const splitMenuButtonClassName =
  "relative w-5 border-input px-0 before:pointer-events-none before:absolute before:inset-y-1.5 before:left-0 before:w-px before:bg-border before:opacity-0 before:transition-opacity hover:before:opacity-100"

/** The tool the reader is drawing with — or rubbing out with — or none. */
export type AnnotationTool = "highlight" | "rect" | "textNote" | "eraser" | null

type AnnotationToolbarProps = {
  activeTool: AnnotationTool
  disabled: boolean
  /** Whether a page is on show to rub a mark off; the thumbnail grid is not. */
  eraserApplies: boolean
  /** Whether the layout has text to mark; the grid of thumbnails does not. */
  highlightApplies: boolean
  highlightColor: HexColor
  onHighlightColorChange: (color: HexColor) => void
  onRectStyleChange: (style: RectStyle) => void
  /** Opens the merge wizard. It builds a document of its own rather than
      touching this one, but it sits with the document tools because that is
      where a reader looks for what acts on whole files. */
  onMergeWizard: () => void
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
  eraserApplies,
  highlightApplies,
  highlightColor,
  onHighlightColorChange,
  onMergeWizard,
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
  const eraserLabel = t("annotate.eraser")
  const watermarkLabel = t("watermark.open")
  const pageNumbersLabel = t("pageNumbers.open")

  return (
    <div className="flex items-center gap-1">
      {highlightApplies || rectApplies || textNoteApplies || eraserApplies ? (
        <ButtonGroup>
          {highlightApplies ? (
            <>
              {/* A Toggle rather than a Button: unlike the fit control next to it, a
              tool really is on or off, and pressing the active one puts it away. */}
              <ToolbarTooltip label={highlightLabel}>
                <Toggle
                  aria-label={highlightLabel}
                  className={cn(
                    toolbarSelectionBarClassName,
                    "size-8 border-r-transparent p-0 peer/highlight",
                  )}
                  disabled={disabled}
                  onPressedChange={(pressed) =>
                    onToolChange(pressed ? "highlight" : null)
                  }
                  pressed={activeTool === "highlight"}
                  variant="outline"
                >
                  <Highlighter />
                </Toggle>
              </ToolbarTooltip>
              <Popover>
                <ToolbarTooltip label={t("annotate.highlightOptions")}>
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
                        variant="ghost"
                      />
                    }
                  >
                    <ChevronDown />
                  </PopoverTrigger>
                </ToolbarTooltip>
                <PopoverContent align="end" className="w-auto p-3">
                  <div className="space-y-2">
                    <p
                      className="text-xs font-medium"
                      id="highlight-color-label"
                    >
                      {t("annotate.highlightColor")}
                    </p>
                    <ColorSwatchPicker
                      labelledBy="highlight-color-label"
                      onChange={onHighlightColorChange}
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
              <ToolbarTooltip label={rectLabel}>
                <Toggle
                  aria-label={rectLabel}
                  className={cn(
                    toolbarSelectionBarClassName,
                    "size-8 border-r-transparent p-0 peer/rect",
                  )}
                  disabled={disabled}
                  onPressedChange={(pressed) =>
                    onToolChange(pressed ? "rect" : null)
                  }
                  pressed={activeTool === "rect"}
                  variant="outline"
                >
                  <RectEffectIcon effect={rectStyle.effect} />
                </Toggle>
              </ToolbarTooltip>
              <Popover>
                <ToolbarTooltip label={t("annotate.rectOptions")}>
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
                        variant="ghost"
                      />
                    }
                  >
                    <ChevronDown />
                  </PopoverTrigger>
                </ToolbarTooltip>
                <PopoverContent align="end" className="w-auto p-3">
                  <RectStylePopover
                    onChange={onRectStyleChange}
                    style={rectStyle}
                  />
                </PopoverContent>
              </Popover>
            </>
          ) : null}

          {textNoteApplies ? (
            <ToolbarTooltip label={textNoteLabel}>
              <Toggle
                aria-label={textNoteLabel}
                className={cn(toolbarSelectionBarClassName, "size-8 p-0")}
                disabled={disabled}
                onPressedChange={(pressed) =>
                  onToolChange(pressed ? "textNote" : null)
                }
                pressed={activeTool === "textNote"}
                variant="outline"
              >
                <SquarePen />
              </Toggle>
            </ToolbarTooltip>
          ) : null}

          {/* Last of the drawing tools, and the one that undoes their work: it
              takes off a mark this session made, wherever in the stack it sits,
              which is what plain undo cannot do. */}
          {eraserApplies ? (
            <ToolbarTooltip label={eraserLabel}>
              <Toggle
                aria-label={eraserLabel}
                className={cn(toolbarSelectionBarClassName, "size-8 p-0")}
                disabled={disabled}
                onPressedChange={(pressed) =>
                  onToolChange(pressed ? "eraser" : null)
                }
                pressed={activeTool === "eraser"}
                variant="outline"
              >
                <Eraser />
              </Toggle>
            </ToolbarTooltip>
          ) : null}
        </ButtonGroup>
      ) : null}

      <ButtonGroup>
        <ToolbarTooltip label={watermarkLabel} shortcut={shortcuts.watermark}>
          <Button
            aria-label={watermarkLabel}
            className="border-input"
            disabled={disabled}
            onClick={onWatermark}
            size="icon"
            variant="ghost"
          >
            <Stamp />
          </Button>
        </ToolbarTooltip>

        <ToolbarTooltip
          label={pageNumbersLabel}
          shortcut={shortcuts.pageNumbers}
        >
          <Button
            aria-label={pageNumbersLabel}
            className="border-input"
            disabled={disabled}
            onClick={onPageNumbers}
            size="icon"
            variant="ghost"
          >
            <FileScan />
          </Button>
        </ToolbarTooltip>

        {/* Last in the group: the two before it mark the document on screen,
            while this one leaves to build another. */}
        <MergeWizardButton onClick={onMergeWizard} />
      </ButtonGroup>
    </div>
  )
}
