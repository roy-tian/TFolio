import { useRef, useState, type CSSProperties, type ReactNode, type Ref } from "react"
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

/** What the reader has selected, but only where the selection is a page's own
    text: everything else on screen is chrome, with nothing to take from it. */
function selectedPageText(): string {
  const selection = window.getSelection()

  if (!selection || selection.isCollapsed) {
    return ""
  }

  const node = selection.anchorNode
  const element = node instanceof Element ? node : node?.parentElement

  return element?.closest(".pdf-text-layer") ? selection.toString() : ""
}

type PageTextMenuProps = {
  captureHighlight: CaptureHighlight
  children: ReactNode
  /** Present only while the whole document's text stands selected, in which
      case it is that — not a drag over this page — the menu offers. */
  onCopyAll?: () => void
  style: CSSProperties
  textLayerRef: Ref<HTMLDivElement>
}

/** The page's right-click menu, standing in for the WebView's dropped one.
    Renders as the text layer itself, so the spans keep the layout they got. */
export function PageTextMenu({
  captureHighlight,
  children,
  onCopyAll,
  style,
  textLayerRef,
}: PageTextMenuProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // Taken as the menu opens, not as an item is clicked: pressing in the popup
  // collapses the very selection the copy and the highlight are of.
  const selected = useRef("")
  const [highlight, setHighlight] = useState<{ commit: () => void } | null>(null)

  return (
    <ContextMenu
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setOpen(false)

          return
        }

        selected.current = onCopyAll ? "" : selectedPageText()
        // A select-all is app state with no WebView range behind it, so it
        // leaves nothing here to mark.
        const commit = selected.current === "" ? null : captureHighlight()
        setHighlight(commit ? { commit } : null)
        setOpen(Boolean(onCopyAll) || selected.current !== "")
      }}
    >
      <ContextMenuTrigger className="pdf-text-layer select-text" style={style} ref={textLayerRef}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem
          data-action="copy-text"
          onClick={() =>
            onCopyAll ? onCopyAll() : copyPlainText(selected.current)
          }
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
