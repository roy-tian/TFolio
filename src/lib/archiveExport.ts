export type ImageFormat = "jpg" | "png"

/** Mirrors `ArchiveOptions` in `src-tauri/src/pdfium/archive.rs`, tagged so
    only the images variant carries the density and page selection. */
export type ArchiveOptions =
  | { format: "images"; imageFormat: ImageFormat; dpi: number; pages: number[] }
  | { format: "bookmarks" }
  | { format: "pages" }

export type ArchiveExportRequest = {
  options: ArchiveOptions
  suggestedName: string
  filterLabel: string
}

// The bounds the engine enforces on its own; the picker stays inside them.
export const MIN_IMAGE_DPI = 72
export const MAX_IMAGE_DPI = 600

/** The named densities the dialog offers; each one's hint says what it is for. */
export const IMAGE_DPI_CHOICES = [75, 150, 300, 600] as const
