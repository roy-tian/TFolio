import { createContext, useCallback, useEffect, useRef, useState } from "react"

import { updateNeedsConfirmation, watchUnsavedWork } from "@/lib/unsavedWork"

import {
  downloadUpdate,
  formatUpdateError,
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
  installError: string | null
  dismiss: () => void
  download: () => void
  install: () => void
  requestInstall: () => void
  confirmingInstall: boolean
  setConfirmingInstall: (open: boolean) => void
  status: AppUpdateStatus
  visible: boolean
}

export const AppUpdateContext = createContext<AppUpdate | null>(null)

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
  const [installError, setInstallError] = useState<string | null>(null)
  const [confirmingInstall, setConfirmingInstall] = useState(false)
  const checkingInstall = useRef(false)

  useEffect(() => {
    const subscription = watchUnsavedWork(hasUnsavedWorkNow)
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
    setInstallError(null)
    // Every window hears the failed status with its message; keep the full
    // rejection in the console for diagnosis.
    void downloadUpdate().catch((error: unknown) => {
      console.warn("[updater] download failed:", error)
    })
  }, [])

  const install = useCallback(() => {
    setInstallFailed(false)
    setInstallError(null)
    // Only a refusal ever returns from this one: an install that took restarts
    // the app instead of answering.
    void installUpdate().catch((error: unknown) => {
      console.warn("[updater] install failed:", error)
      setInstallFailed(true)
      setInstallError(formatUpdateError(error))
    })
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
    installError,
    status,
    visible: shouldShowUpdate(status, dismissedState),
  }
}
