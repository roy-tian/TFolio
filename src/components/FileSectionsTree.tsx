import { useRef, useState } from "react"
import { ChevronRight, FileText, Pencil, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { BookmarkItems } from "@/components/BookmarkList"
import { HintTooltip } from "@/components/HintTooltip"
import { OverlayScrollbars } from "@/components/OverlayScrollbars"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import type { PdfPageInfo, PdfSection } from "@/lib/pdf"
import { cn } from "@/lib/utils"

type FileSectionsTreeProps = {
  onNavigate: (pageNumber: number) => void
  onRemove: (sectionId: number) => void
  onRename: (sectionId: number, title: string) => void
  pages: PdfPageInfo[]
  sections: PdfSection[]
}

/**
 * A document of several files, each under its name with its own bookmarks:
 * the outline a Save As writes, one bookmark per file above the file's own.
 * A file's name is where its first page stands; it can be renamed or removed.
 */
export function FileSectionsTree({
  onNavigate,
  onRemove,
  onRename,
  pages,
  sections,
}: FileSectionsTreeProps) {
  const { t } = useTranslation()
  const navRef = useRef<HTMLElement>(null)
  const [folded, setFolded] = useState<ReadonlySet<number>>(new Set())
  const [editing, setEditing] = useState<number | null>(null)
  const firstPage = new Map<number, number>()
  const pageCount = new Map<number, number>()

  pages.forEach((page, index) => {
    if (page.section === undefined) {
      return
    }

    if (!firstPage.has(page.section)) {
      firstPage.set(page.section, index + 1)
    }

    pageCount.set(page.section, (pageCount.get(page.section) ?? 0) + 1)
  })

  const toggle = (sectionId: number) =>
    setFolded((current) => {
      const next = new Set(current)

      if (!next.delete(sectionId)) {
        next.add(sectionId)
      }

      return next
    })

  return (
    <div className="relative h-full">
      <nav
        aria-label={t("sidebar.files")}
        className="overlay-scroll-viewport h-full overflow-auto overscroll-contain p-2"
        data-slot="file-sections"
        ref={navRef}
      >
        <ul className="flex flex-col gap-0.5">
          {sections.map((section) => {
            const open = !folded.has(section.id) && section.outline.length > 0
            const count = pageCount.get(section.id) ?? 0

            return (
              <li data-section-id={section.id} key={section.id}>
                <div className="group/file flex items-center gap-1 rounded-md pr-1 hover:bg-sidebar-accent">
                  <button
                    aria-expanded={section.outline.length > 0 ? open : undefined}
                    aria-label={section.title}
                    className={cn(
                      "grid size-6 shrink-0 place-items-center rounded text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
                      section.outline.length === 0 && "invisible",
                    )}
                    onClick={() => toggle(section.id)}
                    tabIndex={section.outline.length === 0 ? -1 : 0}
                    type="button"
                  >
                    <ChevronRight className={cn("size-3.5 transition-transform", open && "rotate-90")} />
                  </button>
                  {editing === section.id ? (
                    <TitleEditor
                      label={t("sidebar.fileName")}
                      onDone={(title) => {
                        setEditing(null)

                        if (title !== null) {
                          onRename(section.id, title)
                        }
                      }}
                      title={section.title}
                    />
                  ) : (
                    <HintTooltip label={section.title} side="right">
                      <button
                        className="flex min-w-0 flex-1 items-center gap-2 py-1.5 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring"
                        data-slot="file-section-title"
                        onClick={() => {
                          const first = firstPage.get(section.id)

                          if (first !== undefined) {
                            onNavigate(first)
                          }
                        }}
                        onDoubleClick={() => setEditing(section.id)}
                        type="button"
                      >
                        <FileText className="size-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{section.title}</span>
                        <span className="ml-auto shrink-0 text-xs font-normal text-muted-foreground tabular-nums">
                          {t("sidebar.filePages", { count })}
                        </span>
                      </button>
                    </HintTooltip>
                  )}
                  {editing === section.id ? null : (
                    <>
                      <HintTooltip label={t("sidebar.renameFile", { name: section.title })}>
                        <Button
                          aria-label={t("sidebar.renameFile", { name: section.title })}
                          className="opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100"
                          data-slot="file-section-rename"
                          onClick={() => setEditing(section.id)}
                          size="icon-xs"
                          variant="ghost"
                        >
                          <Pencil />
                        </Button>
                      </HintTooltip>
                      <HintTooltip label={t("sidebar.removeFile", { name: section.title })}>
                        <Button
                          aria-label={t("sidebar.removeFile", { name: section.title })}
                          className="opacity-0 group-hover/file:opacity-100 hover:text-destructive focus-visible:opacity-100"
                          data-slot="file-section-remove"
                          // A document keeps a page; the last file's go no further.
                          disabled={count >= pages.length}
                          onClick={() => onRemove(section.id)}
                          size="icon-xs"
                          variant="ghost"
                        >
                          <X />
                        </Button>
                      </HintTooltip>
                    </>
                  )}
                </div>
                {open ? (
                  <ul className="pl-5">
                    <BookmarkItems
                      items={section.outline}
                      onNavigate={onNavigate}
                      parentKey={`section-${section.id}`}
                    />
                  </ul>
                ) : null}
              </li>
            )
          })}
        </ul>
      </nav>
      <OverlayScrollbars viewportRef={navRef} />
    </div>
  )
}

/** A file's name, typed in place: Enter or leaving keeps it, Esc does not. */
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
      data-slot="file-section-title-input"
      defaultValue={title}
      onBlur={(event) => settle(event.currentTarget.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          settle(event.currentTarget.value)
        } else if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          settle(null)
        }
      }}
    />
  )
}
