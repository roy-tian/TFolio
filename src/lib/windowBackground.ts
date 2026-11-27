import { invoke } from "@tauri-apps/api/core"

import { isMacOS, isWindows } from "@/lib/platform"
import type { ResolvedTheme } from "@/lib/theme"

export type WorkspaceMaterial = "glass" | "mica"

export function isWorkspaceMaterial(value: unknown): value is WorkspaceMaterial {
  return value === "glass" || value === "mica"
}

export function applyWorkspaceMaterial(root: HTMLElement, material: WorkspaceMaterial | null) {
  root.classList.toggle("native-workspace", material !== null)

  if (material) {
    root.dataset.nativeMaterial = material
  } else {
    delete root.dataset.nativeMaterial
  }
}

export async function applyWindowBackground(theme: ResolvedTheme, followSystem: boolean) {
  if (!isMacOS() && !isWindows()) return

  let material: WorkspaceMaterial | null = null

  try {
    const result = await invoke<unknown>("set_workspace_background", {
      dark: theme === "dark",
      followSystem,
    })

    if (isWorkspaceMaterial(result)) {
      material = result
    }
  } catch (error) {
    console.warn("Native workspace background unavailable:", error)
  }

  applyWorkspaceMaterial(document.documentElement, material)
}
