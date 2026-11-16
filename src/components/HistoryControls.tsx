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
  nextRedo,
  nextUndo,
  onRedo,
  onUndo,
}: HistoryControlsProps) {
  const { t } = useTranslation()

  function actionName(command: AnnotationCommand) {
    const action = historyAction(command)

    return "count" in action
      ? t(action.key, { count: action.count })
      : t(action.key)
  }

  const undoLabel = nextUndo
    ? t("annotate.undoAction", { action: actionName(nextUndo) })
    : t("annotate.undo")
  const redoLabel = nextRedo
    ? t("annotate.redoAction", { action: actionName(nextRedo) })
    : t("annotate.redo")

  return (
    <ButtonGroup>
      {/* Greyed, each says why, with no chord it would not answer: a step
          still to take is off only while an edit runs. */}
      <ToolbarTooltip
        label={
          canUndo ? undoLabel : nextUndo ? t("annotate.historyBusy") : t("annotate.nothingToUndo")
        }
        shortcut={canUndo ? shortcuts.undo : undefined}
      >
        <Button
          aria-label={undoLabel}
          disabled={!canUndo}
          onClick={onUndo}
          size="icon-sm"
          variant="outline"
        >
          <Undo2 />
        </Button>
      </ToolbarTooltip>
      <ToolbarTooltip
        label={
          canRedo ? redoLabel : nextRedo ? t("annotate.historyBusy") : t("annotate.nothingToRedo")
        }
        shortcut={canRedo ? shortcuts.redo : undefined}
      >
        <Button
          aria-label={redoLabel}
          disabled={!canRedo}
          onClick={onRedo}
          size="icon-sm"
          variant="outline"
        >
          <Redo2 />
        </Button>
      </ToolbarTooltip>
    </ButtonGroup>
  )
}
