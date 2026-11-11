import { useRef, useState } from "react"
import { ChevronRight, FileStack, FileText, Pencil, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { BookmarkItems } from "@/components/BookmarkList"
import { FileTitleEditor } from "@/components/FileTitleEditor"
import { HintTooltip } from "@/components/HintTooltip"
import { OverlayScrollbars } from "@/components/OverlayScrollbars"
import { FileMenuContent } from "@/components/PageContextMenu"
import { Button } from "@/components/ui/button"
import { ContextMenu, ContextMenuTrigger } from "@/components/ui/context-menu"
import { useListDrag } from "@/hooks/useListDrag"
import { DRAG_CLICK_WINDOW } from "@/lib/pageDrag"
import { fileRuns, type FileRun } from "@/lib/pageSections"
import type { PdfPageInfo, PdfSection } from "@/lib/pdf"
import { cn } from "@/lib/utils"

type FileSectionsTreeProps = {
  canPaste: boolean
  onAddFiles: () => void
  /** A file dragged among the others: its pages go, whole, in front of
      1-based page `before`, or to the end. */
  onMove: (sectionId: number, before: number | null) => void
  onNavigate: (pageNumber: number) => void
  /** The pages on the clipboard pasted into a file, in front of 1-based
      page `index`. */
  onPaste: (sectionId: number, index: number) => void
  onRemove: (sectionId: number) => void
  onRename: (sectionId: number, title: string) => void
  pages: PdfPageInfo[]
  sections: PdfSection[]
}

/**
 * A document of several files, each under its name with its own bookmarks:
 * the outline a Save As writes, one bookmark per run of a file's pages, the
 * file's own beneath its first. A name is where that run's first page stands;
 * a file can be renamed, removed, or dragged among the others, every file
 * folded to its name meanwhile. A row ends on how many pages it holds, which
 * give their place to its rename and remove buttons under the pointer.
 */
export function FileSectionsTree({
  canPaste,
  onAddFiles,
  onMove,
  onNavigate,
  onPaste,
  onRemove,
  onRename,
  pages,
  sections,
}: FileSectionsTreeProps) {
  const { t } = useTranslation()
  const navRef = useRef<HTMLElement>(null)
  const [folded, setFolded] = useState<ReadonlySet<number>>(new Set())
  const [editing, setEditing] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  const draggedAtRef = useRef(0)
  const runs = fileRuns(pages)
  const files = new Map(sections.map((section) => [section.id, section]))
  const filePages = new Map<number, number>()

  for (const run of runs) {
    filePages.set(run.section, (filePages.get(run.section) ?? 0) + run.count)
  }

  const { drag } = useListDrag({
    active: editing === null,
    listRef,
    onReorder: (moved, to) => {
      const from = moved[0]!
      const rest = runs.filter((_, index) => index !== from)

      draggedAtRef.current = performance.now()
      onMove(runs[from]!.section, rest[to]?.first ?? null)
    },
    // The name alone is the handle: the file's bookmarks and buttons are pressed.
    pressOnly: (target) => target.closest("[data-slot='file-section-title']") === null,
  })
  const dragged = drag ? files.get(runs[drag.index]?.section ?? -1) : undefined

  const toggle = (sectionId: number) =>
    setFolded((current) => {
      const next = new Set(current)

      if (!next.delete(sectionId)) {
        next.add(sectionId)
      }

      return next
    })

  return (
    <div className="flex h-full flex-col">
      <div className="relative min-h-0 flex-1">
        <nav
          aria-label={t("sidebar.files")}
          className="overlay-scroll-viewport h-full overflow-auto overscroll-contain p-2"
          data-slot="file-sections"
          ref={navRef}
        >
          <ul className="flex flex-col gap-0.5" ref={listRef}>
            {runs.map((run, index) => {
              const section = files.get(run.section)
              const rowKey = `${run.section}:${run.ordinal}`

              if (!section) {
                return null
              }

              return (
                <FileRunRow
                  canPaste={canPaste}
                  dragging={drag !== null}
                  editing={editing === rowKey}
                  folded={folded.has(section.id)}
                  index={index}
                  key={rowKey}
                  lifted={drag?.index === index}
                  offset={drag?.cellOffsets[index] ?? 0}
                  onEdit={(on) => setEditing(on ? rowKey : null)}
                  onNavigate={(pageNumber) => {
                    if (performance.now() - draggedAtRef.current >= DRAG_CLICK_WINDOW) {
                      onNavigate(pageNumber)
                    }
                  }}
                  onNavigateBookmark={onNavigate}
                  onPaste={onPaste}
                  onRemove={onRemove}
                  onRename={onRename}
                  onToggle={toggle}
                  // A document keeps a page; the last file's go no further.
                  removeDisabled={(filePages.get(section.id) ?? 0) >= pages.length}
                  run={run}
                  section={section}
                />
              )
            })}
          </ul>
        </nav>
        <OverlayScrollbars viewportRef={navRef} />
      </div>
      <div className="shrink-0 border-t p-2">
        <Button
          className="w-full justify-start"
          data-slot="files-add"
          onClick={onAddFiles}
          size="sm"
          variant="ghost"
        >
          <FileStack />
          <span className="truncate">{t("sidebar.addFiles")}</span>
        </Button>
      </div>
      {drag && dragged ? (
        <div
          className="pointer-events-none fixed z-50 flex items-center gap-2 rounded-md border bg-background px-2 py-1.5 text-sm font-medium shadow-lg"
          style={{
            left: drag.pointer.x + drag.grip.x,
            top: drag.pointer.y + drag.grip.y,
            width: drag.width,
          }}
        >
          <FileText className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{dragged.title}</span>
        </div>
      ) : null}
    </div>
  )
}

/** One run of a file's pages, under the file's name. */
function FileRunRow({
  canPaste,
  dragging,
  editing,
  folded,
  index,
  lifted,
  offset,
  onEdit,
  onNavigate,
  onNavigateBookmark,
  onPaste,
  onRemove,
  onRename,
  onToggle,
  removeDisabled,
  run,
  section,
}: {
  canPaste: boolean
  dragging: boolean
  editing: boolean
  folded: boolean
  index: number
  lifted: boolean
  offset: number
  onEdit: (editing: boolean) => void
  onNavigate: (pageNumber: number) => void
  onNavigateBookmark: (pageNumber: number) => void
  onPaste: (sectionId: number, index: number) => void
  onRemove: (sectionId: number) => void
  onRename: (sectionId: number, title: string) => void
  onToggle: (sectionId: number) => void
  removeDisabled: boolean
  run: FileRun
  section: PdfSection
}) {
  const { t } = useTranslation()
  const nameRef = useRef<HTMLSpanElement>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  // The file's own bookmarks stand under its first run, as a Save As writes them.
  const outline = run.leads ? section.outline : []
  const open = !dragging && !folded && outline.length > 0

  return (
    <li
      className={cn(lifted && "opacity-40")}
      data-list-index={index}
      data-run-first={run.first}
      data-section-id={section.id}
      style={offset ? { transform: `translateY(${offset}px)` } : undefined}
    >
      {/* Off while the name is typed: the field keeps the WebView's own cut,
          copy and paste menu. */}
      <ContextMenu disabled={editing} onOpenChange={setMenuOpen}>
        <ContextMenuTrigger
          render={
            <div
              // A property the row sets, because the count is no child of
              // the buttons that take its place: see `PAPER_CONTROLS_HOST`.
              // The keyboard's focus sets it too, from inside the buttons
              // alone: WebKitGTK can keep a clicked name `:focus-visible`,
              // and its row would stay lit.
              className="relative flex items-center gap-1 rounded-md pr-1 [--row-tools:0] hover:bg-sidebar-accent hover:[--row-tools:1] has-[[data-slot=file-section-tools]_:focus-visible]:bg-sidebar-accent has-[[data-slot=file-section-tools]_:focus-visible]:[--row-tools:1]"
              data-slot="file-section-row"
            />
          }
        >
          <button
            aria-expanded={outline.length > 0 ? open : undefined}
            aria-label={section.title}
            className={cn(
              "grid size-6 shrink-0 place-items-center rounded text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
              outline.length === 0 && "invisible",
            )}
            onClick={() => onToggle(section.id)}
            tabIndex={outline.length === 0 ? -1 : 0}
            type="button"
          >
            <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
          </button>
          {editing ? (
            <FileTitleEditor
              label={t("sidebar.fileName")}
              onDone={(title) => {
                onEdit(false)

                if (title !== null) {
                  onRename(section.id, title)
                }
              }}
              title={section.title}
            />
          ) : (
            <HintTooltip
              label={section.title}
              side="right"
              // Only a name the column cut short has more to say.
              cutShort={nameRef}
            >
              <button
                className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                data-slot="file-section-title"
                onClick={() => onNavigate(run.first)}
                onDoubleClick={() => onEdit(true)}
                type="button"
              >
                <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate" ref={nameRef}>
                  {section.title}
                </span>
                {/* No narrower than the buttons that stand over it, so they
                    cover no part of a long name. */}
                <span
                  className="ml-auto min-w-13 shrink-0 text-right text-xs font-normal text-muted-foreground tabular-nums opacity-[calc(1_-_var(--row-tools))]"
                  data-slot="file-section-count"
                >
                  {t("sidebar.filePages", { count: run.count })}
                </span>
              </button>
            </HintTooltip>
          )}
          {editing ? null : (
            // Over the count, in its place while the row shows them.
            <div
              className="absolute inset-y-0 right-1 flex items-center gap-0.5 opacity-(--row-tools)"
              data-slot="file-section-tools"
            >
              <HintTooltip label={t("sidebar.renameFile", { name: section.title })}>
                <Button
                  aria-label={t("sidebar.renameFile", { name: section.title })}
                  data-slot="file-section-rename"
                  onClick={() => onEdit(true)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <Pencil />
                </Button>
              </HintTooltip>
              <HintTooltip label={t("sidebar.removeFile", { name: section.title })}>
                <Button
                  aria-label={t("sidebar.removeFile", { name: section.title })}
                  className="hover:text-destructive"
                  data-slot="file-section-remove"
                  disabled={removeDisabled}
                  onClick={() => onRemove(section.id)}
                  size="icon-xs"
                  variant="ghost"
                >
                  <X />
                </Button>
              </HintTooltip>
            </div>
          )}
        </ContextMenuTrigger>
        {/* Gone with the menu, not faded out after it: a menu still on screen
            holds focus in itself, and would take it back from the field a
            rename has just put the caret in. */}
        {menuOpen ? (
          <FileMenuContent
            canPaste={canPaste}
            onPaste={(end) =>
              onPaste(section.id, end === "start" ? run.first : run.first + run.count)
            }
            onRemove={() => onRemove(section.id)}
            onRename={() => onEdit(true)}
            removeDisabled={removeDisabled}
          />
        ) : null}
      </ContextMenu>
      {open ? (
        <ul className="pl-5">
          <BookmarkItems
            items={outline}
            onNavigate={onNavigateBookmark}
            parentKey={`section-${section.id}`}
          />
        </ul>
      ) : null}
    </li>
  )
}
