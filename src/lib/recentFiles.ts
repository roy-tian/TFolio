import { invoke } from "@tauri-apps/api/core"

import { fileNameFromPath } from "@/lib/pdf"
import { isViewMode, type ViewMode } from "@/lib/viewMode"
import { MAX_ZOOM, MIN_ZOOM, type ZoomMode, type ZoomState } from "@/lib/zoom"

/** How many of the backend's list the home tab shows. It keeps more than this,
    so the shorter list still fills up once files that have since gone are left
    out of it. */
export const RECENT_FILE_LIMIT = 5

export type RecentFile = {
  /** The folder the file sits in, shown to tell apart two same-named files. */
  directory: string
  name: string
  path: string
}

export type RecentPdfPosition = {
  /** A point in the page under the viewer's top-centre reading line. */
  fractionX: number
  fractionY: number
  pageNumber: number
}

export type RecentPdfView = {
  position: RecentPdfPosition
  viewMode: ViewMode
  zoom: ZoomState
}

const MAX_PAGE_NUMBER = 2_147_483_647
const MAX_ANCHOR_FRACTION = 100
const zoomModes: readonly ZoomMode[] = [
  "auto",
  "custom",
  "fit-page",
  "fit-width",
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function isPageNumber(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= MAX_PAGE_NUMBER
  )
}

/**
 * Checks the app-owned record again at the WebView boundary. An older app or a
 * hand edit may have left a shape this version cannot place; that costs only
 * this convenience, never opening the PDF.
 */
export function parseRecentPdfView(value: unknown): RecentPdfView | null {
  if (!isRecord(value) || !isRecord(value.zoom) || !isRecord(value.position)) {
    return null
  }

  const { position, zoom } = value
  const fractionX = position.fractionX
  const fractionY = position.fractionY
  const customScale = zoom.customScale
  const viewMode = value.viewMode
  const zoomMode = zoom.mode

  if (
    !isViewMode(viewMode) ||
    !zoomModes.includes(zoomMode as ZoomMode) ||
    !isFiniteNumber(customScale) ||
    customScale < MIN_ZOOM ||
    customScale > MAX_ZOOM ||
    !isPageNumber(zoom.fitPage) ||
    !isPageNumber(position.pageNumber) ||
    !isFiniteNumber(fractionX) ||
    !isFiniteNumber(fractionY) ||
    Math.abs(fractionX) > MAX_ANCHOR_FRACTION ||
    Math.abs(fractionY) > MAX_ANCHOR_FRACTION
  ) {
    return null
  }

  return {
    position: {
      fractionX,
      fractionY,
      pageNumber: position.pageNumber,
    },
    viewMode,
    zoom: {
      customScale,
      fitPage: zoom.fitPage,
      mode: zoomMode as ZoomMode,
    },
  }
}

export function directoryFromPath(path: string) {
  const index = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"))

  if (index < 0) {
    return ""
  }

  const directory = path.slice(0, index)

  // A file directly under a root leaves only the root before the separator —
  // nothing on POSIX, a bare drive on Windows — and there the separator is
  // part of the folder's name rather than a divider inside it.
  return directory === "" || /^[A-Za-z]:$/.test(directory)
    ? path.slice(0, index + 1)
    : directory
}

export function describeRecentFiles(
  paths: readonly string[],
  limit = RECENT_FILE_LIMIT,
): RecentFile[] {
  return paths.slice(0, limit).map((path) => ({
    directory: directoryFromPath(path),
    name: fileNameFromPath(path),
    path,
  }))
}

/**
 * The recently opened files the backend still finds on disk.
 *
 * The list lives there rather than in this WebView's storage because it is the
 * durable half of the approved-path set: a path only reopens if the backend
 * watched the OS produce it, and only the backend can say that of a path from
 * an earlier run.
 */
export async function readRecentFiles(): Promise<RecentFile[]> {
  try {
    return describeRecentFiles(await invoke<string[]>("recent_pdfs"))
  } catch {
    // A recent list is a convenience; failing to read one leaves the home tab
    // with its open action, which is all it ever promised.
    return []
  }
}

/** The view last kept for a recent path, if this version can use it. */
export async function readRecentPdfView(
  path: string,
): Promise<RecentPdfView | null> {
  try {
    return parseRecentPdfView(
      await invoke<unknown>("recent_pdf_view", { path }),
    )
  } catch {
    return null
  }
}

/**
 * Keeps one recent PDF's view. Like the list itself this is a convenience: a
 * failed write must not interrupt scrolling, zooming, or closing a document.
 * The backend ignores paths that a successful open did not already record.
 */
export async function storeRecentPdfView(
  path: string,
  view: RecentPdfView,
): Promise<void> {
  try {
    await invoke("set_recent_pdf_view", { path, view })
  } catch {
    // The open document remains fully usable when its convenience file cannot
    // be written.
  }
}
