import type { ReactNode } from "react"

import { useSidebarDrop } from "@/hooks/useSidebarDrop"
import { cn } from "@/lib/utils"

/** While a file drag offers the sidebar, what a drop there does, said in the
    bar over its panel in place of the bar's own controls: there it covers
    none of what the panel shows. The bar must be `relative`. */
export function SidebarDropHint({ label }: { label: string }) {
  const drop = useSidebarDrop()

  if (!drop) {
    return null
  }

  return (
    <p
      className={cn(
        "pointer-events-none absolute inset-0 grid place-items-center px-2 text-xs font-medium",
        drop === "over" ? "text-foreground" : "text-muted-foreground",
      )}
      data-slot="sidebar-drop-hint"
    >
      <span className="max-w-full truncate">{label}</span>
    </p>
  )
}

/** While a file drag offers the sidebar, an edge around what its panel shows,
    drawn in a `relative` box; it holds what marks where the files would go. */
export function SidebarDropEdge({ children }: { children?: ReactNode }) {
  const drop = useSidebarDrop()

  if (!drop) {
    return null
  }

  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-1 z-10 rounded-xl border-2 border-dashed",
        drop === "over" ? "border-primary/70" : "border-muted-foreground/40",
      )}
      data-over={drop === "over" ? "" : undefined}
      data-testid="sidebar-drop"
    >
      {children}
    </div>
  )
}
