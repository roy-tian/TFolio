import { Redo2, Undo2 } from "lucide-react"
import { useTranslation } from "react-i18next"

import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"

type HistoryControlsProps = {
  canRedo: boolean
  canUndo: boolean
  disabled: boolean
  onRedo: () => void
  onUndo: () => void
}

/** Undo and redo for the document's whole edit history — pages included, so
    they lead the editing tools rather than sitting among the drawing ones. */
export function HistoryControls({
  canRedo,
  canUndo,
  disabled,
  onRedo,
  onUndo,
}: HistoryControlsProps) {
  const { t } = useTranslation()
  const undoLabel = t("annotate.undo")
  const redoLabel = t("annotate.redo")

  return (
    <ButtonGroup>
      <ToolbarTooltip label={undoLabel}>
        <Button
          aria-label={undoLabel}
          disabled={disabled || !canUndo}
          onClick={onUndo}
          size="icon"
          variant="outline"
        >
          <Undo2 />
        </Button>
      </ToolbarTooltip>
      <ToolbarTooltip label={redoLabel}>
        <Button
          aria-label={redoLabel}
          disabled={disabled || !canRedo}
          onClick={onRedo}
          size="icon"
          variant="outline"
        >
          <Redo2 />
        </Button>
      </ToolbarTooltip>
    </ButtonGroup>
  )
}
