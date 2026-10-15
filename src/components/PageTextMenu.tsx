import { useRef, useState, type CSSProperties, type Ref } from "react"
import { Copy, Highlighter } from "lucide-react"
import { useTranslation } from "react-i18next"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import type { CaptureHighlight } from "@/hooks/useHighlightTool"
import { copyPlainText } from "@/lib/clipboard"
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

type PageTextMenuProps = {
  captureHighlight: CaptureHighlight
  /** Present only while the whole document's text stands selected, in which
      case it is that — not a drag over this page — the menu offers. */
  onCopyAll?: () => void
  style: CSSProperties
  textLayerRef: Ref<HTMLDivElement>
}

/** The page's right-click menu, standing in for the WebView's dropped one.
    Renders as the text layer itself, which `buildTextLayer` fills: React owns
    none of the spans, so it never reconciles a fragmented page's thousands. */
export function PageTextMenu({
  captureHighlight,
  onCopyAll,
  style,
  textLayerRef,
}: PageTextMenuProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // Taken as the menu opens, not as an item is clicked: pressing in the popup
  // collapses the very selection the copy and the highlight are of.
  const selected = useRef<string | Promise<string>>("")
  const [highlight, setHighlight] = useState<{ commit: () => void } | null>(null)

  return (
    <ContextMenu
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setOpen(false)

          return
        }

        const text = onCopyAll ? "" : selectedPageText()
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

        // A select-all is app state with no WebView range behind it, so it
        // leaves nothing here to mark.
        const commit = selected.current === "" ? null : captureHighlight()
        setHighlight(commit ? { commit } : null)
        setOpen(Boolean(onCopyAll) || selected.current !== "")
      }}
    >
      <ContextMenuTrigger className="pdf-text-layer select-text" style={style} ref={textLayerRef} />
      <ContextMenuContent>
        <ContextMenuItem
          data-action="copy-text"
          onClick={() => {
            if (onCopyAll) {
              onCopyAll()
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
        {highlight ? (
          <ContextMenuItem data-action="highlight-text" onClick={highlight.commit}>
            <Highlighter />
            {t("viewer.highlightText")}
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}
