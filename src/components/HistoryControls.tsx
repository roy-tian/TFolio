import { Undo2 } from "lucide-react"
import { useTranslation } from "react-i18next"

import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { Button } from "@/components/ui/button"
import type { AnnotationCommand } from "@/lib/annotations"
import { historyAction } from "@/lib/historyAction"
import { shortcuts } from "@/lib/shortcuts"

type HistoryControlsProps = {
  canUndo: boolean
  disabled: boolean
  nextUndo: AnnotationCommand | null
  onUndo: () => void
}

/** Undo for the document's whole edit history — pages included, so it leads
    the editing tools rather than sitting among the drawing ones. Redo is the
    keyboard's alone. */
export function HistoryControls({
  canUndo,
  disabled,
  nextUndo,
  onUndo,
}: HistoryControlsProps) {
  const { t } = useTranslation()
  const action = nextUndo ? historyAction(nextUndo) : null
  const undoLabel = action
    ? t("annotate.undoAction", {
        action: t(action.key, { count: action.count }),
      })
    : t("annotate.undo")

  return (
    <ToolbarTooltip label={undoLabel} shortcut={shortcuts.undo}>
      <Button
        aria-label={undoLabel}
        disabled={disabled || !canUndo}
        onClick={onUndo}
        size="icon-sm"
        variant="outline"
      >
        <Undo2 />
      </Button>
    </ToolbarTooltip>
  )
}
