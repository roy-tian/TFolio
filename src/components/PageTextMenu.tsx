import { useRef, useState, type CSSProperties, type ReactNode } from "react"
import { Copy } from "lucide-react"
import { useTranslation } from "react-i18next"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
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
  children: ReactNode
  /** Present only while the whole document's text stands selected, in which
      case it is that — not a drag over this page — the menu offers. */
  onCopyAll?: () => void
  style: CSSProperties
}

/** The page's right-click menu, standing in for the WebView's dropped one.
    Renders as the text layer itself, so the spans keep the layout they got. */
export function PageTextMenu({
  children,
  onCopyAll,
  style,
}: PageTextMenuProps) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  // Taken as the menu opens, not as the item is clicked: pressing in the popup
  // collapses the very selection the copy is of.
  const selected = useRef("")

  return (
    <ContextMenu
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setOpen(false)

          return
        }

        selected.current = onCopyAll ? "" : selectedPageText()
        setOpen(Boolean(onCopyAll) || selected.current !== "")
      }}
    >
      <ContextMenuTrigger className="pdf-text-layer select-text" style={style}>
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
      </ContextMenuContent>
    </ContextMenu>
  )
}
