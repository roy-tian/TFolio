import { useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from "react"
import { Copy, Highlighter } from "lucide-react"
import { useTranslation } from "react-i18next"

import {
  buildPageMenuItems,
  PageMenuItems,
  runPageMenuAction,
  type PageMenuActions,
} from "@/components/PageContextMenu"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import type { CaptureHighlight } from "@/hooks/useHighlightTool"
import { copyPlainText } from "@/lib/clipboard"
import { popupNativeContextMenu, type NativeContextMenuItem } from "@/lib/nativeMenu"
import type { PdfPageInfo } from "@/lib/pdf"
import { isMacOS } from "@/lib/platform"
import { selectedPagesText } from "@/lib/selectionText"

/** What the reader has selected, but only where the selection is a page's own
    text: everything else on screen is chrome, with nothing to take from it. */
function selectedPageText(): string | Promise<string> {
  const selection = window.getSelection()
  const pages = selectedPagesText(selection)

  if (pages !== null) {
    return pages
  }

  // Started in page text but ending past every page, as a keyboard or native
  // drag can leave it: there is no page to split by, only the WebView's text.
  const anchor = selection?.anchorNode
  const element = anchor instanceof Element ? anchor : anchor?.parentElement

  return selection && !selection.isCollapsed && element?.closest(".pdf-text-layer")
    ? selection.toString()
    : ""
}

type ViewerMenuProps = {
  captureHighlight: CaptureHighlight
  children: ReactNode
  /** Present only while the whole document's text stands selected, in which
      case it is that — not a drag over one page — the menu offers. */
  onCopyAllText?: () => void
  /** What the page pressed offers, that page alone: read as the menu shows,
      so it acts on the document as it stands. */
  pageMenu: (pageNumber: number) => PageMenuActions
  /** The pages as they stand: an edit landing under the open menu renumbers
      them, and the menu then closes rather than act on another page. */
  pages: PdfPageInfo[]
  /** The viewer's scroll box, which the menu opens over. */
  viewer: ReactElement<{ onContextMenu?: (event: MouseEvent<Element>) => void }>
}

/**
 * The reading view's right-click menu, standing in for the WebView's dropped
 * one: over a page's text, what the selection offers; on a page, what the
 * sidebar's menu offers of it, so turning or removing a page needs no sidebar.
 * One menu for the whole view, because a menu on each page's text would take
 * the press from any around it: the trigger stops the event where it lands.
 */
export function ViewerMenu({
  captureHighlight,
  children,
  onCopyAllText,
  pageMenu,
  pages,
  viewer,
}: ViewerMenuProps) {
  const { t } = useTranslation()
  const macOS = isMacOS()
  const pagesRef = useRef(pages)
  pagesRef.current = pages
  // Taken as the menu opens, not as an item is clicked: pressing in the popup
  // collapses the very selection the copy and the highlight are of.
  const selected = useRef<string | Promise<string>>("")
  const [menu, setMenu] = useState<{
    anchor?: { getBoundingClientRect: () => DOMRect }
    highlight: (() => void) | null
    pageNumber: number | null
    pages: PdfPageInfo[]
    text: boolean
  } | null>(null)
  // Re-enables the DOM context menu for the current pages snapshot if the
  // native NSMenu popup fails on macOS.
  const [nativeFallbackPages, setNativeFallbackPages] = useState<PdfPageInfo[] | null>(null)
  const nativeFallback = nativeFallbackPages === pages
  const shown = menu?.pages === pages ? menu : null

  const open = (event: MouseEvent<Element>) => {
    const target = event.target as Element
    const overText = target.closest(".pdf-text-layer") !== null
    const text = overText && !onCopyAllText ? selectedPageText() : ""
    const takesText = overText && (Boolean(onCopyAllText) || text !== "")
    const page = target.closest<HTMLElement>("[data-page-number]")
    const pageNumber = page ? Number(page.dataset.pageNumber) : null
    const highlight = text === "" ? null : captureHighlight()

    if (macOS && !nativeFallback) {
      if (!takesText && pageNumber === null) {
        return
      }

      event.preventDefault()

      // Capture pointer position before awaiting IPC so the React fallback can
      // anchor where the user clicked even when the trigger root was disabled.
      const point = { x: event.clientX, y: event.clientY }

      // Resolve in the open gesture so `copy-text` never reads a mutated ref
      // if another context event lands before the native menu returns.
      let resolvedText: string | null = typeof text === "string" ? text : null
      if (typeof text !== "string") {
        void text.then((settled) => {
          resolvedText = settled
        })
      }

      const items: NativeContextMenuItem[] = []
      if (takesText) {
        items.push({ kind: "item", id: "copy-text", label: t("viewer.copyText") })
        if (highlight) {
          items.push({ kind: "item", id: "highlight-text", label: t("viewer.highlightText") })
        }
      }

      const pageActions = pageNumber !== null ? pageMenu(pageNumber) : null
      if (takesText && pageActions) {
        items.push({ kind: "separator" })
      }
      if (pageActions) {
        items.push(...buildPageMenuItems(pageActions, t))
      }

      const pagesSnapshot = pages
      const copyAllHandler = onCopyAllText

      void popupNativeContextMenu(items)
        .then((chosen) => {
          if (!chosen || pagesRef.current !== pagesSnapshot) {
            return
          }

          if (chosen === "copy-text") {
            if (copyAllHandler) {
              copyAllHandler()
            } else if (resolvedText !== null) {
              copyPlainText(resolvedText)
            } else if (typeof text !== "string") {
              void text.then(copyPlainText)
            }
            return
          }

          if (chosen === "highlight-text") {
            highlight?.()
            return
          }

          if (pageActions) {
            runPageMenuAction(chosen, pageActions)
          }
        })
        .catch((error: unknown) => {
          console.warn("Native viewer context menu failed:", error)
          if (pagesRef.current !== pagesSnapshot) {
            return
          }

          selected.current = resolvedText ?? text
          if (resolvedText === null && typeof text !== "string") {
            void text.then((settled) => {
              if (selected.current === text) {
                selected.current = settled
              }
            })
          }

          setNativeFallbackPages(pagesSnapshot)
          setMenu({
            anchor: {
              getBoundingClientRect: () =>
                DOMRect.fromRect({ height: 0, width: 0, x: point.x, y: point.y }),
            },
            highlight,
            pageNumber,
            pages: pagesSnapshot,
            text: takesText,
          })
        })
      return
    }

    if (!takesText && pageNumber === null) {
      setMenu(null)
      return
    }

    selected.current = text

    // Settled before the click, the copy writes within the click itself:
    // the clipboard refuses a write that trails its gesture.
    if (typeof text !== "string") {
      void text.then((settled) => {
        if (selected.current === text) {
          selected.current = settled
        }
      })
    }

    setMenu({
      // A select-all is app state with no WebView range behind it, so
      // it leaves nothing here to mark.
      highlight,
      pageNumber,
      pages,
      text: takesText,
    })
  }

  return (
    <ContextMenu
      disabled={macOS && !nativeFallback}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setNativeFallbackPages(null)
          setMenu(null)
        }
      }}
      // Opened by a press over a page or its selected text alone: elsewhere
      // in the view there is nothing for the entries to act on.
      open={(!macOS || nativeFallback) && shown !== null}
    >
      <ContextMenuTrigger onContextMenu={open} render={viewer}>
        {children}
      </ContextMenuTrigger>
      {shown ? (
        <ContextMenuContent anchor={shown.anchor}>
          {shown.text ? (
            <>
              <ContextMenuItem
                data-action="copy-text"
                onClick={() => {
                  if (onCopyAllText) {
                    onCopyAllText()
                  } else if (typeof selected.current === "string") {
                    copyPlainText(selected.current)
                  } else {
                    // A page between the ends is still on its way from PDFium.
                    void selected.current.then(copyPlainText)
                  }
                }}
              >
                <Copy />
                {t("viewer.copyText")}
              </ContextMenuItem>
              {shown.highlight ? (
                <ContextMenuItem data-action="highlight-text" onClick={shown.highlight}>
                  <Highlighter />
                  {t("viewer.highlightText")}
                </ContextMenuItem>
              ) : null}
            </>
          ) : null}
          {shown.text && shown.pageNumber !== null ? <ContextMenuSeparator /> : null}
          {shown.pageNumber !== null ? <PageMenuItems {...pageMenu(shown.pageNumber)} /> : null}
        </ContextMenuContent>
      ) : null}
    </ContextMenu>
  )
}
