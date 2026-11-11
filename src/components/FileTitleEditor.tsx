import { useRef } from "react"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/** A file's name, typed in place: Enter or leaving keeps it, Esc does not. */
export function FileTitleEditor({
  className,
  label,
  onDone,
  title,
}: {
  className?: string
  label: string
  onDone: (title: string | null) => void
  title: string
}) {
  const settledRef = useRef(false)
  const settle = (value: string | null) => {
    if (!settledRef.current) {
      settledRef.current = true
      onDone(value)
    }
  }

  return (
    <Input
      aria-label={label}
      autoFocus
      className={cn("h-7 flex-1 px-1.5", className)}
      data-slot="file-section-title-input"
      defaultValue={title}
      onBlur={(event) => settle(event.currentTarget.value)}
      onFocus={(event) => event.currentTarget.select()}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault()
          settle(event.currentTarget.value)
        } else if (event.key === "Escape") {
          event.preventDefault()
          event.stopPropagation()
          settle(null)
        }
      }}
    />
  )
}
