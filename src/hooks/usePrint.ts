import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react"
import { invoke } from "@tauri-apps/api/core"

import type { PrintPage } from "@/components/PrintSheet"
import { e2eOverride } from "@/lib/e2e"
import type { PdfPageInfo } from "@/lib/pdf"
import { pngDataUrl, printDpi, printRenderWidth } from "@/lib/printSheet"
import type { PdfProgress } from "@/lib/progress"

type PrintOptions = {
  documentId: number | undefined
  onError: () => void
  pages: PdfPageInfo[]
}

/**
 * The sheet stays after the dialog opens: nothing reports when the job has
 * drawn, so taking the pages back out would print blank paper. It goes once
 * `afterprint` has fired and the reader is back in the window — the dialog,
 * and the job it ran, are over by then.
 */
export function usePrint({
  documentId,
  onError,
  pages,
}: PrintOptions) {
  const [preparing, setPreparing] = useState(false)
  const [progress, setProgress] = useState<PdfProgress>({
    completed: 0,
    total: 0,
  })
  const [sheet, setSheet] = useState<PrintPage[] | null>(null)
  // Bumped by anything that abandons a run in flight, which is what the render
  // loop checks between pages: a page already asked for cannot be called back.
  const runRef = useRef(0)
  const onErrorRef = useRef(onError)
  useLayoutEffect(() => {
    onErrorRef.current = onError
  }, [onError])

  const discard = useCallback(() => {
    runRef.current += 1
    setPreparing(false)
    setSheet(null)
  }, [])

  const start = useCallback(async () => {
    if (documentId === undefined || pages.length === 0) {
      return
    }

    const run = runRef.current + 1
    runRef.current = run
    setSheet(null)
    setPreparing(true)
    setProgress({ completed: 0, total: pages.length })

    const dpi = printDpi(pages.length)
    const printed: PrintPage[] = []

    try {
      for (const [index, page] of pages.entries()) {
        const pageNumber = index + 1
        const bytes = await invoke<ArrayBuffer>("render_pdf_page", {
          documentId,
          pageNumber,
          width: printRenderWidth(page.width, dpi),
        })

        if (runRef.current !== run) {
          return
        }

        printed.push({ pageNumber, src: pngDataUrl(bytes) })
        setProgress({ completed: pageNumber, total: pages.length })
      }
    } catch {
      if (runRef.current === run) {
        setPreparing(false)
        onErrorRef.current()
      }

      return
    }

    // The dialog waits on the effect below, which cannot open it until React
    // has put these images in the document for the printer to draw.
    setSheet(printed)
  }, [documentId, pages])

  useEffect(() => {
    if (!sheet) {
      return
    }

    let cancelled = false

    const openDialog = async () => {
      const images = [
        ...document.querySelectorAll<HTMLImageElement>(
          "[data-print-sheet] img",
        ),
      ]
      // A page still decoding when the printer draws would come out blank, and
      // the sheet never paints on screen to force it.
      await Promise.all(
        images.map((image) => image.decode().catch(() => undefined)),
      )

      if (cancelled) {
        return
      }

      // The OS dialog holds the window for as long as it is up, so this one is
      // told to close first and given the frame that starts it fading out.
      setPreparing(false)
      await new Promise(requestAnimationFrame)

      // A stop landing in that frame has already taken the sheet out of the
      // document, and the dialog would then be opened on nothing to print.
      if (cancelled) {
        return
      }

      const openSystemDialog = e2eOverride("printWindow")

      await (openSystemDialog ? openSystemDialog() : invoke("print_window"))
    }

    void openDialog().catch(() => {
      if (!cancelled) {
        setPreparing(false)
        onErrorRef.current()
      }
    })

    const release = () => discard()
    const releaseOnReturn = () => {
      window.addEventListener("pointerdown", release, { capture: true, once: true })
      window.addEventListener("keydown", release, { capture: true, once: true })
    }

    window.addEventListener("afterprint", releaseOnReturn, { once: true })

    return () => {
      cancelled = true
      window.removeEventListener("afterprint", releaseOnReturn)
      window.removeEventListener("pointerdown", release, { capture: true })
      window.removeEventListener("keydown", release, { capture: true })
    }
  }, [discard, sheet])

  return { discard, preparing, progress, sheet, start }
}
