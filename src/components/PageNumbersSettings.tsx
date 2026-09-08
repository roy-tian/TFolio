import { Info, Sparkles } from "lucide-react"
import { useId, type ReactNode } from "react"
import { useTranslation } from "react-i18next"

import { PageNumbersPreview } from "@/components/PageNumbersPreview"
import { ToolbarTooltip } from "@/components/ToolbarTooltip"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group"
import {
  clampPageNumbersStart,
  draftFirstPrinted,
  draftPlacement,
  draftWithPlacement,
  isPlacement,
  maxPageNumbersStart,
  type PageNumbersDraft,
  type PageNumbersValidationError,
} from "@/lib/pageNumbers"
import { cn } from "@/lib/utils"

/**
 * The disclosure marker for the one setting that decides something for itself:
 * a spark drawn in a gradient, so a reader picks it out from the plain `Info`
 * marks around it before reading a word.
 *
 * The gradient is defined inside this very icon, under a hook-generated id, so
 * two panels on screen at once (the dialog and the wizard's step) cannot end up
 * sharing — or fighting over — one definition. `userSpaceOnUse` spans the whole
 * 24-unit viewBox rather than each path's own box, so the sweep runs across the
 * mark instead of restarting inside every stroke.
 */
function SmartIcon() {
  const gradientId = useId()

  return (
    <Sparkles style={{ stroke: `url(#${gradientId})` }}>
      <defs>
        <linearGradient
          gradientUnits="userSpaceOnUse"
          id={gradientId}
          x1="2"
          x2="22"
          y1="2"
          y2="22"
        >
          <stop offset="0%" stopColor="#6366f1" />
          <stop offset="50%" stopColor="#ec4899" />
          <stop offset="100%" stopColor="#f59e0b" />
        </linearGradient>
      </defs>
    </Sparkles>
  )
}

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
  /** Whether this setting decides something for itself, which its marker says
      before its name does. */
  smart?: boolean
}

/**
 * A control's name with its explanation folded into a disclosure beside it, so
 * a panel of eight settings stays a handful of rows tall. Only what a reader
 * has to act on — the errors below — is left on the surface.
 */
function SettingLabel({
  about,
  children,
  hint,
  htmlFor,
  id,
  note,
  smart = false,
}: SettingLabelProps) {
  return (
    <div className="flex h-6 min-w-0 items-center gap-0.5">
      <FieldLabel className="min-w-0" htmlFor={htmlFor} id={id}>
        {children}
      </FieldLabel>
      {hint ? (
        <Popover>
          <ToolbarTooltip label={about} side="top">
            <PopoverTrigger
              render={<Button aria-label={about} size="icon-xs" variant="ghost" />}
            >
              {smart ? <SmartIcon /> : <Info />}
            </PopoverTrigger>
          </ToolbarTooltip>
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

type PageNumbersSettingsProps = {
  className?: string
  draft: PageNumbersDraft
  /** Prefix for the field ids, so two of these can share a page. */
  idPrefix?: string
  onDraftChange: (draft: PageNumbersDraft) => void
  /** The pages the numbers are read against — the open document's, or, in the
      wizard, what the merge is about to produce. */
  pageCount: number
  validationError: PageNumbersValidationError | null
}

/**
 * The page numbers' own controls, beside a preview of the sheet they describe.
 * Shared by the dialog that applies them to an open document and by the merge
 * wizard's third step, so the two can never drift apart.
 *
 * Grouped by what a reader decides together: how it prints, which pages it
 * covers, and then the plain yes/no answers as one list of boxes.
 */
export function PageNumbersSettings({
  className,
  draft,
  idPrefix = "page-numbers",
  onDraftChange,
  pageCount,
  validationError,
}: PageNumbersSettingsProps) {
  const { t } = useTranslation()
  const about = t("pageNumbers.about")
  const maxStart = maxPageNumbersStart(pageCount)
  const positionId = `${idPrefix}-position-label`
  const fromId = `${idPrefix}-from`
  const startId = `${idPrefix}-start`
  const blankCountedId = `${idPrefix}-blank-counted`
  const blankNumberedId = `${idPrefix}-blank-numbered`
  const smartColorId = `${idPrefix}-smart-color`

  return (
    // The columns keep their natural heights, so short content never earns a
    // scrollbar of its own; from `sm` the sheet sticks so it stays in view
    // while the controls pass it.
    <div className={cn("flex flex-col gap-5 sm:flex-row", className)}>
      <Field className="sm:sticky sm:top-0 sm:w-[12rem] sm:shrink-0 sm:self-start">
        <FieldLabel>{t("pageNumbers.preview")}</FieldLabel>
        <PageNumbersPreview
          captions={{
            even: t("pageNumbers.previewEven"),
            every: t("pageNumbers.previewEvery"),
            odd: t("pageNumbers.previewOdd"),
          }}
          placement={draftPlacement(draft)}
          printed={draftFirstPrinted(draft)}
        />
      </Field>

      <div className="min-w-0 flex-1">
        <FieldGroup>
          {/* One choice, not two: single-sided printing is the two fixed
              places, and double-sided is what `auto` means, so asking for the
              printing separately only offered a position it then took away. */}
          <Field>
            <SettingLabel
              about={about}
              hint={t("pageNumbers.positionHint")}
              id={positionId}
            >
              {t("pageNumbers.position")}
            </SettingLabel>
            <ToggleGroup
              aria-labelledby={positionId}
              onValueChange={([value]) => {
                if (value && isPlacement(value)) {
                  onDraftChange(draftWithPlacement(draft, value))
                }
              }}
              size="sm"
              spacing={0}
              value={[draftPlacement(draft)]}
              variant="outline"
            >
              <ToggleGroupItem value="bottomCenter">
                {t("pageNumbers.positionBottomCenter")}
              </ToggleGroupItem>
              <ToggleGroupItem value="bottomRight">
                {t("pageNumbers.positionBottomRight")}
              </ToggleGroupItem>
              <ToggleGroupItem value="auto">
                {t("pageNumbers.positionAuto")}
              </ToggleGroupItem>
            </ToggleGroup>
          </Field>

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
                htmlFor={fromId}
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
                  id={fromId}
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
                htmlFor={startId}
              >
                {t("pageNumbers.start")}
              </SettingLabel>
              <Input
                aria-invalid={validationError === "start"}
                data-testid="page-numbers-start"
                id={startId}
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

          {/* Three plain yes/no answers, as a list of boxes down the left rather
              than switches floating at the right edge: the marks line up under
              one another, and a long name no longer strands its control halfway
              across the panel. */}
          <div className="flex flex-col gap-3">
            <Field orientation="horizontal">
              <Checkbox
                checked={draft.smartColor}
                data-testid="page-numbers-smart-color"
                id={smartColorId}
                onCheckedChange={(smartColor) =>
                  onDraftChange({ ...draft, smartColor })
                }
              />
              <SettingLabel
                about={about}
                hint={t("pageNumbers.smartColorHint")}
                htmlFor={smartColorId}
                smart
              >
                {t("pageNumbers.smartColor")}
              </SettingLabel>
            </Field>

            <Field orientation="horizontal">
              <Checkbox
                checked={draft.blankCounted}
                data-testid="page-numbers-blank-counted"
                id={blankCountedId}
                onCheckedChange={(blankCounted) =>
                  onDraftChange({ ...draft, blankCounted })
                }
              />
              <SettingLabel
                about={about}
                hint={t("pageNumbers.blankCountedHint")}
                htmlFor={blankCountedId}
              >
                {t("pageNumbers.blankCounted")}
              </SettingLabel>
            </Field>

            {/* Last, so the indent has nothing after it to look misaligned
                against: a page that takes no number has none to print, so this
                one follows the box above rather than standing against it. */}
            <Field
              className="pl-6"
              data-disabled={!draft.blankCounted}
              orientation="horizontal"
            >
              <Checkbox
                checked={draft.blankCounted && draft.blankNumbered}
                data-testid="page-numbers-blank-numbered"
                disabled={!draft.blankCounted}
                id={blankNumberedId}
                onCheckedChange={(blankNumbered) =>
                  onDraftChange({ ...draft, blankNumbered })
                }
              />
              <SettingLabel
                about={about}
                hint={t("pageNumbers.blankNumberedHint")}
                htmlFor={blankNumberedId}
              >
                {t("pageNumbers.blankNumbered")}
              </SettingLabel>
            </Field>
          </div>
        </FieldGroup>
      </div>
    </div>
  )
}
