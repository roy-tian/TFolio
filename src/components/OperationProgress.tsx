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
  progress: PdfProgress
  testId?: string
}

/** One accessible, determinate progress treatment for long PDF operations. */
export function OperationProgress({
  className,
  label,
  progress,
  testId,
}: OperationProgressProps) {
  const percent = progressPercent(progress)

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
