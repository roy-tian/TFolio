import { $, browser, expect } from "@wdio/globals"

import { bandedPdf, minimalPdf, openPdfFromDisk, refreshApp, seedSettings } from "./helpers"
import { calibratePointer, pointer } from "./nativePointer"

describe("PDF scrolling", () => {
  before(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
  })

  for (const viewMode of ["single", "book"] as const) {
    it(`lays ${viewMode} pages out below the tab strip and beside the sidebar`, async () => {
      await seedSettings({ ui: { language: "en", viewMode } })
      await refreshApp()
      await openPdfFromDisk(`beside-sidebar-${viewMode}.pdf`, bandedPdf(48))
      await browser.waitUntil(() => browser.execute(() => {
        const canvas = document.querySelector<HTMLCanvasElement>("[data-page-number='1'] canvas")
        return !!canvas && canvas.width > 100
      }))

      const layout = await browser.execute(() => {
        const session = "[data-document-session][data-active='true']"
        const viewer = document.querySelector<HTMLElement>(`${session} [data-pdf-scroll-root]`)!
        const strip = document.querySelector<HTMLElement>("[data-tab-strip]")!
        const sidebar = document.querySelector<HTMLElement>(`${session} [data-slot='app-sidebar']`)!
        const page = viewer.querySelector<HTMLElement>("[data-page-number='1']")!
        const viewerBox = viewer.getBoundingClientRect()
        const stripBox = strip.getBoundingClientRect()
        const sidebarBox = sidebar.getBoundingClientRect()

        return {
          blur: getComputedStyle(strip).backdropFilter,
          pageGap: page.getBoundingClientRect().top - viewerBox.top,
          sidebarRight: sidebarBox.right,
          stripBottom: stripBox.bottom,
          stripLeft: stripBox.left,
          stripRight: stripBox.right,
          viewerLeft: viewerBox.left,
          viewerTop: viewerBox.top,
          windowWidth: window.innerWidth,
        }
      })
      // The strip is opaque now: pages start below it rather than under it.
      expect(layout.blur).toBe("none")
      expect(layout.viewerTop).toBe(layout.stripBottom)
      expect(layout.viewerLeft).toBe(layout.sidebarRight)
      expect(layout.stripLeft).toBe(layout.sidebarRight)
      expect(layout.stripRight).toBe(layout.windowWidth)
      // An initial seek uses the page's 20px scroll margin; an untouched
      // layout keeps its 32px padding.
      expect(layout.pageGap).toBeGreaterThanOrEqual(20)
      expect(layout.pageGap).toBeLessThanOrEqual(32)
    })
  }

  it("gives the pages the sidebar's width when it is hidden, and keeps the menu in the toolbar", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("sidebar-toggle.pdf", minimalPdf(3, "0 0 595 842"))
    await $("[data-page-number='1'] canvas[data-rendered='true']").waitForExist()

    const session = "[data-document-session][data-active='true']"
    const viewerLeft = () => browser.execute((scope: string) =>
      document.querySelector(`${scope} [data-pdf-scroll-root]`)!.getBoundingClientRect().left, session)
    const toolbarMenu = $(`${session} [data-slot='toolbar'] [data-slot='app-menu']`)
    // The menu ends the bar, just before the window controls (this suite runs on Linux only).
    const menuEndsToolbar = () => browser.execute((scope: string) => {
      const menu = document.querySelector(`${scope} [data-slot='toolbar'] [data-slot='app-menu']`)!
      const next = menu.closest("[data-slot='toolbar'] > div > *")?.nextElementSibling
      return next?.getAttribute("data-slot") === "window-controls"
    }, session)

    expect(await viewerLeft()).toBeGreaterThan(200)
    await expect(toolbarMenu).toBeDisplayed()
    await expect($(`${session} [data-slot='app-sidebar'] [data-slot='app-menu']`)).not.toBeExisting()
    expect(await menuEndsToolbar()).toBe(true)

    await $(`${session} [data-slot='app-sidebar'] button[aria-label='Hide sidebar']`).click()
    await expect($(`${session} [data-slot='app-sidebar']`)).not.toBeExisting()
    await browser.waitUntil(async () => (await viewerLeft()) === 0)
    await expect(toolbarMenu).toBeDisplayed()
    expect(await menuEndsToolbar()).toBe(true)

    await $(`${session} [data-slot='toolbar'] button[aria-label='Show sidebar']`).click()
    await expect($(`${session} [data-slot='app-sidebar']`)).toBeDisplayed()
    await expect(toolbarMenu).toBeDisplayed()
  })

  // The browser keeps the scroll offset, so a page wider than the viewer would
  // ride the viewer's left edge across the sidebar's whole width.
  it("keeps a page wider than the viewer centred as the sidebar hides and shows", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("sidebar-centre.pdf", minimalPdf(3, "0 0 595 842"))
    await $("[data-page-number='1'] canvas[data-rendered='true']").waitForExist()

    const session = "[data-document-session][data-active='true']"
    await $(`${session} button[aria-label='Actual size']`).click()
    for (let rung = 0; rung < 5; rung += 1) {
      await $(`${session} button[aria-label='Zoom in']`).click()
    }
    await expect($(`${session} [data-slot='zoom-controls']`))
      .toHaveAttribute("aria-label", "Zoom 200%")

    const centring = () => browser.execute((scope: string) => {
      const viewer = document.querySelector<HTMLElement>(`${scope} [data-pdf-scroll-root]`)!
      const box = viewer.getBoundingClientRect()
      const page = viewer.querySelector("[data-page-number='1']")!.getBoundingClientRect()

      return {
        left: box.left,
        offCentre: page.left + page.width / 2 - (box.left + viewer.clientWidth / 2),
        overflow: viewer.scrollWidth - viewer.clientWidth,
      }
    }, session)

    await browser.execute((scope: string) => {
      const viewer = document.querySelector<HTMLElement>(`${scope} [data-pdf-scroll-root]`)!
      viewer.scrollLeft = (viewer.scrollWidth - viewer.clientWidth) / 2
    }, session)
    const shown = await centring()
    expect(shown.overflow).toBeGreaterThan(0)
    expect(Math.abs(shown.offCentre)).toBeLessThanOrEqual(1)

    await $(`${session} [data-slot='app-sidebar'] button[aria-label='Hide sidebar']`).click()
    await browser.waitUntil(async () => (await centring()).left < shown.left)
    const hidden = await centring()
    expect(hidden.overflow).toBeGreaterThan(0)
    expect(Math.abs(hidden.offCentre)).toBeLessThanOrEqual(1)

    await $(`${session} [data-slot='toolbar'] button[aria-label='Show sidebar']`).click()
    await browser.waitUntil(async () => (await centring()).left > hidden.left)
    expect(Math.abs((await centring()).offCentre)).toBeLessThanOrEqual(1)
  })

  // Everywhere but macOS the app lays its own bar over the pages: no gutter takes
  // width from them, so nothing re-fits as a bar comes and goes.
  it("lays its own scrollbar over the pages", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("overlay-bar.pdf", bandedPdf(12))
    await $("[data-page-number='1'] canvas[data-rendered='true']").waitForExist()

    const session = "[data-document-session][data-active='true']"
    const bar = () => browser.execute((scope: string) => {
      const viewer = document.querySelector<HTMLElement>(`${scope} [data-pdf-scroll-root]`)!
      const root = viewer.parentElement!.querySelector<HTMLElement>(
        ":scope > [data-slot='overlay-scrollbars']",
      )!
      const track = root.querySelector<HTMLElement>("[data-axis='y']")!
      const box = track.getBoundingClientRect()
      const thumb = track.firstElementChild!.getBoundingClientRect()

      return {
        centre: { x: thumb.left + thumb.width / 2, y: thumb.top + thumb.height / 2 },
        expanded: track.dataset.expanded !== undefined,
        gutter: viewer.offsetWidth - viewer.clientWidth,
        maxScroll: viewer.scrollHeight - viewer.clientHeight,
        scrollPerPixel:
          (viewer.scrollHeight - viewer.clientHeight) / (box.height - thumb.height),
        scrollTop: viewer.scrollTop,
        shown: root.dataset.visible !== undefined,
        trackHidden: track.hidden,
        // 0 with the thumb at the top of its travel, 1 at the bottom.
        travel: (thumb.top - box.top) / (box.height - thumb.height),
      }
    }, session)
    const wheelOverBar = (init: WheelEventInit) => browser.execute(
      (scope: string, init: WheelEventInit) => {
        const viewer = document.querySelector<HTMLElement>(`${scope} [data-pdf-scroll-root]`)!
        viewer.parentElement!
          .querySelector(":scope > [data-slot='overlay-scrollbars'] [data-axis='y']")!
          .dispatchEvent(new WheelEvent("wheel", { bubbles: true, cancelable: true, ...init }))
      },
      session,
      init,
    )

    const resting = await bar()
    expect(resting.gutter).toBe(0)
    expect(resting.trackHidden).toBe(false)
    expect(resting.maxScroll).toBeGreaterThan(0)

    await browser.execute((scope: string) => {
      const viewer = document.querySelector<HTMLElement>(`${scope} [data-pdf-scroll-root]`)!
      viewer.scrollTop = Math.round((viewer.scrollHeight - viewer.clientHeight) / 2)
    }, session)
    await browser.waitUntil(async () => (await bar()).shown, {
      timeoutMsg: "scrolling never showed the bar",
    })
    expect((await bar()).travel).toBeCloseTo(0.5, 1)
    await browser.waitUntil(async () => !(await bar()).shown, {
      timeout: 3000,
      timeoutMsg: "the bar never faded once the scroll stopped",
    })

    // Pointed at, the thumb widens; dragged, it carries the pages along.
    const offset = await calibratePointer()
    const grabbed = await bar()
    const at = { x: grabbed.centre.x + offset.x, y: grabbed.centre.y + offset.y }
    pointer(at)
    await browser.waitUntil(async () => (await bar()).expanded, {
      timeoutMsg: "pointing at the bar never widened it",
    })
    pointer({ down: true })
    try {
      pointer({ x: at.x, y: at.y + 20 })
      pointer({ x: at.x, y: at.y + 40 })
      await browser.waitUntil(async () => {
        const moved = (await bar()).scrollTop - grabbed.scrollTop
        return Math.abs(moved - 40 * grabbed.scrollPerPixel) <= 2 * grabbed.scrollPerPixel
      }, { timeoutMsg: "dragging the thumb never carried the pages along" })
    } finally {
      pointer({ down: false })
      pointer({ x: 300 + offset.x, y: 300 + offset.y })
    }
    await browser.waitUntil(async () => !(await bar()).expanded, {
      timeoutMsg: "the bar stayed wide after the pointer left",
    })

    // The bar is no part of the scroll box, yet a wheel over it scrolls the
    // pages, and a ctrl-wheel still zooms them rather than the whole app.
    const beforeWheel = (await bar()).scrollTop
    await wheelOverBar({ deltaY: 200 })
    await browser.waitUntil(async () => Math.abs((await bar()).scrollTop - beforeWheel - 200) < 1, {
      timeoutMsg: "a wheel over the bar never scrolled the pages",
    })
    const zoomGroup = $(`${session} [data-slot='zoom-controls']`)
    const zoomBefore = await zoomGroup.getAttribute("aria-label")
    await wheelOverBar({ ctrlKey: true, deltaY: -100 })
    await browser.waitUntil(async () => (await zoomGroup.getAttribute("aria-label")) !== zoomBefore, {
      timeoutMsg: "a ctrl-wheel over the bar never zoomed the pages",
    })
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
