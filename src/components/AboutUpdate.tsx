import { useContext, useEffect, useState } from "react"
import { useTranslation } from "react-i18next"

import { Button } from "@/components/ui/button"
import { AppUpdateContext } from "@/hooks/useAppUpdate"
import {
  checkUpdates,
  formatUpdateError,
  openUpdateReleases,
} from "@/lib/update"

/** Mounted only while About is visible, so both menu paths check on each visit. */
export function AboutUpdate() {
  const { t } = useTranslation()
  const update = useContext(AppUpdateContext)
  const [checking, setChecking] = useState(true)
  const [checkFailed, setCheckFailed] = useState(false)
  const [checkError, setCheckError] = useState<string | null>(null)

  useEffect(() => {
    let live = true
    void checkUpdates()
      .catch((error: unknown) => {
        console.warn("[updater] check failed:", error)
        if (live) {
          setCheckFailed(true)
          setCheckError(formatUpdateError(error))
        }
      })
      .finally(() => {
        if (live) setChecking(false)
      })

    return () => { live = false }
  }, [])

  if (!update) return null

  const { status } = update
  const failedError =
    status.state === "failed" ? formatUpdateError(status.error) : null
  const errorDetail = checkError ?? failedError ?? update.installError
  const showReleases = checkFailed || status.state === "failed"

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
      {showReleases ? (
        <>
          {" "}
          <Button
            className="h-auto rounded-none p-0 align-baseline text-xs underline"
            data-action="about-update-releases"
            onClick={() => {
              void openUpdateReleases().catch((error: unknown) => {
                console.warn("[updater] open releases failed:", error)
              })
            }}
            variant="link"
          >
            {t("about.openReleases")}
          </Button>
        </>
      ) : null}
      {errorDetail ? (
        <span
          className="mt-1 block break-all font-mono text-[11px] text-muted-foreground/80"
          data-slot="about-update-error"
          title={errorDetail}
        >
          {errorDetail}
        </span>
      ) : null}
    </span>
  )
}
