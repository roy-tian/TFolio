import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { DismissibleAlert } from "@/components/DismissibleAlert"
import { OperationProgress } from "@/components/OperationProgress"
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
import { Button } from "@/components/ui/button"
import type { AppUpdate } from "@/hooks/useAppUpdate"
import { cn } from "@/lib/utils"

type UpdateToastProps = {
  className?: string
  update: AppUpdate
}

/**
 * What a new release looks like from inside the app: a notice with the version
 * on it, then the download, then the install. It never announces that the app
 * is current — an update the reader does not have is the only thing worth
 * interrupting them for.
 */
export function UpdateToast({ className, update }: UpdateToastProps) {
  const { t } = useTranslation()
  const [confirming, setConfirming] = useState(false)
  const { status, visible } = update

  // A confirmation left standing when the notice went away would spring open
  // by itself the next time one is shown.
  useEffect(() => {
    if (!visible) {
      setConfirming(false)
    }
  }, [visible])

  if (!visible) {
    return null
  }

  const failed = status.state === "failed"
  // The whole notice turns, not only the line that says so: a download that
  // never arrived and an install the platform refused are the same news to
  // whoever is looking at the corner of the screen.
  const alarming = failed || update.installFailed

  const action =
    status.state === "available"
      ? { label: t("update.download"), run: update.download }
      : status.state === "ready"
        ? { label: t("update.install"), run: () => setConfirming(true) }
        : failed
          ? { label: t("update.retry"), run: update.download }
          : null

  const message =
    status.state === "available"
      ? t("update.available", { version: status.version })
      : status.state === "ready"
        ? t("update.ready", { version: status.version })
        : failed
          ? t("update.failed")
          : null

  return (
    <>
      <DismissibleAlert
        autoDismiss={false}
        className={cn(
          "rounded-lg border px-4 py-2 text-sm shadow-lg",
          // Good news carries the app's green; only a download that did not
          // arrive borrows the red a refusal is written in.
          alarming
            ? "border-destructive/25 bg-destructive/10"
            : "border-success/25 bg-success/10",
          className,
        )}
        onDismiss={update.dismiss}
        role={status.state === "downloading" ? "status" : "alert"}
      >
        {/* The message keeps the line and the button ends it, in front of the
            alert's own dismiss — a notice is one row, whatever it says. */}
        <div className="flex items-center gap-3" data-testid="update-toast">
          {status.state === "downloading" ? (
            <OperationProgress
              className="min-w-0 flex-1"
              label={t("update.downloading", { version: status.version })}
              progress={
                status.total === null
                  ? null
                  : { completed: status.received, total: status.total }
              }
            />
          ) : (
            <>
              <div className="min-w-0 flex-1">
                <p className={cn(failed && "text-destructive")}>{message}</p>
                {update.installFailed ? (
                  <p className="text-destructive">{t("update.installFailed")}</p>
                ) : null}
              </div>
              {action ? (
                <Button className="shrink-0" onClick={action.run} size="sm">
                  {action.label}
                </Button>
              ) : null}
            </>
          )}
        </div>
      </DismissibleAlert>

      <AlertDialog onOpenChange={setConfirming} open={confirming}>
        {/* The wider of the two sizes: the paragraph has to say both what the
            restart costs and that leaving is free, and neither answer is short. */}
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("update.installTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("update.installDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {/* Stacked, and the way out first: neither label shares a row, and
              the one that discards work should not be the easy one to hit. */}
          <AlertDialogFooter className="flex-col sm:flex-col">
            <AlertDialogCancel>{t("update.installCancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirming(false)
                update.install()
              }}
              variant="destructive"
            >
              {t("update.installDiscard")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
