import { memo, useRef } from "react"
import { createPortal } from "react-dom"
import { FileText, GripVertical, ImageIcon, Trash2, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import fileTinyIcon from "@/assets/brand/file-tiny.svg"
import { HintTooltip } from "@/components/HintTooltip"
import { Button } from "@/components/ui/button"
import { useListDrag, type ListDragState } from "@/hooks/useListDrag"
import type { OrganizeWorkspace } from "@/hooks/useOrganizeWorkspace"
import type { OrganizeGroup, OrganizeSourceKind } from "@/lib/organize"
import { cn } from "@/lib/utils"

type RowProps = {
  group: OrganizeGroup
  kind: OrganizeSourceKind
  onRemove?: (groupId: number) => void
  showHandle: boolean
}

/** One file on the list, in its place and in the copy that rides the pointer. */
const FileRowContent = memo(function FileRowContent({
  group,
  kind,
  onRemove,
  showHandle,
}: RowProps) {
  const { t } = useTranslation()
  const kindLabel = t(
    kind === "image"
      ? "organize.imageSource"
      : kind === "word"
        ? "organize.wordSource"
        : "organize.pdfSource",
  )

  return (
    <>
      {showHandle ? (
        <GripVertical className="size-4 shrink-0 text-muted-foreground" />
      ) : null}
      {kind === "image" ? (
        <ImageIcon aria-label={kindLabel} className="size-4 shrink-0 text-muted-foreground" />
      ) : kind === "word" ? (
        <FileText aria-label={kindLabel} className="size-4 shrink-0 text-muted-foreground" />
      ) : (
        <img
          alt={kindLabel}
          className="size-4 shrink-0"
          draggable={false}
          src={fileTinyIcon}
        />
      )}
      <span className="min-w-0 flex-1 truncate text-sm" data-slot="organize-file-name">
        {group.title}
      </span>
      <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
        {group.slots.length}
      </span>
      {onRemove ? (
        <HintTooltip label={t("organize.removeFile", { name: group.title })}>
          <Button
            aria-label={t("organize.removeFile", { name: group.title })}
            className="opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100"
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
      ) : (
        <span className="size-6 shrink-0" />
      )}
    </>
  )
})

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
      className="pointer-events-none fixed z-60 flex items-center gap-2 rounded-md border bg-popover px-2 select-none shadow-xl ring-1 ring-primary/20"
      style={{
        height: drag.height,
        left: drag.pointer.x + drag.grip.x,
        top: drag.pointer.y + drag.grip.y,
        width: drag.width,
      }}
    >
      <FileRowContent group={group} kind={kind} showHandle />
    </div>,
    document.body,
  )
}

type OrganizeFileListProps = {
  onShow: (groupId: number) => void
  organize: OrganizeWorkspace
}

/** The files the new PDF is put together from, in order: drag to reorder,
    click to bring a file's pages into view. */
export function OrganizeFileList({ onShow, organize }: OrganizeFileListProps) {
  const { t } = useTranslation()
  const listRef = useRef<HTMLOListElement>(null)
  const { plan, sources } = organize
  const busy = organize.adding || organize.assembling
  const { drag } = useListDrag({
    active: !busy && plan.groups.length > 1,
    listRef,
    onReorder: organize.reorderFiles,
  })
  const kindOf = (group: OrganizeGroup) =>
    sources.get(group.originSourceId)?.kind ?? "pdf"
  const dragged = drag ? plan.groups[drag.index] : undefined

  if (plan.groups.length === 0) {
    return (
      <p className="px-4 py-6 text-center text-sm text-muted-foreground">
        {t("organize.filesEmpty")}
      </p>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <ol
        aria-label={t("organize.files")}
        className="flex min-h-0 flex-1 select-none flex-col gap-0.5 overflow-y-auto overscroll-contain p-2"
        data-slot="organize-files"
        ref={listRef}
      >
        {plan.groups.map((group, index) => {
          const offset = drag?.cellOffsets[index] ?? 0

          return (
            <li
              className={cn(
                "group/file relative flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 hover:bg-sidebar-accent",
                plan.groups.length > 1 && !busy && "cursor-grab",
                drag && drag.index !== index && "transition-transform duration-200 ease-out",
                drag?.index === index && "opacity-0",
              )}
              data-list-index={index}
              key={group.id}
              onClick={() => onShow(group.id)}
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
              <FileRowContent
                group={group}
                kind={kindOf(group)}
                onRemove={busy ? undefined : (id) => organize.removeFiles(new Set([id]))}
                showHandle={plan.groups.length > 1}
              />
            </li>
          )
        })}
      </ol>
      {/* One undo away, like taking any one file off the list. */}
      <div className="shrink-0 border-t p-2">
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
