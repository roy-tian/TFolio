import { useState } from "react"
import type { Menu } from "@base-ui/react/menu"

import {
  nativeMenuPointBelow,
  popupNativeContextMenu,
  type NativeContextMenuItem,
} from "@/lib/nativeMenu"
import { isMacOS } from "@/lib/platform"

export type NativeDropdown = {
  /** The entries, and what a chosen one does, read as the menu opens. */
  choose: (id: string) => void
  items: NativeContextMenuItem[]
}

/**
 * Pops a `DropdownMenu` up as AppKit's own menu under its trigger on macOS,
 * as the context menus are; elsewhere, and once a native popup has failed,
 * the WebView's menu opens. Spread the result on the `DropdownMenu`.
 */
export function useNativeDropdown(menu: () => NativeDropdown) {
  const [fallback, setFallback] = useState(false)
  const [open, setOpen] = useState(false)

  const onOpenChange = (next: boolean, details: Menu.Root.ChangeEventDetails) => {
    if (!next || !isMacOS() || fallback) {
      setOpen(next)
      return
    }

    details.cancel()
    const { choose, items } = menu()
    const at = details.trigger ? nativeMenuPointBelow(details.trigger) : undefined

    void popupNativeContextMenu(items, at)
      .then((chosen) => {
        if (chosen) {
          choose(chosen)
        }
      })
      .catch((error: unknown) => {
        console.warn("Native dropdown menu failed:", error)
        setFallback(true)
        setOpen(true)
      })
  }

  return { onOpenChange, open }
}
