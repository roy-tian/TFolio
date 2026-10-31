import { createContext, useContext } from "react"

/** What the window is for right now: reading and marking up one file at a
    time, or putting a new one together from several. */
export type WorkspaceMode = "view" | "organize"

export type WorkspaceModeState = {
  mode: WorkspaceMode
  setMode: (mode: WorkspaceMode) => void
}

export const WorkspaceModeContext = createContext<WorkspaceModeState | null>(null)

export function useWorkspaceMode() {
  return useContext(WorkspaceModeContext)
}
