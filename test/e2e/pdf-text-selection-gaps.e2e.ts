import { $, browser, expect } from "@wdio/globals"

import { dropZoneButton, fragmentedColumnsPdf, fragmentedTextPdf, openPdfFromDisk, refreshApp, renderedPage, seedSettings } from "./helpers"

import { calibratePointer, pointer } from "./nativePointer"

type SelectionWindow = Window & {
  __dragSamples?: { anchor: number; focus: number; length: number }[]
  __dragAbort?: AbortController
}
type RunBox = { left: number; right: number; top: number; bottom: number; index: number }

async function prepare(pdf: Buffer) {
  await seedSettings({ ui: { language: "en", viewMode: "single" } })
  await refreshApp()
  await dropZoneButton().waitForExist()
  await openPdfFromDisk("selection-layout.pdf", pdf)
  await renderedPage()
  await $("button[aria-label='Fit page']").click()
  await $(".pdf-text-layer span").waitForExist()
  return calibratePointer()
}

async function runs() {
  return browser.execute(() => [...document.querySelectorAll(".pdf-text-layer span")].map((span, index) => {
    const { left, right, top, bottom } = span.getBoundingClientRect()
    return { left, right, top, bottom, index }
  }))
}

async function sweep(row: RunBox[], offset: { x: number; y: number }, reverse = false) {
  // This y deliberately misses the ink boxes of the shorter glyphs. Native
  // WebKit hit testing used to select the previous row at those positions.
  const y = Math.min(...row.map(span => span.top)) + 2
  const first = row[0].left + 0.5
  const last = row[row.length - 1].right - 0.5
  const start = reverse ? last : first
  const finish = reverse ? first : last
  await browser.execute(() => {
    const page = window as SelectionWindow
    page.__dragSamples = []
    page.__dragAbort?.abort()
    page.__dragAbort = new AbortController()
    document.addEventListener("selectionchange", () => {
      const selection = window.getSelection()!
      const spans = [...document.querySelectorAll(".pdf-text-layer span")]
      page.__dragSamples?.push({
        anchor: spans.indexOf(selection.anchorNode?.parentElement as Element),
        focus: spans.indexOf(selection.focusNode?.parentElement as Element),
        length: selection.toString().length,
      })
    }, { signal: page.__dragAbort.signal })
  })
  pointer({ x: start + offset.x, y: y + offset.y })
  pointer({ down: true })
  const bands: { top: number; height: number }[] = []
  try {
    for (let distance = 3; distance < Math.abs(finish - start); distance += 3) {
      const x = start + (reverse ? -distance : distance)
      pointer({ x: x + offset.x, y: y + offset.y })
      const painted = await browser.execute(() => [...document.querySelectorAll(".pdf-selection-layer span")].map(span => {
        const { top, height } = span.getBoundingClientRect()
        return { top, height }
      }))
      expect(painted.length).toBeLessThanOrEqual(1)
      bands.push(...painted)
    }
    pointer({ x: finish + offset.x, y: y + offset.y })
    await browser.waitUntil(() => browser.execute(() => !window.getSelection()?.isCollapsed))
  } finally {
    pointer({ down: false })
  }
  const samples = await browser.execute(() => {
    const page = window as SelectionWindow
    page.__dragAbort?.abort()
    return page.__dragSamples!
  })
  expect(samples.length).toBeGreaterThan(2)
  const indices = row.map(span => span.index)
  for (const sample of samples) {
    expect(indices).toContain(sample.anchor)
    expect(indices).toContain(sample.focus)
  }
  for (let index = 1; index < samples.length; index++) {
    expect(samples[index].length).toBeGreaterThanOrEqual(samples[index - 1].length)
  }
  expect(bands.length).toBeGreaterThan(2)
  expect(Math.max(...bands.map(b => b.top)) - Math.min(...bands.map(b => b.top))).toBeLessThan(0.1)
  expect(Math.max(...bands.map(b => b.height)) - Math.min(...bands.map(b => b.height))).toBeLessThan(0.1)
}

describe("TFolio stable text hit testing", () => {
  it("never leaves the row or flashes when crossing fragmented glyph gaps", async () => {
    const offset = await prepare(fragmentedTextPdf(true))
    const boxes = await runs()
    await sweep(boxes.slice(10, 20), offset)
    expect(await browser.execute(() => window.getSelection()?.toString().replaceAll(/\s/g, ""))).toBe("Selectable")
    await sweep(boxes.slice(20, 30), offset, true)
    expect(await browser.execute(() => window.getSelection()?.toString().replaceAll(/\s/g, ""))).toBe("Selectable")
  })

  it("keeps endpoints aligned after zoom and quarter-turn rotation", async () => {
    const offset = await prepare(fragmentedTextPdf(true))
    await $("button[aria-label='Zoom in']").click()
    await $("button[aria-label='Rotate the view clockwise']").click()
    await $("button[aria-label='Fit page']").click()
    const boxes = await runs()
    const row = boxes.slice(10, 20)
    const x = Math.max(...row.map(b => b.right)) - 2
    pointer({ x: x + offset.x, y: row[0].top + 0.5 + offset.y })
    pointer({ down: true })
    try {
      for (let y = row[0].top + 3; y < row[9].bottom; y += 3) {
        pointer({ x: x + offset.x, y: y + offset.y })
        const focus = await browser.execute(() => [...document.querySelectorAll(".pdf-text-layer span")]
          .indexOf(window.getSelection()?.focusNode?.parentElement as Element))
        expect(row.map(b => b.index)).toContain(focus)
      }
      pointer({ x: x + offset.x, y: row[9].bottom - 0.5 + offset.y })
    } finally {
      pointer({ down: false })
    }
    expect(await browser.execute(() => window.getSelection()?.toString().replaceAll(/\s/g, ""))).toBe("Selectable")
  })

  for (const table of [false, true]) {
    it(`keeps ${table ? "table cells" : "columns"} independent while dragging through whitespace`, async () => {
      const offset = await prepare(fragmentedColumnsPdf(table))
      const boxes = await runs()
      // PDFium returns prose column-major, but a table row-major. Select the
      // bottom-right row by its geometry, without changing either reading order.
      const middleX = (Math.min(...boxes.map(b => b.left)) + Math.max(...boxes.map(b => b.right))) / 2
      const middleY = (Math.min(...boxes.map(b => b.top)) + Math.max(...boxes.map(b => b.bottom))) / 2
      const row = boxes.filter(b => b.left > middleX && b.top > middleY).sort((a, b) => a.left - b.left)
      expect(row).toHaveLength(9)
      await sweep(row, offset)
      expect(await browser.execute(() => window.getSelection()?.toString().replaceAll(/\s/g, ""))).toBe("RightText")
      // Prose follows the left column down before the right; a table follows
      // its cells across the row. Neither may borrow an unrelated column/row.
      const first = boxes[0]
      const last = boxes[17]
      pointer({ x: first.left + 0.5 + offset.x, y: first.top + 2 + offset.y })
      pointer({ down: true })
      try {
        pointer({ x: last.right - 0.5 + offset.x, y: last.top + 2 + offset.y })
      } finally {
        pointer({ down: false })
      }
      expect(await browser.execute(() => window.getSelection()?.toString().replaceAll(/\s/g, "")))
        .toBe(table ? "LeftWordsRightText" : "LeftWordsLeftWords")
    })
  }
})
