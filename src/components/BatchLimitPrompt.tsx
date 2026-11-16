import { useTranslation } from "react-i18next"

import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import {
  MERGE_BYTES_AT_ONCE,
  MERGE_FILES_AT_ONCE,
  OPEN_FILES_AT_ONCE,
  type BatchLimit,
} from "@/lib/batchLimits"
import { formatBytes } from "@/lib/formatBytes"
import { joinSentences } from "@/lib/sentences"

type BatchLimitPromptProps = {
  limit: BatchLimit | null
  onAnswer: (take: boolean) => void
  open: boolean
}

/** Asked before an open, an add or a merge goes past what one go takes: the
    files that fit, from the first, or none of them, to choose again. */
export function BatchLimitPrompt({ limit, onAnswer, open }: BatchLimitPromptProps) {
  const { i18n, t } = useTranslation()
  const fit = limit?.fit ?? 0
  const over =
    limit?.by === "bytes"
      ? t("files.limitBytes", {
          limit: formatBytes(MERGE_BYTES_AT_ONCE, i18n.language),
          size: formatBytes(limit.bytes, i18n.language),
        })
      : t(limit?.kind === "open" ? "files.limitOpen" : "files.limitMerge", {
          limit: limit?.kind === "open" ? OPEN_FILES_AT_ONCE : MERGE_FILES_AT_ONCE,
          total: limit?.total ?? 0,
        })

  return (
    <AlertDialog
      onOpenChange={(next) => {
        if (!next) {
          onAnswer(false)
        }
      }}
      open={open}
    >
      <AlertDialogContent className="w-full sm:max-w-md" data-slot="batch-limit-prompt">
        <AlertDialogHeader>
          <AlertDialogTitle>{t("files.limitTitle")}</AlertDialogTitle>
          <AlertDialogDescription>
            {joinSentences(
              over,
              fit > 0 ? t("files.limitChoice", { count: fit }) : t("files.limitNone"),
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel data-action="batch-limit-give-up">
            {t("files.limitGiveUp")}
          </AlertDialogCancel>
          {fit > 0 ? (
            <AlertDialogAction data-action="batch-limit-take" onClick={() => onAnswer(true)}>
              {t(limit?.kind === "open" ? "files.limitTakeOpen" : "files.limitTakeMerge", {
                count: fit,
              })}
            </AlertDialogAction>
          ) : null}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
