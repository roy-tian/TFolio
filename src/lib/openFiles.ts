import { invoke } from "@tauri-apps/api/core"

/** Where a file asked to open already is, matched by the file's identity
    rather than its spelling: one of this window's tabs, another window's —
    which Rust brings forward to take the open itself — or none. */
export type OpenFileHolder =
  | { kind: "none" }
  | { documentId: number; kind: "here" }
  | { kind: "elsewhere" }

/** `tabIds` are this window's live tabs: a record of its own may be a close
    still in flight. A lookup that fails opens the file as new. */
export function findOpenFile(
  path: string,
  tabIds: readonly number[],
): Promise<OpenFileHolder> {
  return invoke<OpenFileHolder>("find_open_file", {
    path,
    tabIds: [...tabIds],
  }).catch((): OpenFileHolder => ({ kind: "none" }))
}

/** Whether something else has written the document's file since the document
    last read or wrote it. A check that cannot answer leaves the tab as it is. */
export function documentFileChanged(documentId: number): Promise<boolean> {
  return invoke<boolean>("pdf_file_changed", { documentId }).catch(() => false)
}
