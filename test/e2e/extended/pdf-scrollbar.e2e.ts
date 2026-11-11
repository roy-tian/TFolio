import { $, browser, expect } from "@wdio/globals"

import { bandedPdf, minimalPdf, openPdfFromDisk, refreshApp, seedSettings } from "../helpers"
import { calibratePointer, pointer } from "../nativePointer"

describe("PDF overlay scrollbar", () => {
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

  // A page zoomed a little past the viewer overflows it by less than the page a
  // track press steps, which would carry the thumb to the far end every time.
  it("stops the thumb at a press on the sideways track", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("track-press.pdf", minimalPdf(1, "0 0 595 842"))
    await $("[data-page-number='1'] canvas[data-rendered='true']").waitForExist()

    const session = "[data-document-session][data-active='true']"
    await $(`${session} button[aria-label='Actual size']`).click()
    for (let rung = 0; rung < 5; rung += 1) {
      await $(`${session} button[aria-label='Zoom in']`).click()
    }
    await expect($(`${session} [data-slot='zoom-controls']`))
      .toHaveAttribute("aria-label", "Zoom 200%")

    await browser.execute((scope: string) => {
      document.querySelector<HTMLElement>(`${scope} [data-pdf-scroll-root]`)!.scrollLeft = 0
    }, session)
    await browser.waitUntil(async () => {
      const bar = await overlayBar("x")
      return bar.scroll === 0 && Math.abs(bar.thumb.left - bar.track.left) < 1
    }, { timeoutMsg: "the sideways thumb never settled at the start" })
    const start = await overlayBar("x")
    expect(start.trackHidden).toBe(false)
    expect(start.maxScroll).toBeGreaterThan(0)
    expect(start.maxScroll).toBeLessThan(0.875 * start.clientSize)

    const offset = await calibratePointer()
    const middle = Math.round((start.track.top + start.track.bottom) / 2)
    const click = (x: number) => {
      pointer({ x: x + offset.x, y: middle + offset.y })
      pointer({ down: true })
      pointer({ down: false })
    }

    try {
      const forward = Math.round(start.thumb.right + 40)
      click(forward)
      await browser.waitUntil(
        async () => Math.abs((await overlayBar("x")).thumb.right - forward) <= 1,
        { timeoutMsg: "a press past the thumb never brought its end to the press" },
      )
      expect((await overlayBar("x")).scroll).toBeLessThan(start.maxScroll - 1)

      const back = Math.round((await overlayBar("x")).thumb.left - 20)
      click(back)
      await browser.waitUntil(
        async () => Math.abs((await overlayBar("x")).thumb.left - back) <= 1,
        { timeoutMsg: "a press before the thumb never brought its start to the press" },
      )
      expect((await overlayBar("x")).scroll).toBeGreaterThan(0)
    } finally {
      pointer({ x: 300 + offset.x, y: 300 + offset.y })
    }
  })

  it("pages on toward a press held on the track", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("track-hold.pdf", bandedPdf(48))
    await $("[data-page-number='1'] canvas[data-rendered='true']").waitForExist()

    const start = await overlayBar("y")
    expect(start.trackHidden).toBe(false)

    const page = 0.875 * start.clientSize
    const at = {
      x: Math.round((start.thumb.left + start.thumb.right) / 2),
      y: Math.round(start.track.top + 0.9 * (start.track.bottom - start.track.top)),
    }
    const offset = await calibratePointer()
    pointer({ x: at.x + offset.x, y: at.y + offset.y })

    try {
      pointer({ down: true })
      await browser.waitUntil(async () => (await overlayBar("y")).scroll - start.scroll > 3 * page, {
        interval: 50,
        timeoutMsg: "holding a press on the track never paged past the first page",
      })
      pointer({ down: false })

      // The release lands a step or so behind the native event.
      await browser.pause(200)
      const released = await overlayBar("y")
      expect(released.thumb.bottom).toBeLessThan(at.y - 10)
      await browser.pause(400)
      expect((await overlayBar("y")).scroll).toBe(released.scroll)

      pointer({ down: true })
      await browser.waitUntil(
        async () => Math.abs((await overlayBar("y")).thumb.bottom - at.y) <= 1,
        { timeoutMsg: "a held press never brought the thumb to the pointer" },
      )
      await browser.pause(400)
      expect(Math.abs((await overlayBar("y")).thumb.bottom - at.y)).toBeLessThanOrEqual(1)
    } finally {
      pointer({ down: false })
      pointer({ x: 300 + offset.x, y: 300 + offset.y })
    }
  })
})

/** The active viewer's overlay bar along `axis`, in client coordinates. */
function overlayBar(axis: "x" | "y") {
  return browser.execute((axis: "x" | "y") => {
    const session = "[data-document-session][data-active='true']"
    const viewer = document.querySelector<HTMLElement>(`${session} [data-pdf-scroll-root]`)!
    const track = viewer.parentElement!.querySelector<HTMLElement>(
      `:scope > [data-slot='overlay-scrollbars'] [data-axis='${axis}']`,
    )!
    const box = track.getBoundingClientRect()
    const thumb = track.firstElementChild!.getBoundingClientRect()
    const vertical = axis === "y"

    return {
      clientSize: vertical ? viewer.clientHeight : viewer.clientWidth,
      maxScroll: vertical
        ? viewer.scrollHeight - viewer.clientHeight
        : viewer.scrollWidth - viewer.clientWidth,
      scroll: vertical ? viewer.scrollTop : viewer.scrollLeft,
      thumb: { bottom: thumb.bottom, left: thumb.left, right: thumb.right, top: thumb.top },
      track: { bottom: box.bottom, left: box.left, right: box.right, top: box.top },
      trackHidden: track.hidden,
    }
  }, axis)
}
