import { useRef, useState, type MouseEvent, type ReactElement, type ReactNode } from "react"
import { Copy, Highlighter } from "lucide-react"
import { useTranslation } from "react-i18next"

import { PageMenuItems, type PageMenuActions } from "@/components/PageContextMenu"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import type { CaptureHighlight } from "@/hooks/useHighlightTool"
import { copyPlainText } from "@/lib/clipboard"
import type { PdfPageInfo } from "@/lib/pdf"
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
  viewer: ReactElement
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
  // Taken as the menu opens, not as an item is clicked: pressing in the popup
  // collapses the very selection the copy and the highlight are of.
  const selected = useRef<string | Promise<string>>("")
  const [menu, setMenu] = useState<{
    highlight: (() => void) | null
    pageNumber: number | null
    pages: PdfPageInfo[]
    text: boolean
  } | null>(null)
  const shown = menu?.pages === pages ? menu : null

  const open = (event: MouseEvent) => {
    const target = event.target as Element
    const overText = target.closest(".pdf-text-layer") !== null
    const text = overText && !onCopyAllText ? selectedPageText() : ""

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

    const takesText = overText && (Boolean(onCopyAllText) || text !== "")
    const page = target.closest<HTMLElement>("[data-page-number]")
    const pageNumber = page ? Number(page.dataset.pageNumber) : null

    setMenu(
      takesText || pageNumber !== null
        ? {
            // A select-all is app state with no WebView range behind it, so
            // it leaves nothing here to mark.
            highlight: text === "" ? null : captureHighlight(),
            pageNumber,
            pages,
            text: takesText,
          }
        : null,
    )
  }

  return (
    <ContextMenu
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setMenu(null)
        }
      }}
      // Opened by a press over a page or its selected text alone: elsewhere
      // in the view there is nothing for the entries to act on.
      open={shown !== null}
    >
      {/* The trigger's own `select-none` would take the pages' text with it. */}
      <ContextMenuTrigger className="select-auto" onContextMenu={open} render={viewer}>
        {children}
      </ContextMenuTrigger>
      {shown ? (
        <ContextMenuContent>
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
