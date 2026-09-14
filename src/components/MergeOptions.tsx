import type { ReactNode } from "react"
import { Bookmark, Hash, Stamp, TriangleAlert, type LucideIcon } from "lucide-react"
import { useTranslation } from "react-i18next"

import { Card } from "@/components/ui/card"
import { Checkbox } from "@/components/ui/checkbox"
import { Field, FieldLabel } from "@/components/ui/field"
import { Separator } from "@/components/ui/separator"
import { Switch } from "@/components/ui/switch"
import type { useMergeWizard } from "@/hooks/useMergeWizard"
import { cn } from "@/lib/utils"

type MergeOptionProps = {
  id: string
  title: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
  children?: ReactNode
}

function MergeOption({
  id,
  title,
  checked,
  disabled,
  onChange,
  children,
}: MergeOptionProps) {
  return (
    <Card
      className={cn(
        "shrink-0 gap-0 p-0",
        checked && "ring-primary/30 bg-primary/5",
      )}
    >
      <FieldLabel
        className={cn("w-full items-start p-2.5 has-data-checked:bg-transparent dark:has-data-checked:bg-transparent", !disabled && "cursor-pointer")}
        htmlFor={id}
      >
        <Checkbox
          className="mt-0.5"
          checked={checked}
          data-testid={id}
          disabled={disabled}
          id={id}
          onCheckedChange={onChange}
        />
        <span className={cn("text-sm", disabled && "text-muted-foreground")}>
          {title}
        </span>
      </FieldLabel>
      {children ? (
        <div className="px-2.5 pb-2.5 text-xs text-muted-foreground">{children}</div>
      ) : null}
    </Card>
  )
}

function MergeFeatureSwitch({
  id,
  title,
  icon: Icon,
  checked,
  disabled,
  onChange,
  children,
}: MergeOptionProps & { icon: LucideIcon }) {
  return (
    <Card
      className={cn(
        "shrink-0 gap-0 p-0",
        checked && "ring-primary/30 bg-primary/5",
      )}
    >
      <Field className="p-2.5" data-disabled={disabled} orientation="horizontal">
        <FieldLabel className={cn(!disabled && "cursor-pointer")} htmlFor={id}>
          <Icon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
          {title}
        </FieldLabel>
        <Switch
          checked={checked}
          data-testid={id}
          disabled={disabled}
          id={id}
          onCheckedChange={onChange}
        />
      </Field>
      {children ? (
        <div className="px-2.5 pb-2.5 text-xs text-muted-foreground">{children}</div>
      ) : null}
    </Card>
  )
}

export function MergeOptions({ wizard }: {
  wizard: ReturnType<typeof useMergeWizard>
}) {
  const { t } = useTranslation()
  const {
    isBusy,
    pageSizeStatus,
    paddingNeeded,
    normalizeA4,
    setNormalizeA4,
    smartPadding,
    setSmartPadding,
    bookmarksOn,
    setBookmarksOn,
    pageNumbersOn,
    setPageNumbersOn,
    watermarkOn,
    setWatermarkOn,
  } = wizard
  const empty = pageSizeStatus === "empty"
  const a4Disabled = isBusy || empty || pageSizeStatus === "allA4"
  const a4Hint = isBusy
    ? t("mergeWizard.checkingFiles")
    : empty
      ? t("mergeWizard.optionsNeedFiles")
      : pageSizeStatus === "allA4"
        ? t("mergeWizard.alreadyA4")
        : pageSizeStatus === "unknown"
          ? t("mergeWizard.a4Unknown")
          : t("mergeWizard.normalizeA4Hint")
  const paddingHint = isBusy
    ? t("mergeWizard.checkingFiles")
    : empty
      ? t("mergeWizard.optionsNeedFiles")
      : paddingNeeded === 0
        ? t("mergeWizard.alreadyOddStarts")
        : t("mergeWizard.paddingNeeded", { count: paddingNeeded })

  return (
    <div className="flex min-h-0 flex-col gap-2 p-px sm:overflow-y-auto sm:pr-2">
      <MergeOption
        id="merge-wizard-a4"
        title={t("mergeWizard.normalizeA4")}
        checked={normalizeA4}
        disabled={a4Disabled}
        onChange={setNormalizeA4}
      >
        {a4Hint}
        {normalizeA4 ? (
          <p
            className="mt-2 flex items-start gap-1.5 text-warning"
            data-testid="merge-wizard-a4-warning"
          >
            <TriangleAlert className="mt-px size-3.5 shrink-0" />
            <span>{t("mergeWizard.normalizeA4Warning")}</span>
          </p>
        ) : null}
      </MergeOption>
      <MergeOption
        id="merge-wizard-padding"
        title={t("mergeWizard.smartPadding")}
        checked={smartPadding}
        disabled={isBusy || paddingNeeded === 0}
        onChange={setSmartPadding}
      >
        {paddingHint}
      </MergeOption>
      <Separator className="my-1" />
      <MergeFeatureSwitch
        icon={Bookmark}
        id="merge-wizard-bookmarks"
        title={t("mergeWizard.bookmarksEnable")}
        checked={bookmarksOn}
        disabled={isBusy}
        onChange={setBookmarksOn}
      >
        {!bookmarksOn ? t("mergeWizard.bookmarksDisabledHint") : null}
      </MergeFeatureSwitch>
      <MergeFeatureSwitch
        icon={Hash}
        id="merge-wizard-page-numbers"
        title={t("mergeWizard.pageNumbersEnable")}
        checked={pageNumbersOn}
        disabled={isBusy}
        onChange={setPageNumbersOn}
      />
      <MergeFeatureSwitch
        icon={Stamp}
        id="merge-wizard-watermark"
        title={t("mergeWizard.watermarkEnable")}
        checked={watermarkOn}
        disabled={isBusy}
        onChange={setWatermarkOn}
      />
    </div>
  )
}
