import { ClipboardPaste, Copy, RotateCcw, RotateCw, Scissors, Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"

import { InsertAfterIcon, InsertBeforeIcon } from "@/components/InsertPageIcon"
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"

/** Before the first of the menu's pages, or after the last. */
export type PageMenuSide = "before" | "after"

type PageMenuContentProps = {
  canPaste: boolean
  /** The pages the menu acts on: the selection, which a right-click outside it
      has already moved to the page under the pointer. */
  count: number
  deleteDisabled?: boolean
  onCopy: () => void
  onCut: () => void
  onDelete: () => void
  onInsertBlank: (side: PageMenuSide) => void
  onPaste: (side: PageMenuSide) => void
  onRotate: (degrees: 90 | 270) => void
}

/** A page's right-click menu in the sidebar, which also acts on a choice. */
export function PageMenuContent({
  canPaste,
  count,
  deleteDisabled = false,
  onCopy,
  onCut,
  onDelete,
  onInsertBlank,
  onPaste,
  onRotate,
}: PageMenuContentProps) {
  const { t } = useTranslation()

  return (
    <ContextMenuContent>
      <ContextMenuItem data-action="rotate-pages" onClick={() => onRotate(90)}>
        <RotateCw />
        {t("pageEdit.rotate", { count })}
      </ContextMenuItem>
      <ContextMenuItem data-action="rotate-pages-left" onClick={() => onRotate(270)}>
        <RotateCcw />
        {t("pageEdit.rotateLeft", { count })}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem data-action="cut-pages" onClick={onCut}>
        <Scissors />
        {t("pageEdit.cut", { count })}
      </ContextMenuItem>
      <ContextMenuItem data-action="copy-pages" onClick={onCopy}>
        <Copy />
        {t("pageEdit.copy", { count })}
      </ContextMenuItem>
      {canPaste ? (
        <>
          <ContextMenuItem
            data-action="paste-pages-before"
            onClick={() => onPaste("before")}
          >
            <ClipboardPaste />
            {t("pageEdit.pasteBefore")}
          </ContextMenuItem>
          <ContextMenuItem
            data-action="paste-pages-after"
            onClick={() => onPaste("after")}
          >
            <ClipboardPaste />
            {t("pageEdit.pasteAfter")}
          </ContextMenuItem>
        </>
      ) : null}
      <ContextMenuItem
        data-action="insert-blank-before"
        onClick={() => onInsertBlank("before")}
      >
        <InsertBeforeIcon />
        {t("pageEdit.insertBlankBefore")}
      </ContextMenuItem>
      <ContextMenuItem
        data-action="insert-blank-after"
        onClick={() => onInsertBlank("after")}
      >
        <InsertAfterIcon />
        {t("pageEdit.insertBlankAfter")}
      </ContextMenuItem>
      <ContextMenuSeparator />
      <ContextMenuItem
        data-action="delete-pages"
        disabled={deleteDisabled}
        onClick={onDelete}
        variant="destructive"
      >
        <Trash2 />
        {t("pageEdit.delete", { count })}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}

/** Where in a file a paste lands: before its first page, or after its last. */
export type FileMenuEnd = "start" | "end"

/** A file's right-click menu, by its name: pastes that join it at either end. */
export function FileMenuContent({
  canPaste,
  onPaste,
}: {
  canPaste: boolean
  onPaste: (end: FileMenuEnd) => void
}) {
  const { t } = useTranslation()

  return (
    <ContextMenuContent>
      <ContextMenuItem
        data-action="paste-file-start"
        disabled={!canPaste}
        onClick={() => onPaste("start")}
      >
        <ClipboardPaste />
        {t("pageEdit.pasteFileStart")}
      </ContextMenuItem>
      <ContextMenuItem
        data-action="paste-file-end"
        disabled={!canPaste}
        onClick={() => onPaste("end")}
      >
        <ClipboardPaste />
        {t("pageEdit.pasteFileEnd")}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}
