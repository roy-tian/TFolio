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
  splitMenuButtonClassName,
  toolbarCenteredStripButtonClassName,
  toolbarInkBarClassName,
  toolbarSelectionBarClassName,
} from "@/lib/toolbarStyles"
import { cn } from "@/lib/utils"

export type AnnotationTool = "highlight" | "rect" | "textNote" | "eraser" | null

type AnnotationToolbarProps = {
  activeTool: AnnotationTool
  /** Every drawing tool needs a page under the pointer, which the page grid
      does not show; the watermark and page numbers act on the document. */
  drawingApplies: boolean
  highlightColor: HexColor
  onHighlightColorChange: (color: HexColor) => void
  onRectStyleChange: (style: RectStyle, transient?: boolean) => void
  onPageNumbers: () => void
  onToolChange: (tool: AnnotationTool) => void
  onWatermark: () => void
  rectStyle: RectStyle
  textNoteColor: HexColor
}

export function AnnotationToolbar({
  activeTool,
  drawingApplies,
  highlightColor,
  onHighlightColorChange,
  onPageNumbers,
  onRectStyleChange,
  onToolChange,
  onWatermark,
  rectStyle,
  textNoteColor,
}: AnnotationToolbarProps) {
  const { t } = useTranslation()
  const highlightLabel = t("annotate.highlight")
  const rectLabel = t("annotate.rect")
  const textNoteLabel = t("annotate.textNote")
  const eraserLabel = t("annotate.eraser")
  const watermarkLabel = t("watermark.open")
  const pageNumbersLabel = t("pageNumbers.open")
  // A drawing tool the page grid has switched off says where it works: a
  // greyed button alone leaves the reader to guess why.
  const toolHint = (tool: string) =>
    drawingApplies ? tool : t("annotate.toolInReadingView", { tool })
  // A translucent wash is the colour the reader chose; a blur or a mosaic is
  // built from the page's own pixels, so only the wash re-inks the bottom bar.
  const rectBarFromColour = rectStyle.effect === "translucent"

  return (
    <div className="flex items-center gap-1">
      <ButtonGroup>
        {/* A Toggle rather than a Button: unlike the fit control next to it, a
        tool really is on or off, and pressing the active one puts it away. */}
        <ToolbarTooltip label={toolHint(highlightLabel)}>
          <Toggle
            aria-label={highlightLabel}
            className={cn(
              toolbarInkBarClassName,
              "size-7 min-w-7 border-r-transparent p-0 peer/highlight",
            )}
            onPressedChange={(pressed) =>
              onToolChange(pressed ? "highlight" : null)
            }
            disabled={!drawingApplies}
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
                  size="icon-sm"
                  variant="ghost"
                />
              }
            >
              <ChevronDown className="size-3" />
            </PopoverTrigger>
          </ToolbarTooltip>
          <PopoverContent align="end" className="w-auto p-3">
            <div className="flex flex-col gap-2">
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

        <ToolbarTooltip label={toolHint(rectLabel)}>
          <Toggle
            aria-label={rectLabel}
            className={cn(
              rectBarFromColour
                ? toolbarInkBarClassName
                : toolbarSelectionBarClassName,
              "size-7 min-w-7 border-r-transparent p-0 peer/rect",
              toolbarCenteredStripButtonClassName,
            )}
            onPressedChange={(pressed) =>
              onToolChange(pressed ? "rect" : null)
            }
            disabled={!drawingApplies}
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
                  size="icon-sm"
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

        <ToolbarTooltip label={toolHint(textNoteLabel)}>
          <Toggle
            aria-label={textNoteLabel}
            className={cn(
              toolbarInkBarClassName,
              "size-7 min-w-7 p-0",
              toolbarCenteredStripButtonClassName,
            )}
            onPressedChange={(pressed) =>
              onToolChange(pressed ? "textNote" : null)
            }
            disabled={!drawingApplies}
            pressed={activeTool === "textNote"}
            style={{ "--tool-ink": textNoteColor } as CSSProperties}
            variant="outline"
          >
            <SquarePen />
          </Toggle>
        </ToolbarTooltip>

        {/* The one that undoes the others' work: it takes off a mark this
            session made, wherever in the stack — what plain undo cannot. */}
        <ToolbarTooltip label={toolHint(eraserLabel)}>
          <Toggle
            aria-label={eraserLabel}
            className={cn(
              toolbarSelectionBarClassName,
              "size-7 min-w-7 p-0",
              toolbarCenteredStripButtonClassName,
            )}
            onPressedChange={(pressed) =>
              onToolChange(pressed ? "eraser" : null)
            }
            disabled={!drawingApplies}
            pressed={activeTool === "eraser"}
            variant="outline"
          >
            <Eraser />
          </Toggle>
        </ToolbarTooltip>
      </ButtonGroup>

      <ButtonGroup>
        <ToolbarTooltip label={watermarkLabel} shortcut={shortcuts.watermark}>
          <Button
            aria-label={watermarkLabel}
            className="border-input"
            onClick={onWatermark}
            size="icon-sm"
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
            onClick={onPageNumbers}
            size="icon-sm"
            variant="ghost"
          >
            <FileScan />
          </Button>
        </ToolbarTooltip>
      </ButtonGroup>
    </div>
  )
}
