import { WandSparkles } from "lucide-react"
import { useTranslation } from "react-i18next"

import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { Button } from "@/components/ui/button"

type MergeWizardButtonProps = {
  onClick: () => void
}

/** One control, every look: the document tools' group in a toolbar, and a
    group of its own on the home tab, which has no toolbar to sit in. */
export function MergeWizardButton({ onClick }: MergeWizardButtonProps) {
  const { t } = useTranslation()
  const label = t("mergeWizard.open")

  return (
    <ToolbarTooltip label={label}>
      <Button
        aria-label={label}
        className="border-input"
        data-slot="merge-wizard-button"
        onClick={onClick}
        size="icon"
        variant="ghost"
      >
        <WandSparkles />
      </Button>
    </ToolbarTooltip>
  )
}
