import { useTranslation } from "react-i18next"

import { PageOdometer } from "@/components/PageOdometer"
import { cn } from "@/lib/utils"

type PageNumberFieldProps = {
  currentPage: number
  disabled: boolean
  focused: boolean
  onFocusedChange: (focused: boolean) => void
  onInput: (value: string) => void
  onSubmit: () => void
  value: string
}

/** The page-number field, with the odometer drawn over its transparent text. */
export function PageNumberField({
  currentPage,
  disabled,
  focused,
  onFocusedChange,
  onInput,
  onSubmit,
  value,
}: PageNumberFieldProps) {
  const { t } = useTranslation()

  return (
    <div className="relative">
      <input
        aria-label={t("toolbar.pageNumberInput")}
        className={cn(
          "h-7 w-10 rounded-md border bg-background px-1 text-center font-mono text-sm tabular-nums outline-none transition-colors focus:border-ring focus:ring-2 focus:ring-ring/30 disabled:cursor-default disabled:bg-muted disabled:text-muted-foreground",
          // The field holds the value for typed jumps and screen readers,
          // but the odometer does the drawing, over transparent text.
          !focused && "text-transparent disabled:text-transparent",
        )}
        disabled={disabled}
        inputMode="numeric"
        onBlur={() => {
          onFocusedChange(false)
          onInput(String(currentPage))
        }}
        onChange={(event) => onInput(event.target.value.replaceAll(/[^0-9]/g, ""))}
        onFocus={(event) => {
          onFocusedChange(true)
          event.currentTarget.select()
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            onSubmit()
            event.currentTarget.blur()
          }
        }}
        type="text"
        value={value}
      />
      {/* Deaf to the pointer, so a click lands in the field it covers;
          forced colours un-hide the field's text, so this stands down. */}
      {focused ? null : (
        <PageOdometer
          className={cn(
            "pointer-events-none absolute inset-0 justify-center forced-colors:hidden",
            disabled && "text-muted-foreground",
          )}
          value={currentPage}
        />
      )}
    </div>
  )
}
