import { Trash2 } from "lucide-react"
import { useTranslation } from "react-i18next"

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
import { Switch } from "@/components/ui/switch"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  isMode,
  isPosition,
  pageNumbersLabel,
  type PageNumbersDraft,
  type PageNumbersValidationError,
} from "@/lib/pageNumbers"

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

  return (
    <Dialog onOpenChange={onOpenChange} open={open}>
      <DialogContent
        className="flex max-h-[calc(100svh-2rem)] w-[30rem] flex-col gap-0 overflow-hidden p-0 sm:max-w-[30rem]"
        data-testid="page-numbers-dialog"
      >
        <DialogHeader className="border-b px-5 py-4">
          <DialogTitle>{t("pageNumbers.title")}</DialogTitle>
          <DialogDescription>{t("pageNumbers.description")}</DialogDescription>
        </DialogHeader>

        <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5">
          {/* A static serif sample of the format; the placement itself is a
              simple margin rule, not worth a second copy of the layout maths. */}
          <div
            className="flex h-16 items-end justify-center rounded-md border bg-muted/40 pb-3"
            data-testid="page-numbers-sample"
          >
            <span className="font-serif text-sm text-foreground">
              {pageNumbersLabel(1)}
            </span>
          </div>

          <FieldGroup>
            <Field>
              <FieldLabel id="page-numbers-mode-label">
                {t("pageNumbers.mode")}
              </FieldLabel>
              <ToggleGroup
                aria-labelledby="page-numbers-mode-label"
                onValueChange={([value]) => {
                  if (value && isMode(value)) {
                    onDraftChange({ ...draft, mode: value })
                  }
                }}
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

            {draft.mode === "single" ? (
              <Field>
                <FieldLabel id="page-numbers-position-label">
                  {t("pageNumbers.position")}
                </FieldLabel>
                <ToggleGroup
                  aria-labelledby="page-numbers-position-label"
                  onValueChange={([value]) => {
                    if (value && isPosition(value)) {
                      onDraftChange({ ...draft, position: value })
                    }
                  }}
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
            ) : (
              <p className="text-xs text-muted-foreground">
                {t("pageNumbers.duplexHint")}
              </p>
            )}

            <Field data-invalid={validationError === "range"}>
              <div className="flex items-center justify-between gap-2">
                <FieldLabel htmlFor="page-numbers-all">
                  {t("pageNumbers.rangeAll")}
                </FieldLabel>
                <Switch
                  checked={draft.allPages}
                  data-testid="page-numbers-all"
                  id="page-numbers-all"
                  onCheckedChange={(allPages) =>
                    onDraftChange({ ...draft, allPages })
                  }
                />
              </div>
              {!draft.allPages ? (
                <div className="grid grid-cols-2 gap-3">
                  <Input
                    aria-invalid={validationError === "range"}
                    aria-label={t("pageNumbers.rangeFrom")}
                    data-testid="page-numbers-from"
                    inputMode="numeric"
                    max={pageCount}
                    min={1}
                    onChange={(event) =>
                      onDraftChange({ ...draft, rangeFrom: event.target.value })
                    }
                    placeholder={t("pageNumbers.rangeFrom")}
                    type="number"
                    value={draft.rangeFrom}
                  />
                  <Input
                    aria-invalid={validationError === "range"}
                    aria-label={t("pageNumbers.rangeTo")}
                    data-testid="page-numbers-to"
                    inputMode="numeric"
                    max={pageCount}
                    min={1}
                    onChange={(event) =>
                      onDraftChange({ ...draft, rangeTo: event.target.value })
                    }
                    placeholder={t("pageNumbers.rangeTo")}
                    type="number"
                    value={draft.rangeTo}
                  />
                </div>
              ) : null}
              {validationError === "range" ? (
                <FieldError>
                  {t("pageNumbers.errorRange", { max: pageCount })}
                </FieldError>
              ) : null}
            </Field>

            <Field data-invalid={validationError === "start"}>
              <FieldLabel htmlFor="page-numbers-start">
                {t("pageNumbers.start")}
              </FieldLabel>
              <Input
                aria-invalid={validationError === "start"}
                data-testid="page-numbers-start"
                id="page-numbers-start"
                inputMode="numeric"
                min={1}
                onChange={(event) =>
                  onDraftChange({ ...draft, start: event.target.value })
                }
                placeholder={t("pageNumbers.startPlaceholder")}
                type="number"
                value={draft.start}
              />
              {validationError === "start" ? (
                <FieldError>{t("pageNumbers.errorStart")}</FieldError>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {t("pageNumbers.startHint")}
                </p>
              )}
            </Field>

            <Field>
              <div className="flex items-center justify-between gap-2">
                <FieldLabel htmlFor="page-numbers-smart-color">
                  {t("pageNumbers.smartColor")}
                </FieldLabel>
                <Switch
                  checked={draft.smartColor}
                  data-testid="page-numbers-smart-color"
                  id="page-numbers-smart-color"
                  onCheckedChange={(smartColor) =>
                    onDraftChange({ ...draft, smartColor })
                  }
                />
              </div>
              <p className="text-xs text-muted-foreground">
                {t("pageNumbers.smartColorHint")}
              </p>
            </Field>
          </FieldGroup>
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
