import { memo, useCallback, useEffect, useRef, useState } from "react"
import {
  BetweenHorizontalStart,
  Bookmark,
  Eye,
  FileOutput,
  FolderPlus,
  Layers,
  RotateCcw,
  RotateCw,
  Scaling,
  Trash2,
  Undo2,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { AppMenu, type AppMenuActions } from "@/components/AppMenu"
import { AppSidebar } from "@/components/AppSidebar"
import { InsertAfterIcon, InsertBeforeIcon } from "@/components/InsertPageIcon"
import { OperationProgress } from "@/components/OperationProgress"
import { OrganizeBoard } from "@/components/OrganizeBoard"
import {
  OrganizeFileList,
  OrganizeFileListHeader,
} from "@/components/OrganizeFileList"
import { OverlayScrollbars } from "@/components/OverlayScrollbars"
import { ToolbarFrame } from "@/components/SessionHeader"
import { SliderStepper } from "@/components/SliderStepper"
import { StatusBar } from "@/components/StatusBar"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { Button } from "@/components/ui/button"
import { ButtonGroup } from "@/components/ui/button-group"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Toggle } from "@/components/ui/toggle"
import type { OrganizeWorkspace as Workspace } from "@/hooks/useOrganizeWorkspace"
import { hasLayerOverWorkspace, isTypingTarget } from "@/lib/contextMenu"
import {
  ORGANIZE_PAPER_WIDTHS,
  readStoredOrganizeStep,
  storeOrganizeStep,
} from "@/lib/organizeSize"
import { shortcuts } from "@/lib/shortcuts"

type OrganizeWorkspaceProps = {
  active: boolean
  macOS: boolean
  menu: AppMenuActions
  organize: Workspace
}

/** The window's second workspace: pages from several files put together into
    one new PDF, previewed unsaved or saved where the reader chooses, and
    opened as a tab of the first. Memoised: it stays mounted behind the
    viewer, where the App's own re-renders are no news. */
export const OrganizeWorkspace = memo(function OrganizeWorkspace({
  active,
  macOS,
  menu,
  organize,
}: OrganizeWorkspaceProps) {
  const { t } = useTranslation()
  const [closedFiles, setClosedFiles] = useState<ReadonlySet<number>>(() => new Set())
  const [size, setSize] = useState(readStoredOrganizeStep)
  const scrollRef = useRef<HTMLElement>(null)
  const { options } = organize.plan
  const chosen = organize.selection
  const busy = organize.adding || organize.assembling
  const empty = organize.plan.groups.length === 0
  const assemblyDone =
    organize.progress !== null && organize.progress.completed >= organize.progress.total

  // The workspace's own keys; undo, redo and select-all come through the
  // window's shortcut table with the viewer's.
  useEffect(() => {
    if (!active) {
      return
    }

    const onKey = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        isTypingTarget(event.target) ||
        hasLayerOverWorkspace()
      ) {
        return
      }

      const primary = event.ctrlKey || event.metaKey

      if ((event.key === "Delete" || event.key === "Backspace") && chosen.size > 0) {
        event.preventDefault()
        organize.remove(chosen)
      } else if (event.key === "Escape") {
        // As in a file manager: Esc lets the pages go and takes back a cut.
        if (chosen.size > 0) {
          organize.setSelection(new Set())
        }

        organize.cancelCut()
      } else if (primary && event.key.toLowerCase() === "x" && chosen.size > 0) {
        event.preventDefault()
        organize.cutSelection()
      } else if (primary && event.key.toLowerCase() === "c" && chosen.size > 0) {
        event.preventDefault()
        organize.copySelection()
      } else if (primary && event.key.toLowerCase() === "v") {
        event.preventDefault()
        organize.paste()
      }
    }

    document.addEventListener("keydown", onKey)

    return () => document.removeEventListener("keydown", onKey)
  }, [active, chosen, organize])

  const chooseSize = (next: number) => {
    setSize(next)
    storeOrganizeStep(next)
  }

  // Stable, so a drag in the sidebar re-renders no file's entry.
  const showGroup = useCallback((groupId: number) => {
    scrollRef.current
      ?.querySelector(`[data-group-id="${groupId}"]`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" })
  }, [])

  const { pages } = organize
  const showPage = useCallback(
    (pageNumber: number) => {
      const page = pages[pageNumber - 1]

      if (page?.kind === "slot") {
        scrollRef.current
          ?.querySelector(`[data-slot-key="${page.slot.key}"]`)
          ?.scrollIntoView({ behavior: "smooth", block: "nearest" })
      }
    },
    [pages],
  )

  const folds = { closed: closedFiles, setClosed: setClosedFiles }

  return (
    <div
      aria-hidden={!active}
      className="app-surface h-svh overflow-hidden"
      data-organize-workspace
      hidden={!active}
    >
      <AppSidebar
        macOS={macOS}
        switcher={<OrganizeFileListHeader folds={folds} organize={organize} />}
      >
        <OrganizeFileList
          folds={folds}
          onShowFile={showGroup}
          onShowPage={showPage}
          organize={organize}
        />
      </AppSidebar>

      <ToolbarFrame
        active={active}
        appMenu={<AppMenu {...menu} />}
        end={
          <>
            <ToolbarTooltip label={t("annotate.undo")} shortcut={shortcuts.undo}>
              <Button
                aria-label={t("annotate.undo")}
                disabled={busy || !organize.canUndo}
                onClick={organize.undo}
                size="icon-sm"
                variant="outline"
              >
                <Undo2 />
              </Button>
            </ToolbarTooltip>
            <ToolbarTooltip label={t("organize.addFiles")}>
              <Button
                aria-label={t("organize.addFiles")}
                data-slot="organize-add"
                disabled={busy}
                onClick={() => void organize.chooseFiles()}
                size="icon-sm"
                variant="outline"
              >
                <FolderPlus />
              </Button>
            </ToolbarTooltip>
            <ButtonGroup>
              <ToolbarTooltip label={t("organize.rotateCounterclockwise")}>
                <Button
                  aria-label={t("organize.rotateCounterclockwise")}
                  data-slot="organize-rotate-left"
                  disabled={busy || chosen.size === 0}
                  onClick={() => organize.rotate(chosen, 270)}
                  size="icon-sm"
                  variant="outline"
                >
                  <RotateCcw />
                </Button>
              </ToolbarTooltip>
              <ToolbarTooltip label={t("organize.rotateClockwise")}>
                <Button
                  aria-label={t("organize.rotateClockwise")}
                  data-slot="organize-rotate"
                  disabled={busy || chosen.size === 0}
                  onClick={() => organize.rotate(chosen, 90)}
                  size="icon-sm"
                  variant="outline"
                >
                  <RotateCw />
                </Button>
              </ToolbarTooltip>
              {/* With nothing chosen, either one adds at the last file's end. */}
              <ToolbarTooltip label={t("pageEdit.insertBlankBefore")}>
                <Button
                  aria-label={t("pageEdit.insertBlankBefore")}
                  data-slot="organize-insert-blank-before"
                  disabled={busy || empty}
                  onClick={() => organize.insertBlankAt(chosen, "before")}
                  size="icon-sm"
                  variant="outline"
                >
                  <InsertBeforeIcon />
                </Button>
              </ToolbarTooltip>
              <ToolbarTooltip label={t("pageEdit.insertBlankAfter")}>
                <Button
                  aria-label={t("pageEdit.insertBlankAfter")}
                  data-slot="organize-insert-blank-after"
                  disabled={busy || empty}
                  onClick={() => organize.insertBlankAt(chosen, "after")}
                  size="icon-sm"
                  variant="outline"
                >
                  <InsertAfterIcon />
                </Button>
              </ToolbarTooltip>
              <ToolbarTooltip label={t("organize.delete")}>
                <Button
                  aria-label={t("organize.delete")}
                  data-slot="organize-delete"
                  disabled={busy || chosen.size === 0}
                  onClick={() => organize.remove(chosen)}
                  size="icon-sm"
                  variant="outline"
                >
                  <Trash2 />
                </Button>
              </ToolbarTooltip>
            </ButtonGroup>
            <ButtonGroup>
              <ToolbarTooltip label={t("organize.smartPadding")}>
                <Toggle
                  aria-label={t("organize.smartPadding")}
                  className="size-7 min-w-7 p-0"
                  data-slot="organize-smart-padding"
                  disabled={busy}
                  onPressedChange={(pressed) =>
                    organize.changeOptions({ smartPadding: pressed })
                  }
                  pressed={options.smartPadding}
                  variant="outline"
                >
                  <BetweenHorizontalStart />
                </Toggle>
              </ToolbarTooltip>
              <ToolbarTooltip label={t("organize.normalizeA4")}>
                <Toggle
                  aria-label={t("organize.normalizeA4")}
                  className="size-7 min-w-7 p-0"
                  data-slot="organize-normalize-a4"
                  disabled={busy}
                  onPressedChange={(pressed) =>
                    organize.changeOptions({ normalizeA4: pressed })
                  }
                  pressed={options.normalizeA4}
                  variant="outline"
                >
                  <Scaling />
                </Toggle>
              </ToolbarTooltip>
              <ToolbarTooltip
                label={t(options.bookmarks ? "organize.saveBookmarks" : "organize.skipBookmarks")}
              >
                <Toggle
                  aria-label={t("organize.saveBookmarks")}
                  className="size-7 min-w-7 p-0"
                  data-slot="organize-bookmarks"
                  disabled={busy}
                  onPressedChange={(pressed) => organize.changeOptions({ bookmarks: pressed })}
                  pressed={options.bookmarks}
                  variant="outline"
                >
                  <Bookmark />
                </Toggle>
              </ToolbarTooltip>
            </ButtonGroup>
          </>
        }
        macOS={macOS}
        start={
          <ButtonGroup>
            <ToolbarTooltip label={t("organize.preview")}>
              <Button
                aria-label={t("organize.preview")}
                data-slot="organize-preview"
                disabled={busy || organize.pages.length === 0}
                onClick={() => void organize.assemble("preview")}
                size="sm"
                variant="outline"
              >
                <Eye data-icon="inline-start" />
                {t("organize.previewButton")}
              </Button>
            </ToolbarTooltip>
            <ToolbarTooltip label={t("organize.saveAs")}>
              <Button
                aria-label={t("organize.saveAs")}
                data-slot="organize-save"
                disabled={busy || organize.pages.length === 0}
                onClick={() => void organize.assemble("save")}
                size="sm"
                variant="outline"
              >
                <FileOutput data-icon="inline-start" />
                {t("organize.saveButton")}
              </Button>
            </ToolbarTooltip>
          </ButtonGroup>
        }
      />

      <div className="relative ml-(--sidebar-inset) h-[calc(100%-var(--status-bar-height))]">
        <main
          className="overlay-scroll-viewport workspace-background h-full overflow-auto pt-(--toolbar-height)"
          data-thumbnail-scroll-root
          ref={scrollRef}
        >
          {empty ? (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
              <Layers className="size-12 text-muted-foreground" />
              <h1 className="text-lg font-semibold">{t("organize.emptyTitle")}</h1>
              <p className="max-w-md text-sm text-muted-foreground">
                {t("organize.emptyHint")}
              </p>
              <Button
                className="mt-2"
                data-slot="organize-empty-add"
                disabled={busy}
                onClick={() => void organize.chooseFiles()}
              >
                <FolderPlus />
                {t("organize.addFiles")}
              </Button>
            </div>
          ) : (
            <OrganizeBoard
              organize={organize}
              paperWidth={ORGANIZE_PAPER_WIDTHS[size]!}
              scrollRef={scrollRef}
            />
          )}
        </main>
        {/* The board runs on under the toolbar; its bar starts below it. */}
        <OverlayScrollbars className="top-(--toolbar-height)" viewportRef={scrollRef} />
      </div>

      {/* Shown while empty too, disabled: the strip is reserved either way. */}
      <StatusBar
        label={t("organize.size")}
        start={
          <span
            className="truncate text-sm tabular-nums text-muted-foreground"
            data-slot="organize-total"
          >
            {t("organize.pagesFromFiles", {
              files: t("organize.fileCount", { count: organize.plan.groups.length }),
              pages: t("organize.pageCount", { count: organize.pages.length }),
            })}
          </span>
        }
      >
        <SliderStepper
          canDecrease={size > 0}
          disabled={empty}
          canIncrease={size < ORGANIZE_PAPER_WIDTHS.length - 1}
          decrease={{ label: t("organize.smaller") }}
          groupLabel={t("organize.size")}
          increase={{ label: t("organize.larger") }}
          max={ORGANIZE_PAPER_WIDTHS.length - 1}
          min={0}
          // Only the size let go at is written, not each one dragged past.
          onCommit={chooseSize}
          onDecrease={() => chooseSize(Math.max(0, size - 1))}
          onIncrease={() =>
            chooseSize(Math.min(ORGANIZE_PAPER_WIDTHS.length - 1, size + 1))
          }
          // Four sizes only, so each is laid out as the thumb reaches it.
          onPreview={setSize}
          sliderLabel={t("organize.size")}
          slot="organize-size"
          value={size}
          valueText={(step) =>
            t("organize.sizeStep", {
              current: step + 1,
              total: ORGANIZE_PAPER_WIDTHS.length,
            })
          }
        />
      </StatusBar>

      {/* Not before the first report: until then a save's dialog may be up. */}
      <Dialog open={active && organize.assembling && organize.progress !== null}>
        <DialogContent data-testid="organize-progress" showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>{t("organize.assembling")}</DialogTitle>
            <DialogDescription>
              {t("organize.totalPages", { count: organize.pages.length })}
            </DialogDescription>
          </DialogHeader>
          <OperationProgress
            label={t("organize.assembling")}
            progress={organize.progress}
          />
          <DialogFooter>
            <Button
              // Past the last step nothing checks for a Stop: a save's write runs on.
              disabled={organize.stopping || assemblyDone}
              onClick={organize.stopAssembling}
              variant="outline"
            >
              {organize.stopping ? t("organize.stopping") : t("organize.stop")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
})
