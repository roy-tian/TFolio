import { Redo2, Undo2 } from "lucide-react"
import { useTranslation } from "react-i18next"

import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import type { AnnotationCommand } from "@/lib/annotations"
import { historyAction } from "@/lib/historyAction"
import { shortcuts } from "@/lib/shortcuts"

type HistoryControlsProps = {
  canRedo: boolean
  canUndo: boolean
  disabled: boolean
  /** The steps the buttons would take, which they name. Null once there is
      nothing left to take back or put back, when the bare verb is the label. */
  nextRedo: AnnotationCommand | null
  nextUndo: AnnotationCommand | null
  onRedo: () => void
  onUndo: () => void
}

/** Undo and redo for the document's whole edit history — pages included, so
    they lead the editing tools rather than sitting among the drawing ones. */
export function HistoryControls({
  canRedo,
  canUndo,
  disabled,
  nextRedo,
  nextUndo,
  onRedo,
  onUndo,
}: HistoryControlsProps) {
  const { t } = useTranslation()

  function actionName(command: AnnotationCommand) {
    const action = historyAction(command)

    return t(action.key, { count: action.count })
  }

  const undoLabel = nextUndo
    ? t("annotate.undoAction", { action: actionName(nextUndo) })
    : t("annotate.undo")
  const redoLabel = nextRedo
    ? t("annotate.redoAction", { action: actionName(nextRedo) })
    : t("annotate.redo")

  return (
    <ButtonGroup>
      <ToolbarTooltip label={undoLabel} shortcut={shortcuts.undo}>
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
