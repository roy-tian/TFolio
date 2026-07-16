export type PdfOutlineItem = {
  items: PdfOutlineItem[]
  pageNumber: number | null
  title: string
}

export type PdfPageInfo = {
  height: number
  width: number
}

/**
 * A run of text on a page and its bounding box, in PDF points with a top-left
 * origin. Used to overlay a selectable text layer on the rendered page image.
 */
export type PdfTextSpan = {
  height: number
  left: number
  text: string
  top: number
  width: number
}

export type PdfDocumentInfo = {
  id: number
  numPages: number
  outline: PdfOutlineItem[]
  pages: PdfPageInfo[]
}

export const MAX_PDF_BYTES = 512 * 1024 * 1024

export function isPdfFile(file: Pick<File, "name" | "type">) {
  return file.type === "application/pdf" || file.name.toLowerCase().endsWith(".pdf")
}
