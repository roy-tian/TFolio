import { LoaderCircle } from "lucide-react"

import {
  Progress,
  ProgressLabel,
  ProgressValue,
} from "@/components/ui/progress"
import { progressPercent, type PdfProgress } from "@/lib/progress"
import { cn } from "@/lib/utils"

type OperationProgressProps = {
  className?: string
  label: string
  /** Null while the work has no announced length: an indeterminate bar says
      that better than a determinate one stuck at nought. */
  progress: PdfProgress | null
  testId?: string
}

export function OperationProgress({
  className,
  label,
  progress,
  testId,
}: OperationProgressProps) {
  const percent = progress ? progressPercent(progress) : null

  return (
    <Progress
      className={cn("w-full gap-2", className)}
      data-testid={testId}
      value={percent}
    >
      <ProgressLabel className="flex items-center gap-2">
        <LoaderCircle className="size-4 animate-spin text-muted-foreground" />
        {label}
      </ProgressLabel>
      <ProgressValue />
    </Progress>
  )
}
