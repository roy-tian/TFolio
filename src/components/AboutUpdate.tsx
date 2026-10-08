import { useContext, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { AppUpdateContext } from "@/hooks/useAppUpdate"
import { checkUpdates } from "@/lib/update"

/** Mounted only while About is visible, so both menu paths check on each visit. */
export function AboutUpdate() {
  const { t } = useTranslation()
  const update = useContext(AppUpdateContext)
  const [checking, setChecking] = useState(true)
  const [checkFailed, setCheckFailed] = useState(false)

  useEffect(() => {
    let live = true
    void checkUpdates()
      .catch(() => {
        if (live) setCheckFailed(true)
      })
      .finally(() => {
        if (live) setChecking(false)
      })

    return () => { live = false }
  }, [])

  if (!update) return null

  const { status } = update

  return (
    <span aria-live="polite" data-slot="about-update">
      {status.state !== "idle" ? (
        <>
          {t("about.updateAvailable", { version: status.version })}{" "}
          {status.state === "downloading" ? (
            <span>
              {t("about.downloading")}
              {status.total && status.total > 0
                ? ` ${Math.min(100, Math.floor(status.received * 100 / status.total))}%`
                : null}
            </span>
          ) : (
            <Button
              className="h-auto rounded-none p-0 align-baseline text-xs underline"
              data-action="about-update"
              disabled={checking}
              onClick={status.state === "ready" ? update.requestInstall : update.download}
              variant="link"
            >
              {status.state === "ready" ? t("about.installNow") : t("about.updateNow")}
            </Button>
          )}
          {status.state === "failed" ? ` ${t("update.failed")}` : null}
          {update.installFailed ? ` ${t("update.installFailed")}` : null}
        </>
      ) : checking ? t("about.checking") : null}
      {checkFailed ? ` ${t("about.checkFailed")}` : null}
    </span>
  )
}
