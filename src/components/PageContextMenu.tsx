import {
  ClipboardPaste,
  Copy,
  FilePlus2,
  Pencil,
  RotateCcw,
  RotateCw,
  Scissors,
  SquareCheckBig,
  Trash2,
  X,
} from "lucide-react"
import { useRef } from "react"
import type { TFunction } from "i18next"
import { useTranslation } from "react-i18next"

import { InsertAfterIcon, InsertBeforeIcon } from "@/components/InsertPageIcon"
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
} from "@/components/ui/context-menu"
import type { NativeContextMenuItem } from "@/lib/nativeMenu"

/** Before the first of the menu's pages, or after the last. */
export type PageMenuSide = "before" | "after"

export type PageMenuActions = {
  canPaste: boolean
  /** The pages the menu acts on: in the sidebar the selection, which a
      right-click outside it has already moved to the page under the pointer;
      in the reading view the page pressed, alone. */
  count: number
  deleteDisabled?: boolean
  onCopy: () => void
  onCut: () => void
  onDelete: () => void
  /** The pages as a new PDF of their own, in a tab beside this one. */
  onExtract: () => void
  onInsertBlank: (side: PageMenuSide) => void
  onPaste: (side: PageMenuSide) => void
  onRotate: (degrees: 90 | 270) => void
}

/** A page's right-click menu in the sidebar, which also acts on a choice. */
export function PageMenuContent(props: PageMenuActions) {
  return (
    <ContextMenuContent>
      <PageMenuItems {...props} />
    </ContextMenuContent>
  )
}

/** What a page offers, wherever it is pressed: among the sidebar's pages, or
    in the reading view under what the text there offers. */
export function PageMenuItems({
  canPaste,
  count,
  deleteDisabled = false,
  onCopy,
  onCut,
  onDelete,
  onExtract,
  onInsertBlank,
  onPaste,
  onRotate,
}: PageMenuActions) {
  const { t } = useTranslation()

  return (
    <>
      <ContextMenuItem data-action="rotate-pages" onClick={() => onRotate(90)}>
        <RotateCw />
        {t("pageEdit.rotateRight", { count })}
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
      <ContextMenuItem data-action="extract-pages" onClick={onExtract}>
        <FilePlus2 />
        {t("tabs.newFromPages", { count })}
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
    </>
  )
}

/** Where in a file a paste lands: before its first page, or after its last. */
export type FileMenuEnd = "start" | "end"

export type FileMenuActions = {
  canPaste: boolean
  onPaste: (end: FileMenuEnd) => void
  onRemove: () => void
  onRename: () => void
  /** Absent where no pages show to be chosen: the tree of files stands in
      the sidebar where the pages would. */
  onSelect?: () => void
  /** A document keeps a page; its last file stays. */
  removeDisabled: boolean
}

export function buildPageMenuItems(
  { canPaste, count, deleteDisabled = false }: PageMenuActions,
  t: TFunction,
): NativeContextMenuItem[] {
  const items: NativeContextMenuItem[] = [
    { kind: "item", id: "rotate-pages", label: t("pageEdit.rotateRight", { count }) },
    { kind: "item", id: "rotate-pages-left", label: t("pageEdit.rotateLeft", { count }) },
    { kind: "separator" },
    { kind: "item", id: "cut-pages", label: t("pageEdit.cut", { count }) },
    { kind: "item", id: "copy-pages", label: t("pageEdit.copy", { count }) },
  ]

  if (canPaste) {
    items.push(
      { kind: "item", id: "paste-pages-before", label: t("pageEdit.pasteBefore") },
      { kind: "item", id: "paste-pages-after", label: t("pageEdit.pasteAfter") },
    )
  }

  items.push(
    { kind: "item", id: "insert-blank-before", label: t("pageEdit.insertBlankBefore") },
    { kind: "item", id: "insert-blank-after", label: t("pageEdit.insertBlankAfter") },
    { kind: "separator" },
    { kind: "item", id: "extract-pages", label: t("tabs.newFromPages", { count }) },
    { kind: "separator" },
    {
      enabled: !deleteDisabled,
      id: "delete-pages",
      kind: "item",
      label: t("pageEdit.delete", { count }),
    },
  )

  return items
}

export function runPageMenuAction(actionId: string, actions: PageMenuActions): boolean {
  switch (actionId) {
    case "rotate-pages":
      actions.onRotate(90)
      return true
    case "rotate-pages-left":
      actions.onRotate(270)
      return true
    case "cut-pages":
      actions.onCut()
      return true
    case "copy-pages":
      actions.onCopy()
      return true
    case "paste-pages-before":
      actions.onPaste("before")
      return true
    case "paste-pages-after":
      actions.onPaste("after")
      return true
    case "insert-blank-before":
      actions.onInsertBlank("before")
      return true
    case "insert-blank-after":
      actions.onInsertBlank("after")
      return true
    case "extract-pages":
      actions.onExtract()
      return true
    case "delete-pages":
      if (!actions.deleteDisabled) {
        actions.onDelete()
      }
      return true
    default:
      return false
  }
}

export function buildFileMenuItems(
  { canPaste, onSelect, removeDisabled }: FileMenuActions,
  t: TFunction,
): NativeContextMenuItem[] {
  const items: NativeContextMenuItem[] = []

  if (onSelect) {
    items.push({ kind: "item", id: "select-file", label: t("pageEdit.selectFile") })
  }

  items.push({ kind: "item", id: "rename-file", label: t("pageEdit.renameFile") })

  if (canPaste) {
    items.push(
      { kind: "separator" },
      { kind: "item", id: "paste-file-start", label: t("pageEdit.pasteFileStart") },
      { kind: "item", id: "paste-file-end", label: t("pageEdit.pasteFileEnd") },
    )
  }

  items.push(
    { kind: "separator" },
    {
      enabled: !removeDisabled,
      id: "remove-file",
      kind: "item",
      label: t("pageEdit.removeFile"),
    },
  )

  return items
}

export function runFileMenuAction(actionId: string, actions: FileMenuActions): boolean {
  switch (actionId) {
    case "select-file":
      actions.onSelect?.()
      return true
    case "rename-file":
      actions.onRename()
      return true
    case "paste-file-start":
      actions.onPaste("start")
      return true
    case "paste-file-end":
      actions.onPaste("end")
      return true
    case "remove-file":
      if (!actions.removeDisabled) {
        actions.onRemove()
      }
      return true
    default:
      return false
  }
}

/** A file's right-click menu, by its name over its pages or in the tree of
    files: what its hover buttons do, and pastes that join it at either end. */
export function FileMenuContent({
  canPaste,
  onPaste,
  onRemove,
  onRename,
  onSelect,
  removeDisabled,
}: FileMenuActions) {
  const { t } = useTranslation()
  // Never reset: each opening of the menu mounts this anew.
  const renameAskedRef = useRef(false)

  return (
    <ContextMenuContent
      // Renaming puts a field where the name was, the caret in it. A closing
      // menu hands focus back to what it opened over, which would take the
      // caret out again and end the edit before a key was typed.
      finalFocus={() => !renameAskedRef.current}
    >
      {onSelect ? (
        <ContextMenuItem data-action="select-file" onClick={onSelect}>
          <SquareCheckBig />
          {t("pageEdit.selectFile")}
        </ContextMenuItem>
      ) : null}
      <ContextMenuItem
        data-action="rename-file"
        onClick={() => {
          renameAskedRef.current = true
          onRename()
        }}
      >
        <Pencil />
        {t("pageEdit.renameFile")}
      </ContextMenuItem>
      {canPaste ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem data-action="paste-file-start" onClick={() => onPaste("start")}>
            <ClipboardPaste />
            {t("pageEdit.pasteFileStart")}
          </ContextMenuItem>
          <ContextMenuItem data-action="paste-file-end" onClick={() => onPaste("end")}>
            <ClipboardPaste />
            {t("pageEdit.pasteFileEnd")}
          </ContextMenuItem>
        </>
      ) : null}
      <ContextMenuSeparator />
      <ContextMenuItem
        data-action="remove-file"
        disabled={removeDisabled}
        onClick={onRemove}
        variant="destructive"
      >
        <X />
        {t("pageEdit.removeFile")}
      </ContextMenuItem>
    </ContextMenuContent>
  )
}
