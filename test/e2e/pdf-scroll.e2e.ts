import { $, browser, expect } from "@wdio/globals"

import { bandedPdf, minimalPdf, openPdfFromDisk, refreshApp, seedSettings } from "./helpers"
import { calibratePointer, pointer } from "./nativePointer"

describe("PDF scrolling", () => {
  before(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
  })

  for (const viewMode of ["single", "book", "thumbnail"] as const) {
    it(`scrolls ${viewMode} pages behind the blurred tab strip`, async () => {
      await seedSettings({ ui: { language: "en", viewMode } })
      await refreshApp()
      // Enough pages that the thumbnail grid, too, outgrows the window.
      await openPdfFromDisk(`under-tabs-${viewMode}.pdf`, bandedPdf(48))
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

  // Fitted beside a bar that comes and goes, a document whose height straddles
  // the viewer's summons the bar, narrows, dismisses it, and widens, every frame.
  it("fits pages to one width whether or not the scrollbar shows", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "book" } })
    await refreshApp()
    await openPdfFromDisk("gutter-fit.pdf", minimalPdf(2, "0 0 595 842"))
    await $("[data-page-number='1'] canvas[data-rendered='true']").waitForExist()

    const fitted = () => browser.execute(() => {
      const viewer = document.querySelector<HTMLElement>("[data-pdf-scroll-root]")!
      const page = viewer.querySelector("[data-page-number='1']")!

      return {
        gutter: viewer.offsetWidth - viewer.clientWidth,
        width: page.getBoundingClientRect().width,
      }
    })
    const setOverflowY = (value: "hidden" | "scroll") => browser.execute((overflowY: string) => {
      document.querySelector<HTMLElement>("[data-pdf-scroll-root]")!.style.overflowY = overflowY
    }, value)

    try {
      await setOverflowY("scroll")
      await browser.waitUntil(async () => (await fitted()).gutter === 12)
      await browser.pause(300)
      const beside = await fitted()

      await setOverflowY("hidden")
      await browser.waitUntil(async () => (await fitted()).gutter === 0)
      // Room for a re-fit to land, were pages fitted to the client width.
      await browser.pause(300)
      expect((await fitted()).width).toBe(beside.width)
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

  // Pressed for real: the bridge's click never let go of the selection the
  // way a released button does, which left the caret before the number.
  it("keeps a focused page field on the page read until something is typed", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("page-field.pdf", bandedPdf(12))
    await $("[data-page-number='1'] canvas[data-rendered='true']").waitForExist()
    const offset = await calibratePointer()
    const field = () => browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>("input[aria-label='Page number']")!

      return {
        focused: document.activeElement === input,
        selected: input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0),
        value: input.value,
      }
    })
    const press = async () => {
      const at = await browser.execute(() => {
        const box = document.querySelector("input[aria-label='Page number']")!.getBoundingClientRect()

        return { x: box.left + box.width / 2, y: box.top + box.height / 2 }
      })
      pointer({ x: at.x + offset.x, y: at.y + offset.y })
      pointer({ down: true })
      pointer({ down: false })
      await browser.waitUntil(async () => (await field()).focused)
    }
    const readTo = async (page: number) => {
      await browser.execute((page) => {
        document.querySelector(`[data-page-number='${page}']`)!.scrollIntoView({ block: "start" })
      }, page)
      await expect($("[data-slot='page-status']")).toHaveAttribute("aria-label", `Page ${page} of 12`)
    }

    await press()
    expect(await field()).toEqual({ focused: true, selected: "1", value: "1" })

    await readTo(5)
    expect(await field()).toEqual({ focused: true, selected: "5", value: "5" })

    // Not `setValue`: the bridge's clear blurs the field, which drops the
    // draft, and its typing then appends to the restored number ("59").
    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>("input[aria-label='Page number']")!

      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "9")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await readTo(3)
    expect((await field()).value).toBe("9")
    await browser.keys("Enter")
    await expect($("[data-slot='page-status']")).toHaveAttribute("aria-label", "Page 9 of 12")

    // Untyped, Enter stands on the page the field has followed to.
    await press()
    await readTo(4)
    await browser.keys("Enter")
    await browser.pause(500)
    await expect($("[data-slot='page-status']")).toHaveAttribute("aria-label", "Page 4 of 12")
    expect(await field()).toMatchObject({ focused: false, value: "4" })
  })
})
