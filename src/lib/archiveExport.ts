export type ArchiveFormat = "jpg" | "png" | "bookmarks"

export type ArchiveExportRequest = {
  format: ArchiveFormat
  suggestedName: string
  filterLabel: string
}
