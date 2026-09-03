import { memo, useRef } from "react"
import { createPortal } from "react-dom"
import { Check, FilePlus2, FileWarning, GripVertical, X } from "lucide-react"
import { useTranslation } from "react-i18next"

import { OperationProgress } from "@/components/OperationProgress"
import { PageNumbersSettings } from "@/components/PageNumbersSettings"
import { WatermarkSettings } from "@/components/WatermarkSettings"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldLabel,
  FieldTitle,
} from "@/components/ui/field"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Switch } from "@/components/ui/switch"
import { useListDrag, type ListDragState } from "@/hooks/useListDrag"
import type { useMergeWizard } from "@/hooks/useMergeWizard"
import { MERGE_WIZARD_STEPS } from "@/hooks/useMergeWizard"
import {
  hasExistingBookmarks,
  isMergeBookmarksMode,
  isUsableFile,
  MAX_MERGE_FILES,
  mergeBookmarksModes,
  usableFiles,
  type MergeBookmarksMode,
  type MergeFile,
} from "@/lib/mergeWizard"
import { cn } from "@/lib/utils"

const stepTitleKey = [
  "mergeWizard.stepFiles",
  "mergeWizard.stepBookmarks",
  "mergeWizard.stepPageNumbers",
  "mergeWizard.stepWatermark",
] as const

const bookmarksLabelKey = {
  none: "mergeWizard.bookmarksNone",
  perFile: "mergeWizard.bookmarksPerFile",
  keepExisting: "mergeWizard.bookmarksKeepExisting",
  perFileWithExisting: "mergeWizard.bookmarksPerFileWithExisting",
} as const satisfies Record<MergeBookmarksMode, string>

const bookmarksHintKey = {
  none: "mergeWizard.bookmarksNoneHint",
  perFile: "mergeWizard.bookmarksPerFileHint",
  keepExisting: "mergeWizard.bookmarksKeepExistingHint",
  perFileWithExisting: "mergeWizard.bookmarksPerFileWithExistingHint",
} as const satisfies Record<MergeBookmarksMode, string>

type MergeWizardProps = {
  wizard: ReturnType<typeof useMergeWizard>
}

type MergeFileRowContentProps = {
  file: MergeFile
  index: number
  onRemove?: (path: string) => void
  showHandle: boolean
}

/** The one rendering of a file row's contents, shared by its place in the list
    and the copy that rides the pointer. */
const MergeFileRowContent = memo(function MergeFileRowContent({
  file,
  index,
  onRemove,
  showHandle,
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
      {usable ? null : (
        <FileWarning className="size-4 shrink-0 text-destructive" />
      )}
      <span className="min-w-0 flex-1 truncate text-sm" title={file.path}>
        {file.name}
      </span>
      <span
        className={cn(
          "shrink-0 text-xs",
          usable ? "text-muted-foreground" : "text-destructive",
        )}
      >
        {usable
          ? t("mergeWizard.pageCount", { count: file.pageCount })
          : t("mergeWizard.unreadable")}
      </span>
      {onRemove ? (
        <Button
          aria-label={t("mergeWizard.remove", { name: file.name })}
          onClick={() => onRemove(file.path)}
          size="icon-sm"
          title={t("mergeWizard.remove", { name: file.name })}
          variant="ghost"
        >
          <X />
        </Button>
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

/** The row in hand lives at the document root, outside both of the dialog's
    clipped scroll boxes. It can therefore follow the pointer beyond either
    edge instead of losing whichever half crossed the boundary. */
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

/**
 * The four questions a merge answers, one step at a time: which files and in
 * what order, what the outline becomes, and whether the result carries page
 * numbers and a watermark.
 *
 * The whole state lives in `useMergeWizard`; this is its face.
 */
export function MergeWizard({ wizard }: MergeWizardProps) {
  const { t } = useTranslation()
  const listRef = useRef<HTMLOListElement>(null)
  const {
    back,
    bookmarks,
    chooseFiles,
    error,
    files,
    finish,
    isBusy,
    mergePhase,
    mergeProgress,
    next,
    onOpenChange,
    open,
    pageNumbersDraft,
    pageNumbersError,
    pageNumbersOn,
    removeFile,
    reorderFile,
    setBookmarks,
    setPageNumbersDraft,
    setPageNumbersOn,
    setSmartPadding,
    setWatermarkDraft,
    setWatermarkOn,
    smartPadding,
    step,
    stepBlocked,
    totalPages,
    watermarkDraft,
    watermarkError,
    watermarkOn,
  } = wizard

  // Only on the step that shows the list, so no gesture is watched for while
  // the settings steps are on screen.
  const { drag } = useListDrag({
    active: open && step === 1 && files.length > 1,
    listRef,
    onReorder: reorderFile,
  })
  // The files that will actually be merged — the count the summary reports, so
  // a row the backend could not read is not counted into the total beside it.
  const usableCount = usableFiles(files).length
  const draggedFile = drag ? files[drag.index] : undefined
  const progressLabel =
    mergePhase === "pageNumbers"
      ? t("mergeWizard.addingPageNumbers")
      : mergePhase === "watermark"
        ? t("mergeWizard.addingWatermark")
        : t("mergeWizard.merging")
  const errorMessage =
    error === "fileTooLarge"
      ? t("viewer.fileTooLarge")
      : error === "invalidFile"
        ? t("viewer.invalidFile")
        : error === "tooManyFiles"
          ? t("mergeWizard.errorTooMany", { count: MAX_MERGE_FILES })
          : error === "mergeFailed"
            ? t("mergeWizard.errorMerge")
            : null

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        aria-busy={mergeProgress !== null}
        className="flex max-h-[calc(100svh-2rem)] w-[46rem] flex-col gap-0 overflow-hidden p-0 sm:max-w-[46rem]"
        data-testid="merge-wizard"
        showCloseButton={!isBusy}
      >
        {/* The step's own switch — is there anything to configure at all? —
            rides the header rather than the body, where it would read as the
            first of the settings it governs. `pr-12` clears the close button. */}
        <DialogHeader className="flex-row items-center justify-between gap-3 border-b py-4 pr-12 pl-5">
          <DialogTitle>{t("mergeWizard.title")}</DialogTitle>

          {step === 1 ? (
            <Button
              data-testid="merge-wizard-add"
              disabled={isBusy}
              onClick={() => void chooseFiles()}
              size="sm"
              type="button"
              variant="outline"
            >
              <FilePlus2 data-icon="inline-start" />
              {t("mergeWizard.addFiles")}
            </Button>
          ) : null}

          {step === 3 ? (
            <div className="flex items-center gap-2">
              <FieldLabel htmlFor="merge-wizard-page-numbers">
                {t("mergeWizard.pageNumbersEnable")}
              </FieldLabel>
              <Switch
                checked={pageNumbersOn}
                data-testid="merge-wizard-page-numbers"
                id="merge-wizard-page-numbers"
                onCheckedChange={setPageNumbersOn}
              />
            </div>
          ) : null}

          {step === 4 && !mergeProgress ? (
            <div className="flex items-center gap-2">
              <FieldLabel htmlFor="merge-wizard-watermark">
                {t("mergeWizard.watermarkEnable")}
              </FieldLabel>
              <Switch
                checked={watermarkOn}
                data-testid="merge-wizard-watermark"
                id="merge-wizard-watermark"
                onCheckedChange={setWatermarkOn}
              />
            </div>
          ) : null}
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          {mergeProgress ? (
            <div className="flex min-h-64 flex-col items-center justify-center gap-3 p-8">
              <OperationProgress
                className="max-w-sm"
                label={progressLabel}
                progress={mergeProgress}
                testId="merge-wizard-progress"
              />
              <p className="text-center text-xs text-muted-foreground">
                {t("mergeWizard.progressHint")}
              </p>
            </div>
          ) : null}

          {!mergeProgress && step === 1 ? (
            <div className="flex flex-col gap-4" data-testid="merge-wizard-files">
              {files.length === 0 ? (
                <p className="rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                  {t("mergeWizard.empty")}
                </p>
              ) : (
                // A box of its own rather than the dialog's: a long list scrolls
                // here, leaving the add button, the padding option and total
                // where the reader left them. The right padding keeps the
                // overlay scrollbar off the rows' own border.
                <ol
                  className="flex max-h-64 select-none flex-col gap-1.5 overflow-y-auto pr-2"
                  ref={listRef}
                >
                  {files.map((file, index) => {
                    const rowOffset = drag?.rowOffsets[index] ?? 0

                    return (
                      <li
                        className={cn(
                          "relative flex shrink-0 items-center gap-2 rounded-lg border px-3 py-2 select-none",
                          files.length > 1 && "cursor-grab",
                          drag &&
                            drag.index !== index &&
                            "transition-transform duration-200 ease-out",
                          // The portal ghost carries this file; its real row
                          // stays in the layout as the hole the others move
                          // around, but must not show beneath the copy.
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
                        {/* Keep the landing line in the list's original
                            coordinate space while its host row animates aside.
                            The equal, opposite transform cancels the row's. */}
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

              <div className="flex items-center gap-4">
                <FieldLabel className="min-w-0" htmlFor="merge-wizard-padding">
                  <Checkbox
                    checked={smartPadding}
                    data-testid="merge-wizard-padding"
                    id="merge-wizard-padding"
                    onCheckedChange={setSmartPadding}
                  />
                  <span>{t("mergeWizard.smartPadding")}</span>
                </FieldLabel>

                <p
                  className="ml-auto shrink-0 text-sm text-muted-foreground"
                  data-testid="merge-wizard-total"
                >
                  {t("mergeWizard.total", {
                    files: t("mergeWizard.fileCount", { count: usableCount }),
                    pages: t("mergeWizard.pageCount", { count: totalPages }),
                  })}
                </p>
              </div>
            </div>
          ) : null}

          {!mergeProgress && step === 2 ? (
            <div className="flex flex-col gap-3">
              {/* Four exclusive answers, each carrying its own explanation —
                  which is what a reader compares here, so it belongs on the
                  option rather than in a line under the group. */}
              <RadioGroup
                aria-label={t("mergeWizard.stepBookmarks")}
                onValueChange={(value) => {
                  if (isMergeBookmarksMode(value)) {
                    setBookmarks(value)
                  }
                }}
                value={bookmarks}
              >
                {mergeBookmarksModes.map((mode) => (
                  <FieldLabel htmlFor={`merge-wizard-bookmarks-${mode}`} key={mode}>
                    <Field orientation="horizontal">
                      <RadioGroupItem
                        data-testid={`merge-wizard-bookmarks-${mode}`}
                        id={`merge-wizard-bookmarks-${mode}`}
                        value={mode}
                      />
                      <FieldContent>
                        <FieldTitle>{t(bookmarksLabelKey[mode])}</FieldTitle>
                        <FieldDescription>
                          {t(bookmarksHintKey[mode])}
                        </FieldDescription>
                      </FieldContent>
                    </Field>
                  </FieldLabel>
                ))}
              </RadioGroup>
              {/* Only where the choice would quietly do nothing: the two keeping
                  modes have nothing to keep when no file brings an outline. */}
              {!hasExistingBookmarks(files) &&
              (bookmarks === "keepExisting" ||
                bookmarks === "perFileWithExisting") ? (
                <p className="text-xs text-muted-foreground">
                  {t("mergeWizard.bookmarksNoSources")}
                </p>
              ) : null}
            </div>
          ) : null}

          {!mergeProgress && step === 3 ? (
            pageNumbersOn ? (
              <PageNumbersSettings
                draft={pageNumbersDraft}
                idPrefix="merge-wizard-numbers"
                onDraftChange={setPageNumbersDraft}
                pageCount={totalPages}
                validationError={pageNumbersError}
              />
            ) : (
              // The switch that governs this step now sits in the header, so
              // its off state has to say something here — an empty panel would
              // read as a step that failed to load.
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("mergeWizard.pageNumbersSkipped")}
              </p>
            )
          ) : null}

          {!mergeProgress && step === 4 ? (
            watermarkOn ? (
              <WatermarkSettings
                draft={watermarkDraft}
                idPrefix="merge-wizard-mark"
                onDraftChange={setWatermarkDraft}
                validationError={watermarkError}
              />
            ) : (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t("mergeWizard.watermarkSkipped")}
              </p>
            )
          ) : null}
        </div>

        {/* Above the footer rather than in it: the trail and the buttons fill
            that row, and an error the reader has to read must not have to
            compete with them for the space. */}
        {errorMessage ? (
          <p
            className="border-t px-5 py-2 text-sm text-destructive"
            role="alert"
          >
            {errorMessage}
          </p>
        ) : null}

        <DialogFooter className="mx-0 mb-0 items-center rounded-none border-t px-5 py-4">
          {/* The trail sits with the controls that move along it: a step behind
              the reader carries a tick rather than its number, the one they are
              on is named, and all four tick once the merge itself begins. */}
          <ol
            aria-label={t("mergeWizard.steps")}
            className="mr-auto flex items-center gap-1 text-xs"
          >
            {stepTitleKey.map((key, index) => {
              const position = index + 1
              const done = position < step || mergeProgress !== null
              const current = position === step && mergeProgress === null

              return (
                <li
                  aria-current={current ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2 py-1",
                    current
                      ? "bg-primary/10 font-medium text-foreground"
                      : "text-muted-foreground",
                  )}
                  key={key}
                >
                  {done ? (
                    <Check className="size-3.5 text-primary" />
                  ) : (
                    <span className="font-mono tabular-nums">{position}</span>
                  )}
                  <span>{t(key)}</span>
                </li>
              )
            })}
          </ol>

          <div className="flex gap-2">
            <DialogClose render={<Button disabled={isBusy} variant="outline" />}>
              {t("mergeWizard.cancel")}
            </DialogClose>
            <Button
              disabled={step === 1 || isBusy}
              onClick={back}
              type="button"
              variant="outline"
            >
              {t("mergeWizard.back")}
            </Button>
            {step < MERGE_WIZARD_STEPS ? (
              <Button
                data-testid="merge-wizard-next"
                disabled={stepBlocked || isBusy}
                onClick={next}
                type="button"
              >
                {t("mergeWizard.next")}
              </Button>
            ) : (
              <Button
                data-testid="merge-wizard-merge"
                disabled={stepBlocked || isBusy}
                onClick={() => void finish()}
                type="button"
              >
                {isBusy ? progressLabel : t("mergeWizard.merge")}
              </Button>
            )}
          </div>
        </DialogFooter>

        {drag && draggedFile ? (
          <MergeFileDragGhost drag={drag} file={draggedFile} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
