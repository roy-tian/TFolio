import { memo, useRef, type ReactNode } from "react"
import { createPortal } from "react-dom"
import {
  Check,
  FilePlus2,
  FileText,
  FileUp,
  FileWarning,
  GripVertical,
  Image as ImageIcon,
  TriangleAlert,
  X,
} from "lucide-react"
import { useTranslation } from "react-i18next"

import { HintTooltip } from "@/components/HintTooltip"
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
import {
  hasExistingBookmarks,
  isMergeBookmarksMode,
  isMergeExportMode,
  isUsableFile,
  MAX_MERGE_FILES,
  mergeBookmarksModes,
  mergeExportModes,
  mergesIntoOneDocument,
  usableFiles,
  type MergeBookmarksMode,
  type MergeExportMode,
  type MergeFile,
  type MergeWizardStep,
} from "@/lib/mergeWizard"
import { isWindows } from "@/lib/platform"
import { cn } from "@/lib/utils"
import { wordConversionAvailable } from "@/lib/wordConversion"

const stepTitleKey = {
  files: "mergeWizard.stepFiles",
  bookmarks: "mergeWizard.stepBookmarks",
  pageNumbers: "mergeWizard.stepPageNumbers",
  watermark: "mergeWizard.stepWatermark",
} as const satisfies Record<MergeWizardStep, string>

const exportModeLabelKey = {
  onePdf: "mergeWizard.exportOnePdf",
  pagePngZip: "mergeWizard.exportPagePngZip",
  watermarkOnlyZip: "mergeWizard.exportWatermarkOnlyZip",
} as const satisfies Record<MergeExportMode, string>

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
  draggingFiles: boolean
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
        ) : null
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

/** One caution under the settings that raised it: both notes the step can show
    carry the same mark and colour, so neither reads as louder than the other. */
function SettingNote({
  children,
  testId,
}: {
  children: ReactNode
  testId?: string
}) {
  return (
    <p
      className="flex items-start gap-1.5 text-xs text-warning"
      data-testid={testId}
    >
      <TriangleAlert className="mt-px size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  )
}

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

/**
 * The face of the state in `useMergeWizard`. Which steps are asked follows the
 * export the first step names, so the footer trail is that export's own.
 */
export function MergeWizard({ draggingFiles, wizard }: MergeWizardProps) {
  const { t } = useTranslation()
  const listRef = useRef<HTMLOListElement>(null)
  const {
    back,
    bookmarks,
    chooseFiles,
    error,
    exportMode,
    files,
    finish,
    isBusy,
    isLastStep,
    isStopping,
    mergePhase,
    mergeProgress,
    next,
    normalizeA4,
    onOpenChange,
    open,
    pageNumbersDraft,
    pageNumbersError,
    pageNumbersOn,
    removeFile,
    reorderFile,
    setBookmarks,
    setExportMode,
    setNormalizeA4,
    setPageNumbersDraft,
    setPageNumbersOn,
    setSmartPadding,
    setWatermarkDraft,
    setWatermarkOn,
    smartPadding,
    step,
    stepBlocked,
    steps,
    stop,
    stopAdding,
    totalPages,
    watermarkDraft,
    watermarkError,
    watermarkOn,
  } = wizard

  // Only on the step that shows the list, so no gesture is watched for while
  // the settings steps are on screen.
  const { drag } = useListDrag({
    active: open && step === "files" && files.length > 1,
    listRef,
    onReorder: reorderFile,
  })
  // Nothing between the files to pad where they never become one document.
  const merges = mergesIntoOneDocument(exportMode)
  // The files that will actually be merged — the count the summary reports, so
  // a row the backend could not read is not counted into the total beside it.
  const usableCount = usableFiles(files).length
  const draggedFile = drag ? files[drag.index] : undefined
  const progressLabel =
    mergePhase === "pageNumbers"
      ? t("mergeWizard.addingPageNumbers")
      : mergePhase === "watermark"
        ? t("mergeWizard.addingWatermark")
        : mergePhase === "archive"
          ? t("mergeWizard.writingArchive")
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
      {/* Fixed at the tallest step's needs — the watermark settings plus an
          error line — so the frame never jumps between steps. */}
      <DialogContent
        aria-busy={mergeProgress !== null}
        className="flex h-[34rem] max-h-[calc(100svh-2rem)] w-[52rem] flex-col gap-0 overflow-hidden p-0 sm:max-w-[52rem]"
        data-testid="merge-wizard"
        showCloseButton={!isBusy}
      >
        {draggingFiles && !mergeProgress ? (
          <div
            className="pointer-events-none absolute inset-3 z-20 grid place-items-center rounded-lg border-2 border-dashed border-primary/60 bg-popover/95 p-6 backdrop-blur-sm"
            data-testid="merge-wizard-file-drop"
            role="status"
          >
            <div className="flex max-w-lg flex-col items-center text-center">
              <FileUp aria-hidden className="mb-4 size-12" />
              <p className="text-lg font-semibold">
                {t("viewer.dropNowMerge")}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {t(
                  wordConversionAvailable()
                    ? "mergeWizard.filesDescription"
                    : "mergeWizard.filesDescriptionPlain",
                )}
              </p>
            </div>
          </div>
        ) : null}

        {/* The step's own switch rides the header, where it cannot read as the
            first of the settings it governs. `pr-12` clears the close button. */}
        <DialogHeader className="flex-row items-center justify-between gap-3 border-b py-4 pr-12 pl-5">
          <DialogTitle>{t("mergeWizard.title")}</DialogTitle>

          {step === "files" ? (
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

          {step === "pageNumbers" ? (
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

          {step === "watermark" && !mergeProgress ? (
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

        {/* A column, so each step can fill the fixed height or centre in it;
            `my-auto`, not `justify-center`, keeps over-tall steps scrollable. */}
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-5">
          {mergeProgress ? (
            <div className="my-auto flex min-h-64 flex-col items-center justify-center gap-3 p-8">
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

          {!mergeProgress && step === "files" ? (
            // What goes in on the left, what is done to it on the right: one
            // column would queue list and settings where neither read as a group.
            <div
              className="grid flex-1 grid-cols-[minmax(0,1fr)_19rem] gap-5"
              data-testid="merge-wizard-files"
            >
              <div className="flex min-w-0 flex-col gap-3">
                {isBusy ? (
                  <div className="flex items-center justify-between gap-2">
                    <p
                      className="text-xs text-muted-foreground"
                      data-testid="merge-wizard-adding"
                    >
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
                      type="button"
                      variant="outline"
                    >
                      {t("mergeWizard.stop")}
                    </Button>
                  </div>
                ) : null}
                {files.length === 0 ? (
                  // Stretched beside the settings with its message in the
                  // middle: an empty list is a target to drop onto.
                  <p className="grid flex-1 place-content-center rounded-lg border border-dashed px-4 py-8 text-center text-sm text-muted-foreground">
                    {t(merges ? "mergeWizard.empty" : "mergeWizard.emptyCopies")}
                  </p>
                ) : (
                  // Its own scroll box keeps the add button and the total where
                  // the reader left them; `pr-2` keeps the scrollbar off the rows.
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

                {/* Pushed to the foot of the column, so the count of what goes
                    in sits under the list however short the list is. */}
                {files.length > 0 ? (
                  <p
                    className="mt-auto text-xs text-muted-foreground"
                    data-testid="merge-wizard-total"
                  >
                    {t("mergeWizard.total", {
                      files: t("mergeWizard.fileCount", { count: usableCount }),
                      pages: t("mergeWizard.pageCount", { count: totalPages }),
                    })}
                  </p>
                ) : null}
              </div>

              <div className="flex flex-col gap-4 border-l pl-5">
                <FieldLabel className="min-w-0 items-start" htmlFor="merge-wizard-a4">
                  <Checkbox
                    checked={normalizeA4}
                    data-testid="merge-wizard-a4"
                    id="merge-wizard-a4"
                    onCheckedChange={setNormalizeA4}
                  />
                  <HintTooltip label={t("mergeWizard.normalizeA4Hint")}>
                    <span>{t("mergeWizard.normalizeA4")}</span>
                  </HintTooltip>
                </FieldLabel>

                {/* Off and unreachable where the files stay separate: there is
                    no sequence between them for a blank page to land in. */}
                <FieldLabel
                  className={cn("min-w-0 items-start", !merges && "opacity-60")}
                  htmlFor="merge-wizard-padding"
                >
                  <Checkbox
                    checked={merges && smartPadding}
                    data-testid="merge-wizard-padding"
                    disabled={!merges}
                    id="merge-wizard-padding"
                    onCheckedChange={setSmartPadding}
                  />
                  {merges ? (
                    <span>{t("mergeWizard.smartPadding")}</span>
                  ) : (
                    <HintTooltip label={t("mergeWizard.smartPaddingUnavailable")}>
                      <span>{t("mergeWizard.smartPadding")}</span>
                    </HintTooltip>
                  )}
                </FieldLabel>

                {/* All three on the page, not behind a trigger: the export
                    chosen decides which steps are even asked. `FieldTitle`
                    names a group, not a control. */}
                <div className="flex flex-col gap-2">
                  <FieldTitle>{t("mergeWizard.exportMode")}</FieldTitle>
                  <RadioGroup
                    aria-label={t("mergeWizard.exportMode")}
                    className="pl-4"
                    onValueChange={(value) => {
                      if (isMergeExportMode(value)) {
                        setExportMode(value)
                      }
                    }}
                    value={exportMode}
                  >
                    {mergeExportModes.map((mode) => (
                      <FieldLabel
                        className="min-w-0 items-start"
                        htmlFor={`merge-wizard-export-${mode}`}
                        key={mode}
                      >
                        <RadioGroupItem
                          data-testid={`merge-wizard-export-${mode}`}
                          id={`merge-wizard-export-${mode}`}
                          value={mode}
                        />
                        <span>{t(exportModeLabelKey[mode])}</span>
                      </FieldLabel>
                    ))}
                  </RadioGroup>
                </div>

                {/* At the foot of the settings, so what they cost is read
                    after what they are — and only where a choice costs. */}
                <div className="mt-auto flex flex-col gap-2 empty:hidden">
                  {normalizeA4 ? (
                    <SettingNote testId="merge-wizard-a4-warning">
                      {t("mergeWizard.normalizeA4Warning")}
                    </SettingNote>
                  ) : null}

                  {!merges ? (
                    <SettingNote>
                      {t("mergeWizard.exportWatermarkOnlyHint")}
                    </SettingNote>
                  ) : null}
                </div>
              </div>
            </div>
          ) : null}

          {!mergeProgress && step === "bookmarks" ? (
            <div className="my-auto flex flex-col gap-3">
              {/* Each answer carries its own explanation, which is what a
                  reader compares here — so it sits on the option. */}
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

          {!mergeProgress && step === "pageNumbers" ? (
            pageNumbersOn ? (
              <PageNumbersSettings
                className="my-auto"
                draft={pageNumbersDraft}
                idPrefix="merge-wizard-numbers"
                onDraftChange={setPageNumbersDraft}
                pageCount={totalPages}
                validationError={pageNumbersError}
              />
            ) : (
              // The governing switch sits in the header, so the off state has
              // to say something here rather than read as a failed step.
              <p className="m-auto py-6 text-center text-sm text-muted-foreground">
                {t("mergeWizard.pageNumbersSkipped")}
              </p>
            )
          ) : null}

          {!mergeProgress && step === "watermark" ? (
            watermarkOn ? (
              <WatermarkSettings
                className="my-auto"
                draft={watermarkDraft}
                idPrefix="merge-wizard-mark"
                onDraftChange={setWatermarkDraft}
                validationError={watermarkError}
              />
            ) : (
              <p className="m-auto py-6 text-center text-sm text-muted-foreground">
                {t("mergeWizard.watermarkSkipped")}
              </p>
            )
          ) : null}
        </div>

        {/* Above the footer, not in it: an error the reader must read does
            not compete with the trail and buttons for the row. */}
        {errorMessage ? (
          <p
            className="border-t px-5 py-2 text-sm text-destructive"
            role="alert"
          >
            {errorMessage}
          </p>
        ) : null}

        <DialogFooter className="mx-0 mb-0 items-center rounded-none border-t px-5 py-4">
          {/* The trail sits with the controls that move along it: passed steps
              tick, the current one is named, all tick once the merge begins. */}
          <ol
            aria-label={t("mergeWizard.steps")}
            className="mr-auto flex items-center gap-1 text-xs"
          >
            {steps.map((named, index) => {
              const position = index + 1
              const done =
                index < steps.indexOf(step) || mergeProgress !== null
              const current = named === step && mergeProgress === null

              return (
                <li
                  aria-current={current ? "step" : undefined}
                  className={cn(
                    "flex items-center gap-1.5 rounded-md px-2 py-1",
                    current
                      ? "bg-primary/10 font-medium text-foreground"
                      : "text-muted-foreground",
                  )}
                  key={named}
                >
                  {done ? (
                    <Check className="size-3.5 text-primary" />
                  ) : (
                    <span className="font-mono tabular-nums">{position}</span>
                  )}
                  <span>{t(stepTitleKey[named])}</span>
                </li>
              )
            })}
          </ol>

          {/* While the run holds the backend, every control here but one would
              be a control that does nothing — so the row becomes that one. */}
          {mergeProgress ? (
            <Button
              data-testid="merge-wizard-stop"
              disabled={isStopping}
              onClick={stop}
              type="button"
              variant="outline"
            >
              {isStopping ? t("mergeWizard.stopping") : t("mergeWizard.stop")}
            </Button>
          ) : (
            <div className="flex gap-2">
              <DialogClose render={<Button disabled={isBusy} variant="outline" />}>
                {t("mergeWizard.cancel")}
              </DialogClose>
              <Button
                disabled={step === "files" || isBusy}
                onClick={back}
                type="button"
                variant="outline"
              >
                {t("mergeWizard.back")}
              </Button>
              {isLastStep ? (
                <Button
                  data-testid="merge-wizard-merge"
                  disabled={stepBlocked || isBusy}
                  onClick={() => void finish()}
                  type="button"
                >
                  {isBusy
                    ? progressLabel
                    : exportMode === "onePdf"
                      ? t("mergeWizard.merge")
                      : t("mergeWizard.export")}
                </Button>
              ) : (
                <Button
                  data-testid="merge-wizard-next"
                  disabled={stepBlocked || isBusy}
                  onClick={next}
                  type="button"
                >
                  {t("mergeWizard.next")}
                </Button>
              )}
            </div>
          )}
        </DialogFooter>

        {drag && draggedFile ? (
          <MergeFileDragGhost drag={drag} file={draggedFile} />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
