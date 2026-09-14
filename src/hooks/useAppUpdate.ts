import { useCallback, useEffect, useRef, useState } from "react"

import { updateNeedsConfirmation, watchUpdateUnsaved } from "@/lib/updateUnsaved"

import {
  downloadUpdate,
  installUpdate,
  readUpdateStatus,
  shouldShowUpdate,
  watchUpdateStatus,
  type AppUpdateStatus,
} from "@/lib/update"

export type AppUpdate = {
  /** Set when an install was asked for and the platform would not take it. A
      failure of the press rather than of the update, which is still here. */
  installFailed: boolean
  dismiss: () => void
  download: () => void
  install: () => void
  requestInstall: () => void
  confirmingInstall: boolean
  setConfirmingInstall: (open: boolean) => void
  status: AppUpdateStatus
  visible: boolean
}

/**
 * The check, download and install are process-wide in the backend; this keeps
 * only what this window has been told and what its reader has waved away.
 */
export function useAppUpdate(hasUnsavedWorkNow: () => boolean): AppUpdate {
  const [status, setStatus] = useState<AppUpdateStatus>({ state: "idle" })
  const [dismissedState, setDismissedState] = useState<
    AppUpdateStatus["state"] | null
  >(null)
  const [installFailed, setInstallFailed] = useState(false)
  const [confirmingInstall, setConfirmingInstall] = useState(false)
  const checkingInstall = useRef(false)

  useEffect(() => {
    const subscription = watchUpdateUnsaved(hasUnsavedWorkNow)
    void subscription.catch(() => undefined)

    return () => {
      void subscription.then((unlisten) => unlisten()).catch(() => undefined)
    }
  }, [hasUnsavedWorkNow])

  useEffect(() => {
    let live = true
    let announced = false

    // The snapshot is read only once the subscription is up, so a check that
    // lands between the two is not lost — and never overwrites what it said.
    const subscription = watchUpdateStatus((next) => {
      announced = true

      if (live) {
        setStatus(next)
      }
    })

    void subscription
      .then(readUpdateStatus)
      .then((initial) => {
        if (live && !announced) {
          setStatus(initial)
        }
      })
      .catch(() => undefined)

    return () => {
      live = false
      void subscription.then((unlisten) => unlisten()).catch(() => undefined)
    }
  }, [])

  const dismiss = useCallback(() => setDismissedState(status.state), [status])

  const download = useCallback(() => {
    setInstallFailed(false)
    // A download that fails says so as a status of its own, which every window
    // hears; there is nothing left for the rejection here to add.
    void downloadUpdate().catch(() => undefined)
  }, [])

  const install = useCallback(() => {
    setInstallFailed(false)
    // Only a refusal ever returns from this one: an install that took restarts
    // the app instead of answering.
    void installUpdate().catch(() => setInstallFailed(true))
  }, [])

  const requestInstall = useCallback(() => {
    if (checkingInstall.current) {
      return
    }

    checkingInstall.current = true
    void updateNeedsConfirmation(hasUnsavedWorkNow).then((confirm) => {
      checkingInstall.current = false
      if (confirm) {
        setConfirmingInstall(true)
      } else {
        install()
      }
    })
  }, [hasUnsavedWorkNow, install])

  return {
    dismiss,
    download,
    install,
    requestInstall,
    confirmingInstall,
    setConfirmingInstall,
    installFailed,
    status,
    visible: shouldShowUpdate(status, dismissedState),
  }
}
