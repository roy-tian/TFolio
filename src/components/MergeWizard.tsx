import { Check, FileUp } from "lucide-react"
import { useTranslation } from "react-i18next"

import { MergeFileList } from "@/components/MergeFileList"
import { MergeOptions } from "@/components/MergeOptions"
import { OperationProgress } from "@/components/OperationProgress"
import { PageNumbersSettings } from "@/components/PageNumbersSettings"
import { WatermarkSettings } from "@/components/WatermarkSettings"
import { Button } from "@/components/ui/button"
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
import type { useMergeWizard } from "@/hooks/useMergeWizard"
import {
  hasExistingBookmarks,
  isMergeBookmarksMode,
  MAX_MERGE_FILES,
  mergeBookmarksModes,
  type MergeBookmarksMode,
  type MergeWizardStep,
} from "@/lib/mergeWizard"
import { cn } from "@/lib/utils"
import { wordConversionAvailable } from "@/lib/wordConversion"

const stepTitleKey = {
  files: "mergeWizard.stepFiles",
  bookmarks: "mergeWizard.stepBookmarks",
  pageNumbers: "mergeWizard.stepPageNumbers",
  watermark: "mergeWizard.stepWatermark",
} as const satisfies Record<MergeWizardStep, string>

const bookmarksLabelKey = {
  perFile: "mergeWizard.bookmarksPerFile",
  keepExisting: "mergeWizard.bookmarksKeepExisting",
  perFileWithExisting: "mergeWizard.bookmarksPerFileWithExisting",
} as const satisfies Record<MergeBookmarksMode, string>

const bookmarksHintKey = {
  perFile: "mergeWizard.bookmarksPerFileHint",
  keepExisting: "mergeWizard.bookmarksKeepExistingHint",
  perFileWithExisting: "mergeWizard.bookmarksPerFileWithExistingHint",
} as const satisfies Record<MergeBookmarksMode, string>

type MergeWizardProps = {
  draggingFiles: boolean
  wizard: ReturnType<typeof useMergeWizard>
}

export function MergeWizard({ draggingFiles, wizard }: MergeWizardProps) {
  const { t } = useTranslation()
  const {
    back,
    bookmarks,
    error,
    files,
    finish,
    isBusy,
    isLastStep,
    isStopping,
    mergePhase,
    mergeProgress,
    next,
    onOpenChange,
    open,
    pageNumbersDraft,
    pageNumbersError,
    setBookmarks,
    setPageNumbersDraft,
    setWatermarkDraft,
    step,
    stepBlocked,
    steps,
    stop,
    totalPages,
    watermarkDraft,
    watermarkError,
  } = wizard

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
      {/* Fixed at the tallest step's needs — the watermark settings plus an
          error line — so the frame never jumps between steps. */}
      <DialogContent
        aria-busy={mergeProgress !== null}
        className="flex h-[36rem] max-h-[calc(100svh-2rem)] w-[52rem] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(52rem,calc(100svw-2rem))]"
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

        <DialogHeader className="border-b py-4 pr-12 pl-5">
          <DialogTitle>{t("mergeWizard.title")}</DialogTitle>
        </DialogHeader>

        {/* A column, so each step can fill the fixed height or centre in it;
            `my-auto`, not `justify-center`, keeps over-tall steps scrollable. */}
        <div
          className={cn(
            "flex min-h-0 flex-1 flex-col p-5",
            step === "files" && !mergeProgress
              ? "overflow-y-auto sm:overflow-hidden"
              : "overflow-y-auto",
          )}
        >
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
            <div
              className="grid min-h-0 flex-1 grid-cols-1 gap-5 sm:grid-cols-[minmax(0,1fr)_19rem]"
              data-testid="merge-wizard-files"
            >
              <MergeFileList wizard={wizard} />
              <MergeOptions wizard={wizard} />
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
            <PageNumbersSettings
              className="my-auto"
              draft={pageNumbersDraft}
              idPrefix="merge-wizard-numbers"
              onDraftChange={setPageNumbersDraft}
              pageCount={totalPages}
              validationError={pageNumbersError}
            />
          ) : null}

          {!mergeProgress && step === "watermark" ? (
            <WatermarkSettings
              className="my-auto"
              draft={watermarkDraft}
              idPrefix="merge-wizard-mark"
              onDraftChange={setWatermarkDraft}
              validationError={watermarkError}
            />
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
                  {isBusy ? progressLabel : t("mergeWizard.merge")}
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
      </DialogContent>
    </Dialog>
  )
}
