import { useEffect, type ReactNode } from "react"
import { X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

const AUTO_DISMISS_MS = 5_000

type DismissibleAlertProps = {
  /** Pauses expiry while an action in the alert is still running. */
  autoDismiss?: boolean
  children: ReactNode
  className?: string
  /** Changes when a new message replaces the current one, restarting expiry. */
  dismissKey?: string | number | null
  onDismiss: () => void
}

/** A transient alert that can also be dismissed immediately without waiting. */
export function DismissibleAlert({
  autoDismiss = true,
  children,
  className,
  dismissKey,
  onDismiss,
}: DismissibleAlertProps) {
  const { t } = useTranslation()

  useEffect(() => {
    if (!autoDismiss) {
      return
    }

    const timer = window.setTimeout(onDismiss, AUTO_DISMISS_MS)

    return () => window.clearTimeout(timer)
  }, [autoDismiss, dismissKey, onDismiss])

  return (
    <div className={cn("flex items-center gap-2", className)} role="alert">
      <div className="min-w-0 flex-1">{children}</div>
      <Button
        aria-label={t("notification.dismiss")}
        // The alert's own colour, so a refusal keeps its red and a plain notice
        // does not borrow one.
        className="-my-1 -mr-2 text-current hover:bg-current/10 hover:text-current"
        onClick={onDismiss}
        size="icon-sm"
        type="button"
        variant="ghost"
      >
        <X />
      </Button>
    </div>
  )
}
