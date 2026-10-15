import { useLayoutEffect, useRef, useState } from "react"
import { useTranslation } from "react-i18next"

import { PageOdometer } from "@/components/PageOdometer"
import { cn } from "@/lib/utils"

type PageNumberFieldProps = {
  currentPage: number
  disabled: boolean
  /** Takes the typed text as it stands; a jump is the session's to clamp. */
  onSubmit: (value: string) => void
}

/** The page-number field, with the odometer drawn over its transparent text. */
export function PageNumberField({
  currentPage,
  disabled,
  onSubmit,
}: PageNumberFieldProps) {
  const { t } = useTranslation()
  const inputRef = useRef<HTMLInputElement>(null)
  // A press that focuses the field: its release would put the caret where it
  // landed, undoing the selection focusing made.
  const pressFocusing = useRef(false)
  const [focused, setFocused] = useState(false)
  // Typed text, once there is any: until then a focused field still follows
  // the scroll, and what the reader types must not be overwritten by it.
  const [draft, setDraft] = useState<string | null>(null)

  // Setting the value drops the selection focusing made, so typing would
  // append to the new number instead of replacing it.
  useLayoutEffect(() => {
    if (focused && draft === null) {
      inputRef.current?.select()
    }
  }, [currentPage, draft, focused])

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
          setFocused(false)
          setDraft(null)
        }}
        onChange={(event) => setDraft(event.target.value.replaceAll(/[^0-9]/g, ""))}
        onFocus={(event) => {
          setFocused(true)
          event.currentTarget.select()
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault()
            onSubmit(draft ?? String(currentPage))
            event.currentTarget.blur()
          }
        }}
        onMouseDown={(event) => {
          pressFocusing.current = document.activeElement !== event.currentTarget
        }}
        onMouseUp={(event) => {
          const input = event.currentTarget

          // A drag across the digits keeps the stretch it chose.
          if (
            pressFocusing.current &&
            input.selectionStart === 0 &&
            input.selectionEnd === input.value.length
          ) {
            event.preventDefault()
          }

          pressFocusing.current = false
        }}
        ref={inputRef}
        type="text"
        value={draft ?? String(currentPage)}
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
