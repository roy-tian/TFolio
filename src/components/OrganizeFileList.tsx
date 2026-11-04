import {
  memo,
  useCallback,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from "react"
import { createPortal } from "react-dom"
import {
  ChevronRight,
  FileText,
  ImageIcon,
  ListChevronsDownUp,
  ListChevronsUpDown,
  Pencil,
  Trash2,
  X,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import fileTinyIcon from "@/assets/brand/file-tiny.svg"
import { BookmarkItems } from "@/components/BookmarkList"
import { HintTooltip } from "@/components/HintTooltip"
import { OverlayScrollbars } from "@/components/OverlayScrollbars"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useListDrag, type ListDragState } from "@/hooks/useListDrag"
import type { OrganizeWorkspace } from "@/hooks/useOrganizeWorkspace"
import type { FileBookmark, OrganizeGroup, OrganizeSourceKind } from "@/lib/organize"
import { cn } from "@/lib/utils"

function KindIcon({ kind }: { kind: OrganizeSourceKind }) {
  const { t } = useTranslation()
  const label = t(
    kind === "image"
      ? "organize.imageSource"
      : kind === "word"
        ? "organize.wordSource"
        : "organize.pdfSource",
  )

  return kind === "image" ? (
    <ImageIcon aria-label={label} className="size-4 shrink-0 text-muted-foreground" />
  ) : kind === "word" ? (
    <FileText aria-label={label} className="size-4 shrink-0 text-muted-foreground" />
  ) : (
    <img alt={label} className="size-4 shrink-0" draggable={false} src={fileTinyIcon} />
  )
}

/** Settles once: Enter or Escape unmounts it, and a blur may follow. */
function TitleEditor({
  label,
  onDone,
  title,
}: {
  label: string
  onDone: (title: string | null) => void
  title: string
}) {
  const settledRef = useRef(false)
  const settle = (value: string | null) => {
    if (!settledRef.current) {
      settledRef.current = true
      onDone(value)
    }
  }

  return (
    <Input
      aria-label={label}
      autoFocus
      className="h-7 flex-1 px-1.5"
      data-slot="organize-file-title"
      defaultValue={title}
      onBlur={(event) => settle(event.currentTarget.value)}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          settle(event.currentTarget.value)
        } else if (event.key === "Escape") {
          // Not the overlay sidebar's Escape, which would take the field away.
          event.preventDefault()
          event.stopPropagation()
          settle(null)
        }
      }}
      spellCheck={false}
    />
  )
}

/** Over the page count and the title's end: a hovered row trades its count
    for these. A keyboard reaching them shows them too — tracked here, since a
    `:focus-within` rule would have WebKit restyle the whole app per focus. */
function RowActions({ children }: { children: ReactNode }) {
  const [focused, setFocused] = useState(false)

  return (
    <span
      className={cn(
        "absolute inset-y-0 right-1 flex items-center gap-0.5 bg-sidebar-accent pl-1 opacity-0 group-hover/file:opacity-100 before:absolute before:inset-y-0 before:-left-4 before:w-4 before:bg-linear-to-r before:from-transparent before:to-sidebar-accent",
        focused && "opacity-100",
      )}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) {
          setFocused(false)
        }
      }}
      onFocus={(event) => setFocused(event.target.matches(":focus-visible"))}
    >
      {children}
    </span>
  )
}

type FileEntryProps = {
  bookmark: FileBookmark | undefined
  busy: boolean
  draggable: boolean
  editing: boolean
  /** Bookmarks are on: the file's own show under it, and its title is one. */
  folding: boolean
  group: OrganizeGroup
  kind: OrganizeSourceKind
  onEdit: (groupId: number | null) => void
  onRemove: (groupId: number) => void
  onRename: (groupId: number, title: string) => void
  onShowFile: (groupId: number) => void
  onShowPage: (pageNumber: number) => void
  onToggle: (groupId: number) => void
  open: boolean
}

/** A file and the bookmarks under it. Memoised apart from its cell, which a
    drag moves on every pointer move. */
const FileEntry = memo(function FileEntry({
  bookmark,
  busy,
  draggable,
  editing,
  folding,
  group,
  kind,
  onEdit,
  onRemove,
  onRename,
  onShowFile,
  onShowPage,
  onToggle,
  open,
}: FileEntryProps) {
  const { t } = useTranslation()
  const rowRef = useRef<HTMLDivElement>(null)
  const nameRef = useRef<HTMLSpanElement>(null)
  const name = group.title
  const items = folding ? (bookmark?.items ?? []) : []
  const renameLabel = t("organize.renameBookmark", { name })

  return (
    <>
      <div
        className={cn(
          "group/file relative flex h-9 items-center gap-1 rounded-md px-1 hover:bg-sidebar-accent",
          draggable ? "cursor-grab" : "cursor-pointer",
        )}
        data-slot="organize-file"
        onClick={() => onShowFile(group.id)}
        ref={rowRef}
        onDoubleClick={
          folding && !busy
            ? (event) => {
                // Two quick presses of the fold or an action are theirs alone.
                if (!(event.target instanceof Element && event.target.closest("button"))) {
                  onEdit(group.id)
                }
              }
            : undefined
        }
      >
        {folding ? (
          items.length > 0 ? (
            <button
              aria-expanded={open}
              aria-label={t(open ? "organize.collapseFile" : "organize.expandFile", { name })}
              className="flex size-5 shrink-0 items-center justify-center rounded-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"
              data-slot="organize-file-fold"
              onClick={(event) => {
                event.stopPropagation()
                onToggle(group.id)
              }}
              type="button"
            >
              <ChevronRight
                className={cn("size-4 transition-transform", open && "rotate-90")}
              />
            </button>
          ) : (
            <span className="size-5 shrink-0" />
          )
        ) : null}
        <KindIcon kind={kind} />
        {editing ? (
          <TitleEditor
            label={t("organize.bookmarkTitle")}
            onDone={(title) => {
              if (title !== null) {
                onRename(group.id, title)
              }

              onEdit(null)
            }}
            title={name}
          />
        ) : (
          <>
            {/* Past the row's end, as a bookmark's is beside the column: the
                row is too narrow to read it in, and the actions sit over it. */}
            <HintTooltip
              label={name}
              side="right"
              sideOffset={() =>
                (rowRef.current?.getBoundingClientRect().right ?? 0) -
                (nameRef.current?.getBoundingClientRect().right ?? 0) +
                4
              }
            >
              <span
                className="min-w-0 flex-1 truncate text-sm"
                data-slot="organize-file-name"
                ref={nameRef}
              >
                {name}
              </span>
            </HintTooltip>
            <span className="shrink-0 px-1 text-xs text-muted-foreground tabular-nums">
              {group.slots.length}
            </span>
            {/* Remounted as work starts or ends: a focused button that turns
                disabled loses focus with no blur to hide the actions by. */}
            <RowActions key={busy ? "busy" : "idle"}>
              {folding ? (
                <HintTooltip label={renameLabel}>
                  <Button
                    aria-label={renameLabel}
                    data-slot="organize-file-rename"
                    disabled={busy}
                    onClick={(event) => {
                      event.stopPropagation()
                      onEdit(group.id)
                    }}
                    size="icon-xs"
                    variant="ghost"
                  >
                    <Pencil />
                  </Button>
                </HintTooltip>
              ) : null}
              <HintTooltip label={t("organize.removeFile", { name })}>
                <Button
                  aria-label={t("organize.removeFile", { name })}
                  disabled={busy}
                  onClick={(event) => {
                    event.stopPropagation()
                    onRemove(group.id)
                  }}
                  size="icon-xs"
                  variant="ghost"
                >
                  <X />
                </Button>
              </HintTooltip>
            </RowActions>
          </>
        )}
      </div>
      {open && items.length > 0 ? (
        <ul className="pb-1 pl-5" data-organize-outline>
          <BookmarkItems items={items} onNavigate={onShowPage} parentKey={`${group.id}`} />
        </ul>
      ) : null}
    </>
  )
})

/** One row tall: `drag.height` is the cell as pressed, bookmarks and all. */
function FileDragGhost({
  drag,
  group,
  kind,
}: {
  drag: ListDragState
  group: OrganizeGroup
  kind: OrganizeSourceKind
}) {
  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed z-60 flex h-9 items-center gap-1 rounded-md border bg-popover px-2 select-none shadow-xl ring-1 ring-primary/20"
      style={{
        left: drag.pointer.x + drag.grip.x,
        top: drag.pointer.y + drag.grip.y,
        width: drag.width,
      }}
    >
      <KindIcon kind={kind} />
      <span className="min-w-0 flex-1 truncate text-sm">{group.title}</span>
      <span className="shrink-0 px-1 text-xs text-muted-foreground tabular-nums">
        {group.slots.length}
      </span>
    </div>,
    document.body,
  )
}

/** A press on a bookmark, a field, or a button is never the file's drag. */
const pressOnly = (target: Element) =>
  target.closest("button, input, [data-organize-outline]") !== null

/** Which files show their bookmarks: a closed set, so a new file opens. */
export type FileFolds = {
  closed: ReadonlySet<number>
  setClosed: Dispatch<SetStateAction<ReadonlySet<number>>>
}

/** The sidebar's second row: what the column holds, and its folds. */
export function OrganizeFileListHeader({
  folds,
  organize,
}: {
  folds: FileFolds
  organize: OrganizeWorkspace
}) {
  const { t } = useTranslation()
  const { bookmarks, plan } = organize
  const foldable =
    plan.options.bookmarks
      ? plan.groups.filter((group) => (bookmarks.get(group.id)?.items.length ?? 0) > 0)
      : []
  const expandLabel = t("organize.expandAll")
  const collapseLabel = t("organize.collapseAll")

  return (
    <div className="flex w-full min-w-0 items-center gap-1">
      <span className="min-w-0 flex-1 truncate pl-1 text-sm font-medium">
        {t("organize.outline")}
      </span>
      <ToolbarTooltip label={expandLabel}>
        <Button
          aria-label={expandLabel}
          data-slot="organize-expand-all"
          disabled={!foldable.some((group) => folds.closed.has(group.id))}
          onClick={() => folds.setClosed(new Set())}
          size="icon-sm"
          variant="ghost"
        >
          <ListChevronsUpDown />
        </Button>
      </ToolbarTooltip>
      <ToolbarTooltip label={collapseLabel}>
        <Button
          aria-label={collapseLabel}
          data-slot="organize-collapse-all"
          disabled={!foldable.some((group) => !folds.closed.has(group.id))}
          onClick={() => folds.setClosed(new Set(plan.groups.map((group) => group.id)))}
          size="icon-sm"
          variant="ghost"
        >
          <ListChevronsDownUp />
        </Button>
      </ToolbarTooltip>
    </div>
  )
}

type OrganizeFileListProps = {
  folds: FileFolds
  onShowFile: (groupId: number) => void
  onShowPage: (pageNumber: number) => void
  organize: OrganizeWorkspace
}

/** The files the new PDF is put together from, in order, each with the
    bookmarks it will carry: drag a file to reorder, click one to bring its
    pages into view, a bookmark to bring its page. */
export function OrganizeFileList({
  folds,
  onShowFile,
  onShowPage,
  organize,
}: OrganizeFileListProps) {
  const { t } = useTranslation()
  const listRef = useRef<HTMLOListElement>(null)
  const [editing, setEditing] = useState<number | null>(null)
  const { bookmarks, plan, sources } = organize
  const busy = organize.adding || organize.assembling
  const folding = plan.options.bookmarks
  // A file an undo took away mid-edit leaves no field to settle the edit.
  const editingId =
    folding && plan.groups.some((group) => group.id === editing) ? editing : null
  const draggable = !busy && plan.groups.length > 1 && editingId === null
  const { drag } = useListDrag({
    active: draggable,
    listRef,
    onReorder: organize.reorderFiles,
    pressOnly,
  })
  const kindOf = (group: OrganizeGroup) =>
    sources.get(group.originSourceId)?.kind ?? "pdf"
  const dragged = drag ? plan.groups[drag.index] : undefined
  const { closed, setClosed } = folds
  const { removeFiles } = organize
  const removeFile = useCallback(
    (groupId: number) => removeFiles(new Set([groupId])),
    [removeFiles],
  )
  // An updater, so one fold re-renders no other file's entry.
  const toggle = useCallback(
    (groupId: number) =>
      setClosed((current) => {
        const next = new Set(current)

        if (!next.delete(groupId)) {
          next.add(groupId)
        }

        return next
      }),
    [setClosed],
  )

  if (plan.groups.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-muted-foreground">
        {t("organize.filesEmpty")}
      </p>
    )
  }

  return (
    <div className="flex h-full flex-col">
      {folding ? null : (
        <p
          className="shrink-0 px-4 pt-2 text-xs text-muted-foreground"
          data-slot="organize-no-bookmarks"
        >
          {t("organize.noBookmarks")}
        </p>
      )}
      <div className="relative min-h-0 flex-1">
        <ol
          aria-label={t("organize.outline")}
          className="overlay-scroll-viewport flex h-full select-none flex-col gap-0.5 overflow-y-auto overscroll-contain p-2"
          data-slot="organize-files"
          ref={listRef}
        >
          {plan.groups.map((group, index) => {
            const offset = drag?.cellOffsets[index] ?? 0

            return (
              <li
                className={cn(
                  "relative shrink-0",
                  drag && drag.index !== index && "transition-transform duration-200 ease-out",
                  drag?.index === index && "opacity-0",
                )}
                data-list-index={index}
                key={group.id}
                style={{ transform: offset === 0 ? undefined : `translateY(${offset}px)` }}
              >
                {drag &&
                (drag.gap === index ||
                  (drag.gap === plan.groups.length && index === plan.groups.length - 1)) ? (
                  <span
                    className={cn(
                      "pointer-events-none absolute inset-x-0 h-0.5 rounded-full bg-primary",
                      drag.gap === index ? "-top-px" : "-bottom-px",
                    )}
                    style={{
                      transform: offset === 0 ? undefined : `translateY(${-offset}px)`,
                    }}
                  />
                ) : null}
                <FileEntry
                  bookmark={bookmarks.get(group.id)}
                  busy={busy}
                  draggable={draggable}
                  editing={editingId === group.id}
                  folding={folding}
                  group={group}
                  kind={kindOf(group)}
                  onEdit={setEditing}
                  onRemove={removeFile}
                  onRename={organize.renameFile}
                  onShowFile={onShowFile}
                  onShowPage={onShowPage}
                  onToggle={toggle}
                  // Every file folds while one moves: a file is then one row
                  // tall, however many bookmarks it carries.
                  open={!drag && !closed.has(group.id)}
                />
              </li>
            )
          })}
        </ol>
        <OverlayScrollbars viewportRef={listRef} />
      </div>
      {/* One undo away, like taking any one file off the list. Boxed as the
          status bar beside it is, so their top borders run as one line. */}
      <div className="flex h-(--status-bar-height) shrink-0 items-center border-t px-2 pb-px">
        <Button
          className="w-full justify-start text-muted-foreground"
          data-slot="organize-remove-all"
          disabled={busy}
          onClick={() =>
            organize.removeFiles(new Set(plan.groups.map((group) => group.id)))
          }
          size="sm"
          variant="ghost"
        >
          <Trash2 />
          {t("organize.removeAll")}
        </Button>
      </div>
      {drag && dragged ? (
        <FileDragGhost drag={drag} group={dragged} kind={kindOf(dragged)} />
      ) : null}
    </div>
  )
}
