import { invoke } from "@tauri-apps/api/core"

import { fileNameFromPath } from "@/lib/pdf"

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
