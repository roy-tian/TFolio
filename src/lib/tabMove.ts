import { invoke } from "@tauri-apps/api/core"
import { getAllWindows } from "@tauri-apps/api/window"

import type { AnnotationHistory } from "@/lib/annotations"
import { parseRecentPdfView, type RecentPdfView } from "@/lib/recentFiles"
import type { PdfDocumentInfo } from "@/lib/pdf"
import { isViewMode, type ViewMode } from "@/lib/viewMode"

/** A window the drag can land on, in physical pixels — the space every
    window's position and size answer in, whatever its monitor's scale. */
export type WindowRect = {
  /** The window holding keyboard focus, if this rect is it: among overlapping
      windows, that one is the reader's aimed-at surface. */
  focused?: boolean
  height: number
  label: string
  width: number
  x: number
  y: number
}

/** Viewport CSS pixels to the screen's physical ones, so one point answers
    against every window's rect in the same space. */
export function globalPointFrom(
  client: { x: number; y: number },
  viewportOrigin: { x: number; y: number },
  scaleFactor: number,
): { x: number; y: number } {
  return {
    x: viewportOrigin.x + client.x * scaleFactor,
    y: viewportOrigin.y + client.y * scaleFactor,
  }
}

/** Where a label stands in creation order: windows are named as they are
 * made, so the highest number is the newest face on the screen. */
function creationRank(label: string): number {
  return Number(/^window-(\d+)$/.exec(label)?.[1] ?? 0)
}

/** The window the point is over, if any: a drag released there moves in —
    unless it is the dragging window itself (`selfLabel`), whose own body is a
    tear-off, not a landing place. Overlapping windows resolve to a focused
    one other than the dragger (whose focus says nothing about stacking), and
    otherwise to the newest face on the screen — `getAllWindows` answers in
    hash order, which stacking does not follow, so first-match would land the
    tab in whatever hashed first. */
export function windowAtPoint(
  point: { x: number; y: number },
  rects: WindowRect[],
  selfLabel?: string,
): WindowRect | null {
  const containing = rects.filter(
    (rect) =>
      point.x >= rect.x &&
      point.x < rect.x + rect.width &&
      point.y >= rect.y &&
      point.y < rect.y + rect.height,
  )

  if (containing.length === 0) {
    return null
  }

  const focused = containing.find(
    (rect) => rect.focused && rect.label !== selfLabel,
  )

  if (focused) {
    return focused
  }

  return containing.reduce((oldest, newest) =>
    creationRank(newest.label) > creationRank(oldest.label) ? newest : oldest,
  )
}

/** Every window on its feet, the dragging one included: deciding whether a
    release lands in another window or tears off needs the dragger's own rect
    too — a cascaded window's body mostly covers an older one behind it. */
export async function fetchWindowRects(): Promise<WindowRect[]> {
  const windows = await getAllWindows()

  const described = await Promise.all(
    windows.map(async (window) => {
      const [minimized, position, size, focused] = await Promise.all([
        window.isMinimized(),
        window.outerPosition(),
        window.outerSize(),
        window.isFocused(),
      ])

      return {
        focused,
        height: size.height,
        label: window.label,
        minimized,
        width: size.width,
        x: position.x,
        y: position.y,
      }
    }),
  )

  // A minimized one is not a place a reader can see the tab go.
  return described.filter((rect) => !rect.minimized)
}

/** What a moved tab replays in its new window: the undo history and the marks
    it owns are what keep the document's dirty state, its export-only refusals,
    and annotation deletion answering as they did where it came from. */
export type MovedTabSeed = {
  hasMergedPages: boolean
  history: AnnotationHistory
  marks: [entryId: number, markIds: number[]][]
  pageRotations: number[]
  viewMode: ViewMode
}

/** Everything a tab is, beyond its document's engine state: what the strip
    shows, what the session rehydrates from, and where it was being read. */
export type MovedTabPayload = {
  document: PdfDocumentInfo
  dirty: boolean
  name: string
  path: string
  recentPath?: string
  recentView?: RecentPdfView
  saveAsDefaultName?: string
  savable: boolean
  saveRequired: boolean
  seed: MovedTabSeed
}

/** The half of a move only the leaving session can say: the structure it
    holds, the view it is being read in, its seed, and whether the document
    still awaits its first save — or the reason the move must wait, and `null`
    where there is no document behind the tab at all. */
export type MovedSessionSnapshot =
  | { blocked: "busy" | "note" }
  | {
      document: PdfDocumentInfo
      recentView: RecentPdfView | null
      saveRequired: boolean
      seed: MovedTabSeed
    }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isMarks(value: unknown): value is MovedTabSeed["marks"] {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        isNumber(entry[0]) &&
        Array.isArray(entry[1]) &&
        entry[1].every(isNumber),
    )
  )
}

/**
 * The payload crossed the process once through the handoff queue, not the
 * outside world: the checks below guard the journey's shape, not an author —
 * the history's commands travel as they were written, the same trust the
 * session that made them already had.
 */
export function parseMovedTabPayload(value: unknown): MovedTabPayload | null {
  if (!isRecord(value)) {
    return null
  }

  const { document, seed } = value

  if (
    !isRecord(document) ||
    !isNumber(document.id) ||
    !isNumber(document.numPages) ||
    !Array.isArray(document.pages) ||
    !Array.isArray(document.outline) ||
    (typeof document.path !== "string" && document.path !== null)
  ) {
    return null
  }

  if (
    !isRecord(seed) ||
    !isRecord(seed.history) ||
    !Array.isArray(seed.history.past) ||
    !Array.isArray(seed.history.future) ||
    !isNumber(seed.history.nextId) ||
    !isNumber(seed.history.savedId) ||
    typeof seed.hasMergedPages !== "boolean" ||
    !isMarks(seed.marks) ||
    !Array.isArray(seed.pageRotations) ||
    !seed.pageRotations.every(isNumber) ||
    !isViewMode(seed.viewMode)
  ) {
    return null
  }

  if (typeof value.name !== "string" || typeof value.path !== "string") {
    return null
  }

  const payload: MovedTabPayload = {
    document: document as unknown as PdfDocumentInfo,
    dirty: value.dirty === true,
    name: value.name,
    path: value.path,
    saveRequired: value.saveRequired === true,
    savable: value.savable === true,
    seed: {
      hasMergedPages: seed.hasMergedPages,
      history: seed.history as unknown as AnnotationHistory,
      marks: seed.marks,
      pageRotations: seed.pageRotations,
      viewMode: seed.viewMode,
    },
  }

  if (typeof value.recentPath === "string") {
    payload.recentPath = value.recentPath
  }

  if (typeof value.saveAsDefaultName === "string") {
    payload.saveAsDefaultName = value.saveAsDefaultName
  }

  const recentView = parseRecentPdfView(value.recentView)

  if (recentView) {
    payload.recentView = recentView
  }

  return payload
}

/** The move itself: ownership crosses in Rust before the tab leaves its old
    window, so nothing reopens the file in between. */
export async function moveTabToWindow(
  documentId: number,
  destLabel: string,
  tab: MovedTabPayload,
): Promise<void> {
  await invoke("move_document", {
    documentId,
    destLabel,
    tab,
  })
}

/** A torn-off tab: the new window opens where the reader let it go, or — with
    no point to place it — cascades from the window it left. */
export async function moveTabToNewWindow(
  documentId: number,
  tab: MovedTabPayload,
  at: { x: number; y: number } | null,
): Promise<void> {
  await invoke("move_document_new_window", {
    documentId,
    tab,
    at,
  })
}

/** What the other side of a move drains when it is ready to show tabs. */
export async function takeMovedTabs(): Promise<MovedTabPayload[]> {
  const tabs = await invoke<unknown[]>("take_moved_tabs")

  return tabs.map(parseMovedTabPayload).filter((tab): tab is MovedTabPayload => tab !== null)
}
