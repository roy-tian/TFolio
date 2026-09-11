import {
  ChevronDown,
  Eraser,
  FileScan,
  Highlighter,
  SquarePen,
  Stamp,
} from "lucide-react"
import type { CSSProperties } from "react"
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
import {
  toolbarCenteredStripButtonClassName,
  toolbarInkBarClassName,
  toolbarSelectionBarClassName,
} from "@/lib/toolbarStyles"
import { cn } from "@/lib/utils"

/** A sliver rather than a second button's width, its chevron in the bottom
    corner: the tool beside it is what the reader aims at, not this. */
const splitMenuButtonClassName =
  "relative w-3.5 items-end border-input px-0 pb-1 before:pointer-events-none before:absolute before:inset-y-1.5 before:left-0 before:w-px before:bg-border before:opacity-0 before:transition-opacity hover:before:opacity-100"

export type AnnotationTool = "highlight" | "rect" | "textNote" | "eraser" | null

type AnnotationToolbarProps = {
  activeTool: AnnotationTool
  disabled: boolean
  eraserApplies: boolean
  highlightApplies: boolean
  highlightColor: HexColor
  onHighlightColorChange: (color: HexColor) => void
  onRectStyleChange: (style: RectStyle) => void
  /** Builds a document of its own rather than touching this one. */
  onMergeWizard: () => void
  onPageNumbers: () => void
  onToolChange: (tool: AnnotationTool) => void
  onWatermark: () => void
  rectApplies: boolean
  rectStyle: RectStyle
  textNoteApplies: boolean
  textNoteColor: HexColor
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
  textNoteColor,
}: AnnotationToolbarProps) {
  const { t } = useTranslation()
  const highlightLabel = t("annotate.highlight")
  const rectLabel = t("annotate.rect")
  const textNoteLabel = t("annotate.textNote")
  const eraserLabel = t("annotate.eraser")
  const watermarkLabel = t("watermark.open")
  const pageNumbersLabel = t("pageNumbers.open")
  // A translucent wash is the colour the reader chose; a blur or a mosaic is
  // built from the page's own pixels, so only the wash re-inks the bottom bar.
  const rectBarFromColour = rectStyle.effect === "translucent"

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
                    toolbarInkBarClassName,
                    "size-8 border-r-transparent p-0 peer/highlight",
                  )}
                  disabled={disabled}
                  onPressedChange={(pressed) =>
                    onToolChange(pressed ? "highlight" : null)
                  }
                  pressed={activeTool === "highlight"}
                  style={{ "--tool-ink": highlightColor } as CSSProperties}
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
                    <ChevronDown className="size-3" />
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
                      allowCustom={false}
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
                    rectBarFromColour
                      ? toolbarInkBarClassName
                      : toolbarSelectionBarClassName,
                    "size-8 border-r-transparent p-0 peer/rect",
                    toolbarCenteredStripButtonClassName,
                  )}
                  disabled={disabled}
                  onPressedChange={(pressed) =>
                    onToolChange(pressed ? "rect" : null)
                  }
                  pressed={activeTool === "rect"}
                  style={
                    rectBarFromColour
                      ? ({ "--tool-ink": rectStyle.color } as CSSProperties)
                      : undefined
                  }
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
                    <ChevronDown className="size-3" />
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
                className={cn(
                  toolbarInkBarClassName,
                  "size-8 p-0",
                  toolbarCenteredStripButtonClassName,
                )}
                disabled={disabled}
                onPressedChange={(pressed) =>
                  onToolChange(pressed ? "textNote" : null)
                }
                pressed={activeTool === "textNote"}
                style={{ "--tool-ink": textNoteColor } as CSSProperties}
                variant="outline"
              >
                <SquarePen />
              </Toggle>
            </ToolbarTooltip>
          ) : null}

          {/* The one that undoes the others' work: it takes off a mark this
              session made, wherever in the stack — what plain undo cannot. */}
          {eraserApplies ? (
            <ToolbarTooltip label={eraserLabel}>
              <Toggle
                aria-label={eraserLabel}
                className={cn(
                  toolbarSelectionBarClassName,
                  "size-8 p-0",
                  toolbarCenteredStripButtonClassName,
                )}
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

        <MergeWizardButton onClick={onMergeWizard} />
      </ButtonGroup>
    </div>
  )
}
