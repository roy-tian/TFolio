import { WandSparkles } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"

type MergeWizardButtonProps = {
  onClick: () => void
}

/**
 * The one control that opens the merge wizard, in the one look — the document
 * tools' group in a document's toolbar, and a group of its own on the home tab,
 * which has no toolbar but is exactly where a reader with nothing open starts a
 * merge.
 */
export function MergeWizardButton({ onClick }: MergeWizardButtonProps) {
  const { t } = useTranslation()
  const label = t("mergeWizard.open")

  return (
    <Button
      aria-label={label}
      className="border-input"
      data-slot="merge-wizard-button"
      onClick={onClick}
      size="icon"
      title={label}
      variant="ghost"
    >
      <WandSparkles />
    </Button>
  )
}
