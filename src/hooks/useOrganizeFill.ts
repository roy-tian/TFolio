import { useCallback, useRef, useState, type RefObject } from "react"

import type { DocumentSessionHandle } from "@/components/DocumentSession"
import type { OrganizeWorkspace } from "@/hooks/useOrganizeWorkspace"
import type { WorkspaceMode } from "@/hooks/useWorkspaceMode"

/** What a fill needs of a viewer tab. A converted tab has no file of its own
    until saved, but organize reads the image or Word document it came from. */
export type FillTab = {
  convertedFrom?: string
  /** What the session last reported; a save's revision follows its clearing. */
  dirty: boolean
  id: number
  name: string
  path: string
}

export type FillPrompt = { canSave: boolean; kind: "unsaved"; name: string }

/** null is every way out: Esc, and the switch's "Don't add". */
export type FillAnswer = "save" | "saved" | null

type UseOrganizeFillOptions = {
  /** The tab the viewer shows; null on the home tab. */
  activeTab: () => FillTab | null
  findTab: (id: number) => FillTab | null
  modeRef: RefObject<WorkspaceMode>
  organize: RefObject<OrganizeWorkspace>
  /** Moves on whenever the tab's file may have been rewritten, so a fill read
      before then is read again. */
  revision: (id: number) => number
  session: (id: number) => DocumentSessionHandle | undefined
  setMode: (mode: WorkspaceMode) => void
}

function fileOf(tab: FillTab, revision: number) {
  const path = tab.path || tab.convertedFrom

  return path ? { key: `${tab.id}:${revision}:${path}`, path } : null
}

/** A fill the reader chose over the tab's unsaved changes: only that choice
    lets a later switch with changes still unsaved skip the question. */
function savedVersionKey(key: string) {
  return `${key}:saved`
}

/**
 * Brings the viewer's file into the organize workspace: an untouched workspace
 * follows the tab shown when the reader switches to it, and files dropped on
 * the sidebar's pages start it over with that tab's file. Organize reads files
 * on disk, so a tab's unsaved changes are settled first.
 */
export function useOrganizeFill({
  activeTab,
  findTab,
  modeRef,
  organize,
  revision,
  session,
  setMode,
}: UseOrganizeFillOptions) {
  // Kept after an answer, so the prompt keeps its words while it fades out.
  const [prompt, setPrompt] = useState<FillPrompt | null>(null)
  const [promptOpen, setPromptOpen] = useState(false)
  const resolveRef = useRef<((answer: FillAnswer) => void) | null>(null)
  // One fill at a time: a switch or drop while another asks or saves is ignored.
  const runningRef = useRef(false)

  const ask = useCallback(
    (next: FillPrompt) =>
      new Promise<FillAnswer>((resolve) => {
        resolveRef.current = resolve
        setPrompt(next)
        setPromptOpen(true)
      }),
    [],
  )

  const answer = useCallback((value: FillAnswer) => {
    const resolve = resolveRef.current

    resolveRef.current = null
    setPromptOpen(false)
    resolve?.(value)
  }, [])

  /** The file to read once the tab's unsaved changes are settled, or why
      there is none: the reader left the file out, or its save did not go
      through and the viewer stays. */
  const settle = useCallback(
    async (
      tab: FillTab,
      file: { key: string; path: string },
    ): Promise<{ key: string; path: string } | "skipped" | "stayed"> => {
      const handle = session(tab.id)

      if (!handle?.hasUnsavedChangesNow()) {
        return file
      }

      const choice = await ask({
        canSave: !handle.isCopyOnlyNow(),
        kind: "unsaved",
        name: tab.name,
      })

      if (choice === "saved") {
        return { key: savedVersionKey(file.key), path: file.path }
      }

      if (choice !== "save") {
        return "skipped"
      }

      if (!(await handle.saveForClose())) {
        return "stayed"
      }

      // Save As may have given a converted tab its first file. The save
      // moves the revision on once the session reports the tab clean, which
      // a tab still marked dirty has yet to do; a wrong guess costs a read.
      const saved = findTab(tab.id)
      const next = saved && fileOf(saved, revision(tab.id) + (saved.dirty ? 1 : 0))

      return next ?? "stayed"
    },
    [ask, findTab, revision, session],
  )

  const enterOrganize = useCallback(async () => {
    const workspace = organize.current

    if (modeRef.current === "organize" || runningRef.current) {
      return
    }

    const tab = activeTab()
    const file = tab ? fileOf(tab, revision(tab.id)) : null
    const shownKey =
      file && tab && session(tab.id)?.hasUnsavedChangesNow()
        ? savedVersionKey(file.key)
        : file?.key

    // A busy workspace would refuse the fill after the reader answered for it.
    if (
      workspace.isBusyNow() ||
      !workspace.isUntouchedNow() ||
      workspace.filledKeyNow() === shownKey
    ) {
      setMode("organize")
      return
    }

    if (!tab || !file) {
      workspace.clearUntouched()
      setMode("organize")
      return
    }

    runningRef.current = true
    let settled: Awaited<ReturnType<typeof settle>>

    try {
      settled = await settle(tab, file)
    } finally {
      // Released before the read, which may take minutes for a Word document:
      // the workspace's own busy state guards it, and a switch back to the
      // viewer and here again must not be swallowed meanwhile.
      runningRef.current = false
    }

    if (settled === "stayed") {
      return
    }

    // What another tab's fill left must not stand in for this one's file.
    organize.current.clearUntouched()
    setMode("organize")

    if (settled !== "skipped") {
      await organize.current.fill(settled.path, settled.key)
    }
  }, [activeTab, modeRef, organize, revision, session, settle, setMode])

  return { answer, enterOrganize, prompt, promptOpen }
}
