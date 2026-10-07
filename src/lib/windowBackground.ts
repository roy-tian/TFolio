import { invoke } from "@tauri-apps/api/core"

import { isMacOS, isWindows } from "@/lib/platform"
import type { ResolvedTheme } from "@/lib/theme"

export async function applyWindowBackground(theme: ResolvedTheme, followSystem: boolean) {
  if (!isMacOS() && !isWindows()) return

  let supported = false

  try {
    supported = await invoke<boolean>("set_workspace_background", {
      dark: theme === "dark",
      followSystem,
    })
  } catch (error) {
    console.warn("Native workspace background unavailable:", error)
  }

  document.documentElement.classList.toggle("native-workspace", supported)
}
