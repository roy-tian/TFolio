import { Info, Trash2 } from "lucide-react"
import type { ReactNode } from "react"
import { useTranslation } from "react-i18next"

import { PageNumbersPreview } from "@/components/PageNumbersPreview"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  clampPageNumbersStart,
  draftFirstPrinted,
  isMode,
  isPosition,
  maxPageNumbersStart,
  type PageNumbersDraft,
  type PageNumbersValidationError,
} from "@/lib/pageNumbers"

type SettingLabelProps = {
  about: string
  children: ReactNode
  /** Absent for the one control that needs no explaining; the row keeps the
      disclosure's height either way, so the two halves stay level. */
  hint?: string
  htmlFor?: string
  id?: string
  /** A fact about the document the control is read against, following the name
      rather than the field, so a wide field does not strand it. */
  note?: string
}

/**
 * A control's name with its explanation folded into a disclosure beside it, so
 * a dialog of eight settings stays four rows tall. Only what a reader has to
 * act on — the errors below — is left on the surface.
 */
function SettingLabel({
  about,
  children,
  hint,
  htmlFor,
  id,
  note,
}: SettingLabelProps) {
  return (
    <div className="flex h-6 min-w-0 items-center gap-0.5">
      <FieldLabel className="min-w-0" htmlFor={htmlFor} id={id}>
        {children}
      </FieldLabel>
      {hint ? (
        <Popover>
          <PopoverTrigger
            render={
              <Button
                aria-label={about}
                size="icon-xs"
                title={about}
                variant="ghost"
              />
            }
          >
            <Info />
          </PopoverTrigger>
          <PopoverContent align="start" className="w-64">
            <p className="text-xs leading-relaxed text-muted-foreground">{hint}</p>
          </PopoverContent>
        </Popover>
      ) : null}
      {note ? (
        <span className="ml-1.5 shrink-0 text-xs text-muted-foreground">
          {note}
        </span>
      ) : null}
    </div>
  )
}

type PageNumbersDialogProps = {
  draft: PageNumbersDraft
  hasPageNumbers: boolean
  isApplying: boolean
  onApply: () => void
  onDraftChange: (draft: PageNumbersDraft) => void
  onOpenChange: (open: boolean) => void
  onRemove: () => void
  open: boolean
  pageCount: number
  validationError: PageNumbersValidationError | null
}

export function PageNumbersDialog({
  draft,
  hasPageNumbers,
  isApplying,
  onApply,
  onDraftChange,
  onOpenChange,
  onRemove,
  open,
  pageCount,
  validationError,
}: PageNumbersDialogProps) {
  const { t } = useTranslation()
  const about = t("pageNumbers.about")
  const maxStart = maxPageNumbersStart(pageCount)

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="flex max-h-[calc(100svh-2rem)] w-[44rem] flex-col gap-0 overflow-hidden p-0 sm:max-w-[44rem]"
        data-testid="page-numbers-dialog"
      >
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>{t("pageNumbers.title")}</DialogTitle>
          <DialogDescription>{t("pageNumbers.description")}</DialogDescription>
        </DialogHeader>

        {/* The body scrolls as a whole, so the columns keep their natural
            heights and short content never earns a scrollbar; from `sm` the
            sheets stick so they stay in view while the controls pass them. */}
        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5 sm:flex-row">
          <Field className="sm:sticky sm:top-0 sm:w-[12rem] sm:shrink-0 sm:self-start">
            <FieldLabel>{t("pageNumbers.preview")}</FieldLabel>
            <PageNumbersPreview
              captions={{
                even: t("pageNumbers.previewEven"),
                every: t("pageNumbers.previewEvery"),
                odd: t("pageNumbers.previewOdd"),
              }}
              mode={draft.mode}
              position={draft.position}
              printed={draftFirstPrinted(draft)}
            />
          </Field>

          {/* Four rows, paired by what a reader decides together: how it prints,
              which pages it covers, what the empty ones get, and its colour. */}
          <div className="min-w-0 flex-1">
            <FieldGroup>
              <div className="grid grid-cols-2 gap-4">
                <Field>
                  <SettingLabel about={about} id="page-numbers-mode-label">
                    {t("pageNumbers.mode")}
                  </SettingLabel>
                  <ToggleGroup
                    aria-labelledby="page-numbers-mode-label"
                    onValueChange={([value]) => {
                      if (value && isMode(value)) {
                        onDraftChange({ ...draft, mode: value })
                      }
                    }}
                    size="sm"
                    spacing={0}
                    value={[draft.mode]}
                    variant="outline"
                  >
                    <ToggleGroupItem value="single">
                      {t("pageNumbers.modeSingle")}
                    </ToggleGroupItem>
                    <ToggleGroupItem value="duplex">
                      {t("pageNumbers.modeDuplex")}
                    </ToggleGroupItem>
                  </ToggleGroup>
                </Field>

                {/* Double-sided mirrors by binding, so the position is not the
                    reader's to pick — shown disabled rather than hidden, so the
                    row does not change shape under the pointer. */}
                <Field data-disabled={draft.mode === "duplex"}>
                  <SettingLabel
                    about={about}
                    hint={t("pageNumbers.positionHint")}
                    id="page-numbers-position-label"
                  >
                    {t("pageNumbers.position")}
                  </SettingLabel>
                  <ToggleGroup
                    aria-labelledby="page-numbers-position-label"
                    disabled={draft.mode === "duplex"}
                    onValueChange={([value]) => {
                      if (value && isPosition(value)) {
                        onDraftChange({ ...draft, position: value })
                      }
                    }}
                    size="sm"
                    spacing={0}
                    value={[draft.position]}
                    variant="outline"
                  >
                    <ToggleGroupItem value="bottomCenter">
                      {t("pageNumbers.positionBottomCenter")}
                    </ToggleGroupItem>
                    <ToggleGroupItem value="bottomRight">
                      {t("pageNumbers.positionBottomRight")}
                    </ToggleGroupItem>
                  </ToggleGroup>
                </Field>
              </div>

              {/* Three columns rather than two: the range's two ends and the
                  start are one kind of field, so they take one width. */}
              <div className="grid grid-cols-3 gap-4">
                <Field
                  className="col-span-2"
                  data-invalid={validationError === "range"}
                >
                  <SettingLabel
                    about={about}
                    hint={t("pageNumbers.rangeHint")}
                    htmlFor="page-numbers-from"
                    note={t("pageNumbers.rangeTotal", { count: pageCount })}
                  >
                    {t("pageNumbers.range")}
                  </SettingLabel>
                  {/* The row's own columns, repeated, so the ends line up with
                      the start beside them; the dash rides the gap between. */}
                  <div className="relative grid min-w-0 grid-cols-2 gap-4">
                    <Input
                      aria-invalid={validationError === "range"}
                      aria-label={t("pageNumbers.rangeFrom")}
                      className="min-w-0"
                      data-testid="page-numbers-from"
                      id="page-numbers-from"
                      inputMode="numeric"
                      max={pageCount}
                      min={1}
                      onChange={(event) =>
                        onDraftChange({ ...draft, rangeFrom: event.target.value })
                      }
                      placeholder="1"
                      type="number"
                      value={draft.rangeFrom}
                    />
                    <span
                      aria-hidden
                      className="pointer-events-none absolute inset-y-0 left-1/2 flex -translate-x-1/2 items-center text-muted-foreground"
                    >
                      –
                    </span>
                    <Input
                      aria-invalid={validationError === "range"}
                      aria-label={t("pageNumbers.rangeTo")}
                      className="min-w-0"
                      data-testid="page-numbers-to"
                      inputMode="numeric"
                      max={pageCount}
                      min={1}
                      onChange={(event) =>
                        onDraftChange({ ...draft, rangeTo: event.target.value })
                      }
                      placeholder={String(pageCount)}
                      type="number"
                      value={draft.rangeTo}
                    />
                  </div>
                  {validationError === "range" ? (
                    <FieldError>
                      {t("pageNumbers.errorRange", { max: pageCount })}
                    </FieldError>
                  ) : null}
                </Field>

                <Field data-invalid={validationError === "start"}>
                  <SettingLabel
                    about={about}
                    hint={t("pageNumbers.startHint")}
                    htmlFor="page-numbers-start"
                  >
                    {t("pageNumbers.start")}
                  </SettingLabel>
                  <Input
                    aria-invalid={validationError === "start"}
                    data-testid="page-numbers-start"
                    id="page-numbers-start"
                    inputMode="numeric"
                    max={maxStart}
                    min={1}
                    // Out of range while typing is only half a number; it is
                    // leaving the field that settles it, so the snap happens
                    // there rather than under the reader's fingers.
                    onBlur={(event) => {
                      const settled = clampPageNumbersStart(
                        event.target.value,
                        pageCount,
                      )

                      if (settled !== draft.start) {
                        onDraftChange({ ...draft, start: settled })
                      }
                    }}
                    onChange={(event) =>
                      onDraftChange({ ...draft, start: event.target.value })
                    }
                    placeholder={t("pageNumbers.startPlaceholder")}
                    type="number"
                    value={draft.start}
                  />
                  {validationError === "start" ? (
                    <FieldError>
                      {t("pageNumbers.errorStart", { max: maxStart })}
                    </FieldError>
                  ) : null}
                </Field>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <Field orientation="horizontal">
                  <SettingLabel
                    about={about}
                    hint={t("pageNumbers.blankCountedHint")}
                    htmlFor="page-numbers-blank-counted"
                  >
                    {t("pageNumbers.blankCounted")}
                  </SettingLabel>
                  <Switch
                    checked={draft.blankCounted}
                    className="ml-auto"
                    data-testid="page-numbers-blank-counted"
                    id="page-numbers-blank-counted"
                    onCheckedChange={(blankCounted) =>
                      onDraftChange({ ...draft, blankCounted })
                    }
                  />
                </Field>

                {/* A page that takes no number has none to print, so this
                    follows the switch beside it rather than standing against it. */}
                <Field
                  data-disabled={!draft.blankCounted}
                  orientation="horizontal"
                >
                  <SettingLabel
                    about={about}
                    hint={t("pageNumbers.blankNumberedHint")}
                    htmlFor="page-numbers-blank-numbered"
                  >
                    {t("pageNumbers.blankNumbered")}
                  </SettingLabel>
                  <Switch
                    checked={draft.blankCounted && draft.blankNumbered}
                    className="ml-auto"
                    data-testid="page-numbers-blank-numbered"
                    disabled={!draft.blankCounted}
                    id="page-numbers-blank-numbered"
                    onCheckedChange={(blankNumbered) =>
                      onDraftChange({ ...draft, blankNumbered })
                    }
                  />
                </Field>
              </div>

              <Field orientation="horizontal">
                <SettingLabel
                  about={about}
                  hint={t("pageNumbers.smartColorHint")}
                  htmlFor="page-numbers-smart-color"
                >
                  {t("pageNumbers.smartColor")}
                </SettingLabel>
                <Switch
                  checked={draft.smartColor}
                  className="ml-auto"
                  data-testid="page-numbers-smart-color"
                  id="page-numbers-smart-color"
                  onCheckedChange={(smartColor) =>
                    onDraftChange({ ...draft, smartColor })
                  }
                />
              </Field>
            </FieldGroup>
          </div>
        </div>

        <DialogFooter className="mx-0 mb-0 rounded-none border-t px-5 py-4">
          {hasPageNumbers ? (
            <Button
              disabled={isApplying}
              onClick={onRemove}
              type="button"
              variant="destructive"
            >
              <Trash2 data-icon="inline-start" />
              {t("pageNumbers.remove")}
            </Button>
          ) : null}
          <div className="flex flex-1 justify-end gap-2">
            <DialogClose render={<Button disabled={isApplying} variant="outline" />}>
              {t("pageNumbers.cancel")}
            </DialogClose>
            <Button
              data-testid="page-numbers-apply"
              disabled={isApplying || validationError !== null}
              onClick={onApply}
              type="button"
            >
              {hasPageNumbers ? t("pageNumbers.replace") : t("pageNumbers.apply")}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
