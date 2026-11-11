import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import { openPdfFromDisk, refreshApp, seedSettings, wrappedSearchPdf } from "../helpers"

describe("TFolio PDF search reveal", () => {
  before(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("FilenameNeedle.pdf", wrappedSearchPdf())
    await $("[data-page-number='1'] canvas").waitForDisplayed()
    await $("button[aria-label='Search this PDF']").click()
  })

  it("interrupts an obsolete smooth reveal when Previous needs no scroll", async () => {
    const input = $("input[aria-label='Search text in current PDF']")
    const status = $("[data-slot='pdf-search-status']")
    await input.setValue("wrapped phrase")
    await expect(status).toHaveText(/^\d+ \/ 2$/, { wait: 10_000 })
    if (await status.getText() === "2 / 2") {
      await $("button[aria-label='Previous result']").click()
    }
    await expect(status).toHaveText("1 / 2")
    // Keep page 2 mounted at the viewport edge while its result remains below it.
    while (await $("button[aria-label='Zoom out']").isEnabled()) {
      await $("button[aria-label='Zoom out']").click()
    }
    for (let rung = 0; rung < 8; rung += 1) {
      await $("button[aria-label='Zoom in']").click()
    }
    await expect($("[data-slot='zoom-controls']"))
      .toHaveAttribute("aria-label", "Zoom 125%")
    await browser.pause(800)
    await browser.execute(() => {
      const viewer = document.querySelector<HTMLElement>(
        "[data-document-session][data-active='true'] main",
      )!
      const view = viewer.getBoundingClientRect()
      const first = document.querySelector("[data-search-match='0']")!
      viewer.scrollTo({
        behavior: "instant",
        top: viewer.scrollTop + first.getBoundingClientRect().top - (view.top + view.height / 4),
      })
    })
    await $("[data-search-match='1']").waitForExist()

    const result = await browser.execute(async () => {
      const viewer = document.querySelector<HTMLElement>(
        "[data-document-session][data-active='true'] main",
      )!
      const view = viewer.getBoundingClientRect()
      const first = document.querySelector<HTMLElement>("[data-search-match='0']")!
      const nextBox = document.querySelector("[data-search-match='1']")!.getBoundingClientRect()
      const nextIsOffscreen = nextBox.top >= view.bottom
      const nativeScrollTo = viewer.scrollTo.bind(viewer)

      return await new Promise<{
        nextIsOffscreen: boolean
        previousIsVisible: boolean
        reversedAt: number
        finishedAt: number
        smoothCalls: number
      }>((resolve, reject) => {
        let smoothCalls = 0
        const timeout = setTimeout(() => {
          delete (viewer as Partial<HTMLElement>).scrollTo
          reject(new Error("Next did not start a smooth reveal"))
        }, 5000)

        // Forward to the native animation, but reverse in the same task: that
        // scroll is time-based, so a loaded first frame can pass the old hit.
        Object.defineProperty(viewer, "scrollTo", {
          configurable: true,
          value: (options: ScrollToOptions) => {
            nativeScrollTo(options)
            if (options.behavior !== "smooth" || ++smoothCalls !== 1) {
              return
            }
            const oldBox = first.getBoundingClientRect()
            const previousIsVisible = oldBox.top >= view.top && oldBox.bottom <= view.bottom
            const reversedAt = viewer.scrollTop
            document.querySelector<HTMLButtonElement>("button[aria-label='Previous result']")!.click()
            setTimeout(() => {
              clearTimeout(timeout)
              delete (viewer as Partial<HTMLElement>).scrollTo
              resolve({
                nextIsOffscreen,
                previousIsVisible,
                reversedAt,
                finishedAt: viewer.scrollTop,
                smoothCalls,
              })
            }, 800)
          },
        })
        document.querySelector<HTMLButtonElement>("button[aria-label='Next result']")!.click()
      })
    })

    expect(result.nextIsOffscreen).toBe(true)
    expect(result.previousIsVisible).toBe(true)
    expect(result.smoothCalls).toBe(1)
    expect(Math.abs(result.finishedAt - result.reversedAt)).toBeLessThanOrEqual(0.5)
    await expect(status).toHaveText("1 / 2")
  })
})
