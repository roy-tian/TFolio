import {
  type ChangeEvent,
  type DragEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react"
import { invoke } from "@tauri-apps/api/core"
import {
  Bookmark,
  FileUp,
  LoaderCircle,
  RotateCw,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { BookmarkSidebar } from "@/components/BookmarkSidebar"
import { PdfPage } from "@/components/PdfPage"
import { SettingsDialog } from "@/components/SettingsDialog"
import { Button } from "@/components/ui/button"
import {
  isPdfFile,
  MAX_PDF_BYTES,
  type PdfDocumentInfo,
} from "@/lib/pdf"

type ViewerError = "fileTooLarge" | "invalidFile" | "openFailed" | null

function closePdf(documentId: number) {
  void invoke("close_pdf", { documentId }).catch(() => undefined)
}

export default function App() {
  const { t } = useTranslation()
  const [pdfDocument, setPdfDocument] = useState<PdfDocumentInfo | null>(null)
  const [fileName, setFileName] = useState("")
  const [currentPage, setCurrentPage] = useState(0)
  const [pageInput, setPageInput] = useState("0")
  const [rotation, setRotation] = useState(0)
  const [bookmarksOpen, setBookmarksOpen] = useState(false)
  const [isDragging, setIsDragging] = useState(false)
  const [isLoading, setIsLoading] = useState(false)
  const [viewerError, setViewerError] = useState<ViewerError>(null)
  const [viewerWidth, setViewerWidth] = useState(0)
  const viewerRef = useRef<HTMLElement>(null)
  const documentRef = useRef<PdfDocumentInfo | null>(null)
  const requestIdRef = useRef(0)
  const dragDepthRef = useRef(0)

  const loadPdf = useCallback(async (file: File) => {
    if (!isPdfFile(file)) {
      setViewerError("invalidFile")
      return
    }

    if (file.size > MAX_PDF_BYTES) {
      setViewerError("fileTooLarge")
      return
    }

    const requestId = ++requestIdRef.current
    setViewerError(null)
    setIsLoading(true)
    setFileName(file.name)
    setCurrentPage(0)
    setRotation(0)
    setBookmarksOpen(false)
    setPdfDocument(null)

    const previousDocument = documentRef.current
    documentRef.current = null

    if (previousDocument) {
      closePdf(previousDocument.id)
    }

    try {
      const data = new Uint8Array(await file.arrayBuffer())

      if (requestId !== requestIdRef.current) {
        return
      }

      const nextDocument = await invoke<PdfDocumentInfo>("open_pdf", data)

      if (requestId !== requestIdRef.current) {
        closePdf(nextDocument.id)
        return
      }

      documentRef.current = nextDocument
      setPdfDocument(nextDocument)
      setCurrentPage(1)
    } catch {
      if (requestId === requestIdRef.current) {
        setFileName("")
        setViewerError("openFailed")
      }
    } finally {
      if (requestId === requestIdRef.current) {
        setIsLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    return () => {
      requestIdRef.current += 1

      if (documentRef.current) {
        closePdf(documentRef.current.id)
        documentRef.current = null
      }
    }
  }, [])

  useEffect(() => {
    setPageInput(String(currentPage))
  }, [currentPage])

  useEffect(() => {
    const viewer = viewerRef.current

    if (!viewer) {
      return
    }

    let resizeTimer: ReturnType<typeof setTimeout> | undefined
    let committedWidth = 0

    const commitWidth = (width: number) => {
      const roundedWidth = Math.round(width)

      if (roundedWidth !== committedWidth) {
        committedWidth = roundedWidth
        setViewerWidth(roundedWidth)
      }
    }

    commitWidth(viewer.clientWidth)

    const resizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? viewer.clientWidth
      clearTimeout(resizeTimer)
      resizeTimer = setTimeout(() => commitWidth(width), 180)
    })
    resizeObserver.observe(viewer)

    return () => {
      clearTimeout(resizeTimer)
      resizeObserver.disconnect()
    }
  }, [])

  useEffect(() => {
    const viewer = viewerRef.current

    if (!viewer || !pdfDocument) {
      return
    }

    let animationFrame = 0
    const visiblePages = new Set<HTMLElement>()

    const updateCurrentPage = () => {
      cancelAnimationFrame(animationFrame)
      animationFrame = requestAnimationFrame(() => {
        if (visiblePages.size === 0) {
          return
        }

        const viewerBounds = viewer.getBoundingClientRect()
        const readingLine = viewerBounds.top + Math.min(viewerBounds.height / 3, 240)
        let nearestPage = 1
        let nearestDistance = Number.POSITIVE_INFINITY

        for (const page of visiblePages) {
          const pageBounds = page.getBoundingClientRect()
          const distance =
            readingLine >= pageBounds.top && readingLine <= pageBounds.bottom
              ? 0
              : Math.min(
                  Math.abs(readingLine - pageBounds.top),
                  Math.abs(readingLine - pageBounds.bottom),
                )

          if (distance < nearestDistance) {
            nearestDistance = distance
            nearestPage = Number(page.dataset.pageNumber)
          }
        }

        setCurrentPage(nearestPage)
      })
    }

    const visibilityObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const page = entry.target as HTMLElement

          if (entry.isIntersecting) {
            visiblePages.add(page)
          } else {
            visiblePages.delete(page)
          }
        }

        updateCurrentPage()
      },
      { root: viewer },
    )

    for (const page of viewer.querySelectorAll<HTMLElement>(
      "[data-page-number]",
    )) {
      visibilityObserver.observe(page)
    }

    viewer.addEventListener("scroll", updateCurrentPage, { passive: true })

    return () => {
      cancelAnimationFrame(animationFrame)
      visibilityObserver.disconnect()
      viewer.removeEventListener("scroll", updateCurrentPage)
    }
  }, [pdfDocument])

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) {
      return
    }

    event.preventDefault()
    dragDepthRef.current += 1
    setIsDragging(true)
  }

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (event.dataTransfer.types.includes("Files")) {
      event.preventDefault()
      event.dataTransfer.dropEffect = "copy"
    }
  }

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1)

    if (dragDepthRef.current === 0) {
      setIsDragging(false)
    }
  }

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault()
    dragDepthRef.current = 0
    setIsDragging(false)

    const droppedFile = Array.from(event.dataTransfer.files).find(isPdfFile)

    if (!droppedFile) {
      setViewerError("invalidFile")
      return
    }

    void loadPdf(droppedFile)
  }

  const handleFileInput = (event: ChangeEvent<HTMLInputElement>) => {
    const selectedFile = event.target.files?.[0]
    event.target.value = ""

    if (selectedFile) {
      void loadPdf(selectedFile)
    }
  }

  const scrollToPage = (pageNumber: number) => {
    const page = viewerRef.current?.querySelector<HTMLElement>(
      `[data-page-number="${pageNumber}"]`,
    )

    setCurrentPage(pageNumber)
    page?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  const submitPageNumber = () => {
    if (!pdfDocument) {
      setPageInput("0")
      return
    }

    const requestedPage = Number(pageInput)

    if (!Number.isInteger(requestedPage)) {
      setPageInput(String(currentPage))
      return
    }

    const pageNumber = Math.min(
      pdfDocument.numPages,
      Math.max(1, requestedPage),
    )
    setPageInput(String(pageNumber))
    scrollToPage(pageNumber)
  }

  const errorMessage =
    viewerError === "fileTooLarge"
      ? t("viewer.fileTooLarge")
      : viewerError === "invalidFile"
        ? t("viewer.invalidFile")
        : viewerError === "openFailed"
          ? t("viewer.openFailed")
          : null

  return (
    <div
      className="h-svh overflow-hidden bg-background"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      <header className="fixed inset-x-0 top-0 z-50 grid h-12 grid-cols-[1fr_auto_1fr] items-center border-b bg-background/95 px-2 shadow-xs backdrop-blur">
        <div className="justify-self-start">
          <Button
            aria-label={
              bookmarksOpen
                ? t("toolbar.hideBookmarks")
                : t("toolbar.showBookmarks")
            }
            aria-pressed={bookmarksOpen}
            className={
              bookmarksOpen
                ? "text-foreground"
                : "text-muted-foreground"
            }
            disabled={!pdfDocument}
            onClick={() => setBookmarksOpen((isOpen) => !isOpen)}
            size="icon"
            title={
              bookmarksOpen
                ? t("toolbar.hideBookmarks")
                : t("toolbar.showBookmarks")
            }
            variant="ghost"
          >
            <Bookmark className={bookmarksOpen ? "fill-current" : undefined} />
          </Button>
        </div>

        <div
          aria-label={t("toolbar.pageStatus", {
            current: currentPage,
            total: pdfDocument?.numPages ?? 0,
          })}
          className="flex min-w-24 items-center justify-center gap-2 font-mono text-sm tabular-nums"
          role="group"
        >
          <input
            aria-label={t("toolbar.pageNumberInput")}
            className="h-7 w-10 rounded-md border bg-background px-1 text-center font-mono text-sm tabular-nums outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:cursor-default disabled:bg-muted disabled:text-muted-foreground"
            disabled={!pdfDocument}
            inputMode="numeric"
            onBlur={() => setPageInput(String(currentPage))}
            onChange={(event) =>
              setPageInput(event.target.value.replaceAll(/[^0-9]/g, ""))
            }
            onFocus={(event) => event.currentTarget.select()}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault()
                submitPageNumber()
                event.currentTarget.blur()
              }
            }}
            type="text"
            value={pageInput}
          />
          <span className="text-muted-foreground">/</span>
          <span>{pdfDocument?.numPages ?? 0}</span>
          <span aria-live="polite" className="sr-only">
            {t("toolbar.pageStatus", {
              current: currentPage,
              total: pdfDocument?.numPages ?? 0,
            })}
          </span>
        </div>

        <div className="flex items-center gap-1 justify-self-end">
          <Button
            aria-label={t("toolbar.rotate")}
            disabled={!pdfDocument}
            onClick={() => setRotation((value) => (value + 90) % 360)}
            size="icon"
            title={t("toolbar.rotate")}
            variant="ghost"
          >
            <RotateCw />
          </Button>
          <SettingsDialog />
        </div>
      </header>

      <div className="flex h-full pt-12">
        {pdfDocument && bookmarksOpen ? (
          <BookmarkSidebar
            items={pdfDocument.outline}
            onNavigate={scrollToPage}
          />
        ) : null}

        <main
          className="relative min-w-0 flex-1 overflow-auto bg-zinc-200/70 dark:bg-zinc-950"
          ref={viewerRef}
        >
          {pdfDocument ? (
            <div
              aria-label={fileName}
              className="flex min-h-full flex-col items-center gap-5 px-8 py-8"
            >
              {pdfDocument.pages.map((page, index) => (
                <PdfPage
                  availableWidth={viewerWidth}
                  documentId={pdfDocument.id}
                  key={`${pdfDocument.id}-${index + 1}`}
                  page={page}
                  pageNumber={index + 1}
                  rotation={rotation}
                />
              ))}
            </div>
          ) : (
            <div className="grid min-h-full place-items-center p-8">
              <label className="group flex w-full max-w-xl cursor-pointer flex-col items-center rounded-2xl border border-dashed border-zinc-400 bg-background/75 px-8 py-14 text-center shadow-sm transition-colors hover:border-foreground/40 hover:bg-background focus-within:ring-3 focus-within:ring-ring/50 dark:border-zinc-700">
                {isLoading ? (
                  <LoaderCircle className="mb-5 size-10 animate-spin text-muted-foreground" />
                ) : (
                  <FileUp className="mb-5 size-10 text-muted-foreground transition-transform group-hover:-translate-y-0.5" />
                )}
                <span className="text-lg font-semibold">
                  {isLoading ? t("viewer.loading") : t("viewer.dropTitle")}
                </span>
                <span className="mt-2 text-sm text-muted-foreground">
                  {fileName || t("viewer.dropDescription")}
                </span>
                <input
                  accept="application/pdf,.pdf"
                  aria-label={t("viewer.chooseFile")}
                  className="sr-only"
                  disabled={isLoading}
                  onChange={handleFileInput}
                  type="file"
                />
                {errorMessage ? (
                  <span className="mt-4 text-sm text-destructive" role="alert">
                    {errorMessage}
                  </span>
                ) : null}
              </label>
            </div>
          )}
        </main>
      </div>

      {isDragging ? (
        <div className="pointer-events-none fixed inset-3 top-15 z-40 grid place-items-center rounded-2xl border-2 border-dashed border-primary/60 bg-background/90 backdrop-blur-sm">
          <div className="flex flex-col items-center text-center">
            <FileUp className="mb-4 size-12" />
            <p className="text-lg font-semibold">{t("viewer.dropNow")}</p>
            <p className="mt-1 text-sm text-muted-foreground">
              {t("viewer.replaceHint")}
            </p>
          </div>
        </div>
      ) : null}

      {pdfDocument && errorMessage ? (
        <div
          className="fixed right-4 top-16 z-40 rounded-lg border border-destructive/20 bg-background px-4 py-2 text-sm text-destructive shadow-lg"
          role="alert"
        >
          {errorMessage}
        </div>
      ) : null}
    </div>
  )
}
