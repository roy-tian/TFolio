import type { ReactNode } from "react"

type StatusBarProps = {
  children: ReactNode
  label: string
}

/** Along the bottom of a workspace, in the strip it leaves for the bar
    (`--status-bar-height`), so nothing it covers is a page. */
export function StatusBar({ children, label }: StatusBarProps) {
  return (
    // pb-px evens the content box under the border, as in the title bar: an
    // odd one centres a 28px control on a half pixel, which the WebView rounds
    // per element, fringing it.
    <div
      aria-label={label}
      className="fixed right-0 bottom-0 left-(--sidebar-inset) z-30 flex h-(--status-bar-height) items-center justify-end gap-1 border-t bg-background px-2 pb-px"
      data-slot="status-bar"
      role="group"
    >
      {children}
    </div>
  )
}

/** Splits the bar's groups, like the title bar's divider. */
export function StatusBarDivider() {
  return <div className="mx-0.5 h-4 w-px shrink-0 bg-border" />
}
