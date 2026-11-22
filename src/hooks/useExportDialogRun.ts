import { useCallback, useRef, useState } from "react"
import { invoke } from "@tauri-apps/api/core"

import type { PdfProgress } from "@/lib/progress"

/** Shared single-flight lifecycle (busy guard, progress, and stop request) for
    the modal export dialogs. */
export function useExportDialogRun(
  documentId: number,
  cancelCommand: "cancel_pdf_archive" | "cancel_pdf_compression" | "cancel_pdf_operation",
) {
  const [busy, setBusy] = useState(false)
  const [stopping, setStopping] = useState(false)
  const [progress, setProgress] = useState<PdfProgress | null>(null)
  const busyRef = useRef(false)
  // Asked again with every progress report until the engine is there to hear it.
  const stopRequested = useRef(false)

  const sendCancel = useCallback(async () => {
    if (await invoke<boolean>(cancelCommand, { documentId }).catch(() => false)) {
      stopRequested.current = false
    }
  }, [cancelCommand, documentId])

  const requestStop = useCallback(() => {
    stopRequested.current = true
    setStopping(true)
    void sendCancel()
  }, [sendCancel])

  const run = useCallback(
    async <T,>(
      work: (onProgress: (next: PdfProgress) => void) => Promise<T>,
    ): Promise<{ outcome: T; ran: true } | { ran: false }> => {
      if (busyRef.current) {
        return { ran: false }
      }

      busyRef.current = true
      setBusy(true)
      setProgress(null)
      stopRequested.current = false

      try {
        const outcome = await work((next) => {
          setProgress(next)

          if (stopRequested.current) {
            void sendCancel()
          }
        })

        return { outcome, ran: true }
      } finally {
        busyRef.current = false
        setBusy(false)
        setStopping(false)
      }
    },
    [sendCancel],
  )

  return { busy, progress, requestStop, run, stopping }
}
