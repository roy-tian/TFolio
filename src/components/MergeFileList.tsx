import { memo, useRef } from "react"
import { createPortal } from "react-dom"
import {
  File,
  FilePlus2,
  FileText,
  FileWarning,
  GripVertical,
  Image as ImageIcon,
  Trash2,
  X,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { HintTooltip } from "@/components/HintTooltip"
import { Button } from "@/components/ui/button"
import { Spinner } from "@/components/ui/spinner"
import { useListDrag, type ListDragState } from "@/hooks/useListDrag"
import type { useMergeWizard } from "@/hooks/useMergeWizard"
import { isUsableFile, usableFiles, type MergeFile } from "@/lib/mergeWizard"
import { isWindows } from "@/lib/platform"
import { cn } from "@/lib/utils"
import { wordConversionAvailable } from "@/lib/wordConversion"

type MergeFileRowContentProps = {
  file: MergeFile
  index: number
  onRemove?: (path: string) => void
  disabled?: boolean
  showHandle: boolean
}

/** The one rendering of a file row's contents, shared by its place in the list
    and the copy that rides the pointer. */
const MergeFileRowContent = memo(function MergeFileRowContent({
  file,
  index,
  onRemove,
  showHandle,
  disabled,
}: MergeFileRowContentProps) {
  const { t } = useTranslation()
  const usable = isUsableFile(file)

  return (
    <>
      {showHandle ? (
        <GripVertical className="size-4 shrink-0 text-muted-foreground" />
      ) : null}
      {/* Centred in a fixed column, so the number sits the same distance from
          the handle as from the name, on every row whatever its digits. */}
      <span className="w-4 shrink-0 text-center font-mono text-xs tabular-nums text-muted-foreground">
        {index + 1}
      </span>
      {usable ? (
        // An image is not a document and a Word document arrives by way of
        // one: saying so makes its pages read as intended.
        file.kind === "image" ? (
          <HintTooltip label={t("mergeWizard.imageSource")}>
            <ImageIcon
              aria-label={t("mergeWizard.imageSource")}
              className="size-4 shrink-0 text-muted-foreground"
            />
          </HintTooltip>
        ) : file.kind === "word" ? (
          <HintTooltip label={t("mergeWizard.wordSource")}>
            <FileText
              aria-label={t("mergeWizard.wordSource")}
              className="size-4 shrink-0 text-muted-foreground"
            />
          </HintTooltip>
        ) : (
          <HintTooltip label={t("mergeWizard.pdfSource")}>
            <File
              aria-label={t("mergeWizard.pdfSource")}
              className="size-4 shrink-0 text-muted-foreground"
            />
          </HintTooltip>
        )
      ) : (
        <FileWarning className="size-4 shrink-0 text-destructive" />
      )}
      <HintTooltip label={file.path}>
        <span
          className="min-w-0 flex-1 truncate text-sm"
          data-slot="merge-file-name"
        >
          {file.name}
        </span>
      </HintTooltip>
      <span
        className={cn(
          "shrink-0 text-xs",
          usable ? "text-muted-foreground" : "text-destructive",
        )}
        data-testid="merge-file-status"
      >
        {usable
          ? t("mergeWizard.pageCount", { count: file.pageCount })
          : file.error === "converterMissing"
            ? t("mergeWizard.errorConverterMissing", {
              context: isWindows() ? "windows" : undefined,
            })
            : file.error === "conversionFailed"
              ? t("mergeWizard.errorConversionFailed")
              : t("mergeWizard.unreadable")}
      </span>
      {onRemove ? (
        <HintTooltip label={t("mergeWizard.remove", { name: file.name })}>
          <Button
            disabled={disabled}
            aria-label={t("mergeWizard.remove", { name: file.name })}
            onClick={() => onRemove(file.path)}
            size="icon-sm"
            variant="ghost"
          >
            <X />
          </Button>
        </HintTooltip>
      ) : (
        // Keep the ghost the same width as the real row without putting a
        // second interactive control under the pointer.
        <span className="grid size-7 shrink-0 place-items-center text-muted-foreground">
          <X className="size-4" />
        </span>
      )}
    </>
  )
})

/** The row in hand is portalled to the document root, outside the dialog's
    clipped scroll boxes, so it follows the pointer past either edge. */
function MergeFileDragGhost({
  drag,
  file,
}: {
  drag: ListDragState
  file: MergeFile
}) {
  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed z-60 flex items-center gap-2 rounded-lg border bg-popover px-3 py-2 select-none shadow-xl ring-1 ring-primary/20"
      data-slot="merge-file-drag-ghost"
      style={{
        height: drag.height,
        left: drag.pointer.x + drag.grip.x,
        top: drag.pointer.y + drag.grip.y,
        width: drag.width,
      }}
    >
      <MergeFileRowContent
        file={file}
        index={drag.index}
        showHandle
      />
    </div>,
    document.body,
  )
}

export function MergeFileList({ wizard }: {
  wizard: ReturnType<typeof useMergeWizard>
}) {
  const { t } = useTranslation()
  const listRef = useRef<HTMLOListElement>(null)
  const pressedBlank = useRef(false)
  const {
    files,
    chooseFiles,
    clearFiles,
    isBusy,
    removeFile,
    reorderFile,
    stopAdding,
    totalPages,
    smartPadding,
    paddingNeeded,
  } = wizard
  const { drag } = useListDrag({
    active: !isBusy && files.length > 1,
    listRef,
    onReorder: reorderFile,
  })
  const draggedFile = drag ? files[drag.index] : undefined
  const usableCount = usableFiles(files).length
  const excludedCount = files.length - usableCount

  return (
    <section
      className="flex min-h-64 min-w-0 flex-col rounded-lg border border-dashed sm:min-h-0"
      aria-label={t("mergeWizard.fileList")}
    >
      <div className="flex shrink-0 flex-wrap items-center gap-2 px-3 pt-3">
        <span className="mr-auto text-sm font-medium">{t("mergeWizard.fileList")}</span>
        <Button
          data-testid="merge-wizard-add"
          disabled={isBusy}
          onClick={() => void chooseFiles()}
          size="sm"
          variant="outline"
        >
          <FilePlus2 />
          {t("mergeWizard.addFiles")}
        </Button>
        <Button
          data-testid="merge-wizard-clear"
          disabled={isBusy || files.length === 0}
          onClick={clearFiles}
          size="sm"
          variant="ghost"
        >
          <Trash2 />
          {t("mergeWizard.clearFiles")}
        </Button>
      </div>
      {isBusy ? (
        <div className="flex items-center justify-between gap-2 px-3 pt-2">
          <p
            className="flex items-center gap-2 text-xs text-muted-foreground"
            data-testid="merge-wizard-adding"
            role="status"
          >
            <Spinner className="size-3.5 shrink-0" />
            {t(
              wordConversionAvailable()
                ? "mergeWizard.addingFiles"
                : "mergeWizard.addingFilesPlain",
            )}
          </p>
          <Button
            data-testid="merge-wizard-stop-adding"
            onClick={() => void stopAdding()}
            size="sm"
            variant="outline"
          >
            {t("mergeWizard.stop")}
          </Button>
        </div>
      ) : null}
      {files.length === 0 ? (
        <button
          aria-label={t("mergeWizard.addFiles")}
          className="min-h-24 flex-1 cursor-pointer rounded-lg focus-visible:outline-2 focus-visible:outline-ring disabled:cursor-default"
          data-testid="merge-wizard-empty-add"
          disabled={isBusy}
          onClick={() => void chooseFiles()}
          type="button"
        />
      ) : (
        <ol
          className="flex min-h-0 flex-1 select-none flex-col gap-1.5 overflow-y-auto p-3"
          ref={listRef}
          onPointerDown={(event) => {
            pressedBlank.current = event.target === event.currentTarget
          }}
          onClick={(event) => {
            if (pressedBlank.current && event.target === event.currentTarget && !isBusy && !drag) {
              void chooseFiles()
            }
          }}
        >
          {files.map((file, index) => {
            const rowOffset = drag?.rowOffsets[index] ?? 0

            return (
              <li
                className={cn(
                  "relative flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 select-none",
                  files.length > 1 && !isBusy && "cursor-grab",
                  drag &&
                    drag.index !== index &&
                    "transition-transform duration-200 ease-out",
                  // The portal ghost carries this file; the real row
                  // stays as the hole the others move around to fill.
                  drag?.index === index && "opacity-0",
                )}
                data-list-index={index}
                data-slot="merge-file"
                key={file.path}
                style={{
                  transform:
                    rowOffset === 0
                      ? undefined
                      : `translateY(${rowOffset}px)`,
                }}
              >
                {/* The equal, opposite transform keeps the landing
                    line in the list's original coordinate space. */}
                {drag &&
                (drag.gap === index ||
                  (drag.gap === files.length &&
                    index === files.length - 1)) ? (
                  <span
                    className={cn(
                      "pointer-events-none absolute inset-x-0 h-0.5 rounded-full bg-primary",
                      drag.gap === index ? "-top-1" : "-bottom-1",
                      drag.index !== index &&
                        "transition-transform duration-200 ease-out",
                    )}
                    style={{
                      transform:
                        rowOffset === 0
                          ? undefined
                          : `translateY(${-rowOffset}px)`,
                    }}
                  />
                ) : null}
                <MergeFileRowContent
                  disabled={isBusy}
                  file={file}
                  index={index}
                  onRemove={removeFile}
                  showHandle={files.length > 1}
                />
              </li>
            )
          })}
        </ol>
      )}
      <div
        className="min-h-14 shrink-0 px-3 pb-3 pt-2 text-xs text-muted-foreground"
        data-testid="merge-wizard-total"
        role="status"
      >
        {files.length === 0 ? t("mergeWizard.empty") : (
          <>
            <p>
              {t("mergeWizard.total", {
                files: t("mergeWizard.fileCount", { count: usableCount }),
                pages: t("mergeWizard.pageCount", { count: totalPages }),
              })}
              {smartPadding
                ? ` ${t("mergeWizard.paddingIncluded", { count: paddingNeeded })}`
                : ""}
            </p>
            {excludedCount > 0 ? (
              <p className="mt-1">
                {t("mergeWizard.excludedFiles", { count: excludedCount })}
              </p>
            ) : null}
          </>
        )}
      </div>
      {drag && draggedFile ? (
        <MergeFileDragGhost drag={drag} file={draggedFile} />
      ) : null}
    </section>
  )
}
