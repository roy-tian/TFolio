import { LoaderCircle } from "lucide-react"

import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress"
import { progressPercent, type PdfProgress } from "@/lib/progress"
import { cn } from "@/lib/utils"

type OperationProgressProps = {
  /** The bar over the words rather than under them. */
  barFirst?: boolean
  className?: string
  label: string
  /** Null while the work has no announced length: an indeterminate bar says
      that better than a determinate one stuck at nought. */
  progress: PdfProgress | null
  testId?: string
}

export function OperationProgress({
  barFirst = false,
  className,
  label,
  progress,
  testId,
}: OperationProgressProps) {
  const percent = progress ? progressPercent(progress) : null

  return (
    <Progress
      className={cn(
        "w-full gap-2",
        barFirst && "[&>[data-slot=progress-track]]:-order-1",
        className,
      )}
      data-testid={testId}
      value={percent}
    >
      <ProgressLabel className="flex min-w-0 flex-1 items-center gap-2">
        <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
        {label}
      </ProgressLabel>
      <ProgressValue />
    </Progress>
  )
}
