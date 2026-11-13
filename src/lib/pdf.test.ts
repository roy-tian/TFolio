import { describe, expect, test } from "bun:test"

import {
  dimensionsForRotation,
  EXPORT_COPY_ONLY,
  EXPORT_DENIED,
  EXPORT_DOCUMENT_CHANGED,
  EXPORT_NO_SPACE,
  EXPORT_SIGNED,
  EXPORT_TARGET_MISSING,
  EXPORT_TARGET_OPEN,
  exportFailureNotice,
  fileNameFromPath,
  isPdfPath,
  pickCurrentPage,
  pickReadingPage,
  resolveOutputScale,
  SIGNED_ORIGINAL_CHANGED,
  signatureMark,
} from "./pdf"

describe("isPdfPath", () => {
  test("accepts a PDF extension in any case", () => {
    expect(isPdfPath("/home/roy/document.pdf")).toBe(true)
    expect(isPdfPath("C:\\Files\\Document.PDF")).toBe(true)
  })

  test("rejects other extensions", () => {
    expect(isPdfPath("/home/roy/notes.txt")).toBe(false)
    expect(isPdfPath("/home/roy/document.pdf.png")).toBe(false)
  })
})

describe("exportFailureNotice", () => {
  test("names each backend code, rejected bare or wrapped", () => {
    expect(exportFailureNotice(EXPORT_TARGET_OPEN)).toBe("exportTargetOpen")
    expect(exportFailureNotice(new Error(EXPORT_TARGET_OPEN))).toBe(
      "exportTargetOpen",
    )
    expect(exportFailureNotice(EXPORT_COPY_ONLY)).toBe("exportCopyOnly")
    expect(exportFailureNotice(new Error(EXPORT_DENIED))).toBe("exportDenied")
    expect(exportFailureNotice(EXPORT_SIGNED)).toBe("exportSigned")
    expect(exportFailureNotice(new Error(SIGNED_ORIGINAL_CHANGED))).toBe(
      "exportSignedChanged",
    )
    expect(exportFailureNotice(EXPORT_NO_SPACE)).toBe("exportNoSpace")
    expect(exportFailureNotice(new Error(EXPORT_TARGET_MISSING))).toBe("exportTargetMissing")
    expect(exportFailureNotice(EXPORT_DOCUMENT_CHANGED)).toBe("exportDocumentChanged")
  })

  test("leaves any other failure to the generic notice", () => {
    expect(exportFailureNotice("could not write to /tmp/a.pdf")).toBe(
      "exportFailed",
    )
    expect(exportFailureNotice(`${EXPORT_TARGET_OPEN} and more`)).toBe(
      "exportFailed",
    )
    expect(exportFailureNotice(undefined)).toBe("exportFailed")
  })
})

describe("fileNameFromPath", () => {
  test("takes the last segment of either separator", () => {
    expect(fileNameFromPath("/home/roy/document.pdf")).toBe("document.pdf")
    expect(fileNameFromPath("C:\\Files\\document.pdf")).toBe("document.pdf")
  })

  test("hands back a bare name unchanged", () => {
    expect(fileNameFromPath("document.pdf")).toBe("document.pdf")
  })
})

describe("dimensionsForRotation", () => {
  test("leaves upright pages alone", () => {
    expect(dimensionsForRotation(0, 200, 300)).toEqual({ height: 300, width: 200 })
    expect(dimensionsForRotation(180, 200, 300)).toEqual({ height: 300, width: 200 })
  })

  test("swaps the axes on a quarter turn", () => {
    expect(dimensionsForRotation(90, 200, 300)).toEqual({ height: 200, width: 300 })
    expect(dimensionsForRotation(270, 200, 300)).toEqual({ height: 200, width: 300 })
  })
})

describe("pickCurrentPage", () => {
  // A 700px-tall viewer, in the client coordinates the tracker reads off.
  const VIEWPORT_TOP = 0
  const VIEWPORT_BOTTOM = 700

  const page = (pageNumber: number, top: number, bottom: number) => ({
    bottom,
    pageNumber,
    top,
  })
  const pick = (candidates: ReturnType<typeof page>[]) =>
    pickCurrentPage(candidates, VIEWPORT_TOP, VIEWPORT_BOTTOM)

  test("returns null when nothing is visible", () => {
    expect(pick([])).toBeNull()
  })

  // The regression a fixed reading line caused: a line ~237px down lands two
  // rows past a 107px row navigation had just parked at the top.
  test("reports a short row parked at the top of the viewer", () => {
    const rows = [page(13, 20, 127), page(17, 165, 272), page(21, 310, 417)]

    expect(pick(rows)).toBe(13)
  })

  test("holds the top row until it is more than half gone", () => {
    // 57 of 107 left, so still the reader's row.
    expect(pick([page(1, -50, 57), page(5, 73, 180)])).toBe(1)
    // 47 of 107 left, so the row below takes over.
    expect(pick([page(1, -60, 47), page(5, 63, 170)])).toBe(5)
  })

  test("scores a page taller than the viewport against the viewport", () => {
    // Nothing can show more than 700px, so filling the viewer counts as whole.
    expect(pick([page(3, -100, 1100)])).toBe(3)
  })

  test("hands over as the next tall page takes the viewport", () => {
    expect(pick([page(5, -800, 400), page(6, 420, 1620)])).toBe(5)
    expect(pick([page(5, -1000, 200), page(6, 220, 1420)])).toBe(6)
  })

  test("falls back to the most visible page when neither clears half", () => {
    expect(pick([page(5, -865, 335), page(6, 355, 1555)])).toBe(6)
  })

  // A book spread and a thumbnail row put several pages on the same line.
  test("resolves a tie to the lowest page number, whatever the order", () => {
    const spread = [page(4, 0, 300), page(3, 0, 300)]

    expect(pick(spread)).toBe(3)
    expect(pick([...spread].reverse())).toBe(3)
  })
})

describe("pickReadingPage", () => {
  // 100px pages 10px apart at the end of the document, seen in a 700px viewer:
  // a quarter of page 2 shows, page 3 is the first whole, page 8 the last.
  const atEnd = [2, 3, 4, 5, 6, 7, 8].map((pageNumber) => ({
    bottom: (pageNumber - 2) * 110 + 25,
    pageNumber,
    top: (pageNumber - 2) * 110 - 75,
  }))
  const view = (scrollTop: number) => ({ bottom: 700, scrollTop, top: 0 })
  const jumpTo = (page: number, landedTop: number | null = null) => ({ landedTop, page, since: 0 })

  test("names the first page at least half showing with no jump to hold", () => {
    expect(pickReadingPage(atEnd, view(900), null, 0)).toEqual({ jump: null, page: 3 })
  })

  test("holds the page a jump went to at the end, though the view cannot bring it to the top", () => {
    // A jump that scrolled nothing lands on the first look after it.
    const landed = pickReadingPage(atEnd, view(900), jumpTo(8), 4000)

    expect(landed).toEqual({ jump: jumpTo(8, 900), page: 8 })
    // A nudge keeps it; a quarter of the view's height lets it go.
    expect(pickReadingPage(atEnd, view(892), landed.jump, 5000).page).toBe(8)
    expect(pickReadingPage(atEnd, view(725), landed.jump, 5000)).toEqual({ jump: null, page: 3 })
  })

  test("lands where the jump's own scroll stops, though the page showed long before", () => {
    // Zoomed out, page 8 shows a moment into a jump that goes on to the end.
    const early = pickReadingPage(atEnd, view(30), jumpTo(8), 100)
    const stopped = pickReadingPage(atEnd, view(900), early.jump, 600)

    expect(stopped).toEqual({ jump: jumpTo(8, 900), page: 8 })
    expect(pickReadingPage(atEnd, view(892), stopped.jump, 5000).page).toBe(8)
  })

  test("names the page on the jump's way there, not the pages it passes", () => {
    const passing = [{ bottom: 600, pageNumber: 2, top: -100 }]

    expect(pickReadingPage(passing, view(100), jumpTo(8), 200)).toEqual({ jump: jumpTo(8), page: 8 })
  })

  test("lets a jump go once the reader took the view elsewhere before it arrived", () => {
    const elsewhere = [{ bottom: 600, pageNumber: 2, top: -100 }]

    expect(pickReadingPage(elsewhere, view(100), jumpTo(8), 2000)).toEqual({ jump: null, page: 2 })
  })

  test("holds the page through a relayout while a move the app made settles", () => {
    // A turn re-landed the jump at 1000; a passing frame shows the page cut short.
    const relanded = { landedTop: null, page: 8, since: 1000 }
    const midRelayout = [{ bottom: 600, pageNumber: 2, top: -100 }]

    expect(pickReadingPage(midRelayout, view(400), relanded, 1200)).toEqual({ jump: relanded, page: 8 })
  })

  test("lets the page go once less than half of it shows", () => {
    const scrolledOff = [
      { bottom: 650, pageNumber: 4, top: 0 },
      { bottom: 760, pageNumber: 8, top: 660 },
    ]

    expect(pickReadingPage(scrolledOff, view(900), jumpTo(8, 900), 5000).page).toBe(4)
  })
})

describe("resolveOutputScale", () => {
  test("floors a low-DPI surface up to the page minimum", () => {
    expect(resolveOutputScale(1, 1.25)).toBe(1.25)
    expect(resolveOutputScale(1.1, 1.25)).toBe(1.25)
  })

  test("leaves a ratio already at or above the floor untouched", () => {
    expect(resolveOutputScale(1.25, 1.25)).toBe(1.25)
    expect(resolveOutputScale(1.5, 1.25)).toBe(1.5)
  })

  test("caps a high-DPI surface at the shared 2x ceiling", () => {
    expect(resolveOutputScale(2, 1.25)).toBe(2)
    expect(resolveOutputScale(3, 1.25)).toBe(2)
  })

  test("treats a zero device-pixel ratio as 1", () => {
    expect(resolveOutputScale(0, 1.25)).toBe(1.25)
  })

  test("defaults to no floor, so the device ratio alone decides", () => {
    expect(resolveOutputScale(1)).toBe(1)
    expect(resolveOutputScale(1.5)).toBe(1.5)
    expect(resolveOutputScale(2.5)).toBe(2)
  })
})

describe("signatureMark", () => {
  const signatures = { count: 2, decision: null, flattened: false, intact: true }

  test("marks a document still bound to its intact signed file", () => {
    expect(signatureMark(signatures)).toBe("intact")
  })

  test("marks signatures that no longer hold as broken", () => {
    expect(signatureMark({ ...signatures, decision: "keep", intact: false })).toBe("broken")
  })

  test("leaves flattened and unsigned documents unmarked", () => {
    expect(signatureMark({ ...signatures, flattened: true, intact: false })).toBeNull()
    expect(signatureMark({ ...signatures, count: 0, intact: false })).toBeNull()
  })
})
