import { FileScan, Stamp } from "lucide-react"
import { useCallback, useEffect } from "react"
import { useTranslation } from "react-i18next"

import { PageNumbersDialog } from "@/components/PageNumbersDialog"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { WatermarkDialog } from "@/components/WatermarkDialog"
import { ButtonGroup } from "@/components/ui/button-group"
import { Toggle } from "@/components/ui/toggle"
import type { OrganizeWorkspace } from "@/hooks/useOrganizeWorkspace"
import { usePageNumbers } from "@/hooks/usePageNumbers"
import { useWatermark } from "@/hooks/useWatermark"
import type { PageNumbersConfig } from "@/lib/pageNumbers"
import type { WatermarkConfig } from "@/lib/watermark"

// The drafts belong to the workspace, which has no document to change to.
const NO_DOCUMENT = 0
const nothingToStop = async () => false

type OrganizeLayersProps = {
  active: boolean
  busy: boolean
  organize: OrganizeWorkspace
}

/** The watermark and page numbers the new PDF is stamped with, set in the
    viewer's own dialogs: here an apply sets the plan's option, undoably. */
export function OrganizeLayers({ active, busy, organize }: OrganizeLayersProps) {
  const { t } = useTranslation()
  const { pages, plan, setLayers } = organize
  const pageCount = pages.length
  const disabled = busy || pageCount === 0

  const setWatermark = useCallback(
    (config: WatermarkConfig | null) => setLayers({ watermark: config }),
    [setLayers],
  )
  const setPageNumbers = useCallback(
    (config: PageNumbersConfig | null) => setLayers({ pageNumbers: config }),
    [setLayers],
  )

  const watermark = useWatermark({
    activeConfig: plan.options.watermark,
    defaultText: t("watermark.defaultText"),
    documentId: NO_DOCUMENT,
    onCancel: nothingToStop,
    onSet: setWatermark,
    pageCount,
  })
  const pageNumbers = usePageNumbers({
    activeConfig: plan.options.pageNumbers,
    documentId: NO_DOCUMENT,
    onCancel: nothingToStop,
    onSet: setPageNumbers,
    pageCount,
  })

  // A document arriving hides the workspace under an open dialog; closed with
  // it, the dialog does not greet the reader's next visit unasked.
  const closeWatermark = watermark.onOpenChange
  const closePageNumbers = pageNumbers.onOpenChange

  useEffect(() => {
    if (!active) {
      closeWatermark(false)
      closePageNumbers(false)
    }
  }, [active, closePageNumbers, closeWatermark])

  return (
    <>
      <ButtonGroup>
        <ToolbarTooltip
          label={t(watermark.hasWatermark ? "organize.watermarkSet" : "organize.watermark")}
        >
          <Toggle
            aria-label={t("organize.watermark")}
            className="size-7 min-w-7 p-0"
            data-slot="organize-watermark"
            disabled={disabled}
            onPressedChange={watermark.openDialog}
            pressed={watermark.hasWatermark}
            variant="outline"
          >
            <Stamp />
          </Toggle>
        </ToolbarTooltip>
        <ToolbarTooltip
          label={t(
            pageNumbers.hasPageNumbers ? "organize.pageNumbersSet" : "organize.pageNumbers",
          )}
        >
          <Toggle
            aria-label={t("organize.pageNumbers")}
            className="size-7 min-w-7 p-0"
            data-slot="organize-page-numbers"
            disabled={disabled}
            onPressedChange={pageNumbers.openDialog}
            pressed={pageNumbers.hasPageNumbers}
            variant="outline"
          >
            <FileScan />
          </Toggle>
        </ToolbarTooltip>
      </ButtonGroup>

      <WatermarkDialog
        draft={watermark.draft}
        hasWatermark={watermark.hasWatermark}
        isApplying={watermark.isApplying}
        isStopping={watermark.isStopping}
        onApply={() => void watermark.apply()}
        onDraftChange={watermark.setDraft}
        onOpenChange={watermark.onOpenChange}
        onRemove={() => void watermark.remove()}
        onStop={watermark.stop}
        open={active && watermark.open}
        progress={watermark.progress}
        validationError={watermark.validationError}
      />

      <PageNumbersDialog
        draft={pageNumbers.draft}
        hasPageNumbers={pageNumbers.hasPageNumbers}
        isApplying={pageNumbers.isApplying}
        isStopping={pageNumbers.isStopping}
        onApply={() => void pageNumbers.apply()}
        onDraftChange={pageNumbers.setDraft}
        onOpenChange={pageNumbers.onOpenChange}
        onRemove={() => void pageNumbers.remove()}
        onStop={pageNumbers.stop}
        open={active && pageNumbers.open}
        pageCount={pageCount}
        progress={pageNumbers.progress}
        validationError={pageNumbers.validationError}
      />
    </>
  )
}
