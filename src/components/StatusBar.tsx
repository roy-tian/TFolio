import type { ReactNode } from "react"

type StatusBarProps = {
  /** The controls on the right. */
  children: ReactNode
  /** Names the controls on the right. */
  label: string
  /** Where the reader is, on the left. */
  start?: ReactNode
}

/** Along the bottom of a workspace, in the strip it leaves for the bar
    (`--status-bar-height`), so nothing it covers is a page. */
export function StatusBar({ children, label, start }: StatusBarProps) {
  return (
    // pb-px evens the content box under the border, as in the title bar: an
    // odd one centres a 28px control on a half pixel, which the WebView rounds
    // per element, fringing it.
    <div
      className="fixed right-0 bottom-0 left-(--sidebar-inset) z-30 flex h-(--status-bar-height) items-center justify-between gap-2 border-t bg-background px-2 pb-px"
      data-slot="status-bar"
    >
      <div className="flex min-w-0 items-center gap-1">{start}</div>
      <div aria-label={label} className="flex shrink-0 items-center gap-1" role="group">
        {children}
      </div>
    </div>
  )
}

/** Splits the bar's groups, like the title bar's divider. */
export function StatusBarDivider() {
  return <div className="mx-0.5 h-4 w-px shrink-0 bg-border" />
}
