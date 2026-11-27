import { useEffect, useRef } from "react"

import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

/** A file's name, typed in place: Enter or leaving keeps it, Esc does not. */
export function FileTitleEditor({
  className,
  label,
  onDone,
  slot = "file-section-title-input",
  title,
}: {
  className?: string
  label: string
  onDone: (title: string | null) => void
  slot?: string
  title: string
}) {
  const settledRef = useRef(false)
  useEffect(() => {
    settledRef.current = false
    return () => {
      settledRef.current = true
    }
  }, [])
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
      data-slot={slot}
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
