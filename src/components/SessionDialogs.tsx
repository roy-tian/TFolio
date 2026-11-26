import { PageNumbersDialog } from "@/components/PageNumbersDialog"
import { WatermarkDialog } from "@/components/WatermarkDialog"
import type { DocumentWatermarkPreviewProps } from "@/components/DocumentWatermarkPreview"
import type { usePageNumbers } from "@/hooks/usePageNumbers"
import type { useWatermark } from "@/hooks/useWatermark"

type SessionDialogsProps = {
  /** Dialogs mount only in the tab on screen: `open` alone would still run
      their exit animations under a hidden tab, behind the one on display. */
  active: boolean
  pageCount: number
  pageNumbers: ReturnType<typeof usePageNumbers>
  watermarkPreview: Omit<DocumentWatermarkPreviewProps, "config">
  watermark: ReturnType<typeof useWatermark>
}

/** The session's modal surfaces: the two owned-layer dialogs. */
export function SessionDialogs({
  active,
  pageCount,
  pageNumbers,
  watermarkPreview,
  watermark,
}: SessionDialogsProps) {
  return (
    <>
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
        preview={watermarkPreview}
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
