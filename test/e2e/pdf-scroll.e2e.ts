import { $, browser, expect } from "@wdio/globals"

import { bandedPdf, minimalPdf, openPdfFromDisk, refreshApp, seedSettings } from "./helpers"

describe("PDF scrolling", () => {
  before(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
  })

  for (const viewMode of ["single", "book", "thumbnail"] as const) {
    it(`scrolls ${viewMode} pages behind the blurred tab strip`, async () => {
      await seedSettings({ ui: { language: "en", viewMode } })
      await refreshApp()
      await openPdfFromDisk(`under-tabs-${viewMode}.pdf`, bandedPdf(12))
      await browser.waitUntil(() => browser.execute(() => {
        const canvas = document.querySelector<HTMLCanvasElement>("[data-page-number='1'] canvas")
        return !!canvas && canvas.width > 100
      }))

      const initial = await browser.execute(() => {
        const viewer = document.querySelector<HTMLElement>("[data-pdf-scroll-root]")!
        const strip = document.querySelector<HTMLElement>("[data-tab-strip]")!
        const page = viewer.querySelector<HTMLElement>("[data-page-number='1']")!
        const stripBox = strip.getBoundingClientRect()

        return {
          viewerTop: viewer.getBoundingClientRect().top,
          stripTop: stripBox.top,
          pageGap: page.getBoundingClientRect().top - stripBox.bottom,
          blur: getComputedStyle(strip).backdropFilter,
        }
      })
      expect(initial.viewerTop).toBe(initial.stripTop)
      // An initial seek uses the page's 20px scroll margin; an untouched
      // layout keeps its 32px padding. Neither may start beneath the tabs.
      expect(initial.pageGap).toBeGreaterThanOrEqual(20)
      expect(initial.pageGap).toBeLessThanOrEqual(32)
      expect(initial.blur).toContain("blur(")

      await browser.execute(() => {
        document.querySelector<HTMLElement>("[data-pdf-scroll-root]")!.scrollTop = 100
      })
      await browser.waitUntil(() => browser.execute(() => {
        const viewer = document.querySelector<HTMLElement>("[data-pdf-scroll-root]")!
        const strip = document.querySelector<HTMLElement>("[data-tab-strip]")!
        const paper = viewer.querySelector("[data-page-number='1'] canvas")!
        const pageBox = paper.getBoundingClientRect()
        const stripBox = strip.getBoundingClientRect()
        const layers = document.elementsFromPoint(
          pageBox.left + pageBox.width / 2,
          stripBox.top + stripBox.height / 2,
        )
        const stripIndex = layers.indexOf(strip)
        const paperIndex = layers.indexOf(paper)

        // A page rectangle alone is insufficient: the old scrollport clipped
        // those pixels away before backdrop-filter could sample them.
        return stripIndex >= 0 && paperIndex > stripIndex
      }))
    })
  }

  it("spans the tab strip over the scrollbar and centres the page status on the pages", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("scrollbar-gutter.pdf", minimalPdf(100, "0 0 595 842"))
    await $("[data-page-number='1'] canvas[data-rendered='true']").waitForExist()

    const layout = () => browser.execute(() => {
      const viewer = document.querySelector<HTMLElement>("[data-pdf-scroll-root]")!
      const strip = document.querySelector<HTMLElement>("[data-tab-strip]")!
      const status = document.querySelector(
        "[data-document-session][data-active='true'] [data-slot='page-status']",
      )!.getBoundingClientRect()
      const box = viewer.getBoundingClientRect()
      const stripBox = strip.getBoundingClientRect()

      return {
        gutter: viewer.offsetWidth - viewer.clientWidth,
        pagesCentre: box.left + viewer.clientWidth / 2,
        statusCentre: status.left + status.width / 2,
        stripCoversGutter: strip.contains(
          document.elementFromPoint(box.right - 4, stripBox.top + stripBox.height / 2),
        ),
        stripRight: stripBox.right,
        windowWidth: window.innerWidth,
      }
    })

    try {
      // Styled, the scrollbar takes its width even where the host overlays.
      await browser.waitUntil(async () => (await layout()).gutter === 12)
      const scrolling = await layout()
      expect(scrolling.stripRight).toBe(scrolling.windowWidth)
      expect(scrolling.stripCoversGutter).toBe(true)
      expect(Math.abs(scrolling.statusCentre - scrolling.pagesCentre)).toBeLessThanOrEqual(1)

      await browser.execute(() => {
        document.querySelector<HTMLElement>("[data-pdf-scroll-root]")!.style.overflowY = "hidden"
      })
      await browser.waitUntil(async () => {
        const still = await layout()
        return still.gutter === 0 &&
          Math.abs(still.statusCentre - still.windowWidth / 2) <= 1
      })
    } finally {
      await browser.execute(() => {
        document.querySelector<HTMLElement>("[data-pdf-scroll-root]")!
          .style.removeProperty("overflow-y")
      })
    }
  })

  it("keeps page navigation and fit-page below the tabs", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("tab-inset-fit.pdf", bandedPdf(3))
    await $("[data-page-number='1'] canvas[data-rendered='true']").waitForExist()
    await $("button[aria-label='Fit page']").click()
    const pageInput = $("input[aria-label='Page number']")
    await pageInput.setValue("2")
    await browser.keys("Enter")
    await browser.waitUntil(() => browser.execute(() => {
      const strip = document.querySelector("[data-tab-strip]")!.getBoundingClientRect()
      const page = document.querySelector("[data-page-number='2']")!.getBoundingClientRect()
      const viewer = document.querySelector("[data-pdf-scroll-root]")!.getBoundingClientRect()
      return Math.abs(page.top - strip.bottom - 20) <= 1 && page.bottom <= viewer.bottom
    }))
    await expect(pageInput).toHaveValue("2")
  })

  it("renders the next page before it reaches the viewer", async () => {
    await openPdfFromDisk("prefetch.pdf", minimalPdf(3, "0 0 595 842"))
    const nextPage = $(
      "[data-document-session][data-active='true'] [data-page-number='2']",
    )
    await nextPage.waitForExist()

    const before = await browser.execute(() => {
      const viewer = document.querySelector<HTMLElement>(
        "[data-document-session][data-active='true'] main",
      )!
      const page = viewer.querySelector<HTMLElement>("[data-page-number='2']")!

      return {
        gap:
          page.getBoundingClientRect().top -
          viewer.getBoundingClientRect().bottom,
        scrollTop: viewer.scrollTop,
      }
    })
    expect(before.gap).toBeGreaterThan(0)
    expect(before.gap).toBeLessThan(800)

    await nextPage.$("canvas[data-rendered='true']").waitForExist({
      timeout: 30_000,
      timeoutMsg: "the next page was not rendered ahead of the viewport",
    })
    const after = await browser.execute(() => {
      const viewer = document.querySelector<HTMLElement>(
        "[data-document-session][data-active='true'] main",
      )!
      const page = viewer.querySelector<HTMLElement>("[data-page-number='2']")!

      return {
        gap:
          page.getBoundingClientRect().top -
          viewer.getBoundingClientRect().bottom,
        scrollTop: viewer.scrollTop,
      }
    })
    expect(after.scrollTop).toBe(before.scrollTop)
    expect(after.gap).toBeGreaterThan(0)
  })
})
