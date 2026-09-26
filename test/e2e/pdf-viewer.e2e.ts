import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  clickAppMenuItem,
  dropZoneButton,
  minimalPdf,
  openPdfFromDisk,
  refreshApp,
  seedSettings,
  textPdf,
} from "./helpers"

// The zoom listener is bound natively and non-passively, so the wheel goes out
// as a real event; hidden tabs carry a 0x0 `<main>` too, so scope to the active one.
function wheelOverViewer(init: { ctrlKey: boolean; deltaY: number }) {
  return browser.execute((options: { ctrlKey: boolean; deltaY: number }) => {
    const viewer = document.querySelector<HTMLElement>(
      "[data-document-session][data-active='true'] main",
    )!
    const rect = viewer.getBoundingClientRect()

    viewer.dispatchEvent(
      new WheelEvent("wheel", {
        bubbles: true,
        cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
        ctrlKey: options.ctrlKey,
        deltaY: options.deltaY,
      }),
    )
  }, init)
}

type CopyWatch = Window & { __copied?: string }

// A right-click where a reader's would land: the middle of the element, with
// the coordinates the menu anchors itself to.
function rightClick(selector: string) {
  return browser.execute((query: string) => {
    const element = document.querySelector(query)!
    const box = element.getBoundingClientRect()

    element.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        button: 2,
        cancelable: true,
        clientX: box.left + box.width / 2,
        clientY: box.top + box.height / 2,
      }),
    )
  }, selector)
}

describe("TFolio PDF viewer", () => {
  before(async () => {
    // The view mode persists, so leave it unset to start from the single view.
    await seedSettings({ ui: { language: "en" } })
    await refreshApp()
    await dropZoneButton().waitForExist()
  })

  // The page tracker revises only once a navigation's scroll has landed and a
  // frame has passed, so an early assertion would pass against the stale value.
  async function trackerSettled(mode?: "book" | "single" | "thumbnail") {
    // Until a switched-to layout mounts, the outgoing one's scroll reads as
    // settled, so `mode` first waits for that layout's own container.
    if (mode) {
      await browser.waitUntil(
        async () =>
          $(
            `[data-document-session][data-active='true'] [data-view-mode='${mode}']`,
          ).isExisting(),
        { timeout: 15_000, timeoutMsg: `the ${mode} layout never mounted` },
      )
    }

    const scrollTop = () =>
      browser.execute(
        () =>
          document.querySelector<HTMLElement>(
            "[data-document-session][data-active='true'] main",
          )!.scrollTop,
      )
    await browser.waitUntil(
      async () => {
        const first = await scrollTop()
        await browser.pause(200)
        return (await scrollTop()) === first
      },
      // A parallel run's lanes share this machine, so settling can take longer
      // than on an idle one; the state waited on is unchanged.
      { timeout: 20_000, timeoutMsg: "the viewer never stopped scrolling" },
    )
    await browser.pause(400)
  }

  // The room a fit must fill is measured off the layout, not recomputed from the
  // code's own padding, so a fit that silently stopped filling it fails here.
  const pageBox = (pageNumber = 1) =>
    browser.execute((number: number) => {
      const element = document.querySelector<HTMLElement>(
        `[data-page-number='${number}']`,
      )!
      const page = element.getBoundingClientRect()
      const column = element.parentElement!
      const padding = window.getComputedStyle(column)
      const viewer = document.querySelector<HTMLElement>(
        "[data-document-session][data-active='true'] main",
      )!

      return {
        availableHeight:
          viewer.clientHeight -
          parseFloat(padding.paddingTop) -
          parseFloat(padding.paddingBottom),
        availableWidth:
          viewer.clientWidth -
          parseFloat(padding.paddingLeft) -
          parseFloat(padding.paddingRight),
        height: Math.round(page.height),
        scrollableX: viewer.scrollWidth - viewer.clientWidth,
        width: Math.round(page.width),
      }
    }, pageNumber)

  it("starts with the isolated WDIO bridge available", async () => {
    const location = await browser.tauri.execute(() => window.location.href)

    await expect(dropZoneButton()).toExist()
    await expect(dropZoneButton()).toHaveAttribute(
      "aria-label",
      "Choose a file to open",
    )
    expect(location).toContain("tauri")
  })

  it("rejects invalid input, renders a PDF, and exercises viewer controls", async () => {
    await openPdfFromDisk("not-a-pdf.txt", Buffer.from("not a PDF", "utf8"))
    await expect($("[role='alert']")).toHaveText(
      "Please choose a PDF, image, or Word document.",
    )

    const dismissAlert = $("button[aria-label='Dismiss notification']")
    await dismissAlert.waitForDisplayed()
    await dismissAlert.click()
    await $("[role='alert']").waitForDisplayed({ reverse: true })

    // A repeated refusal gets a fresh lifetime rather than inheriting the
    // first one's nearly-expired timer, then leaves on its own.
    await openPdfFromDisk("not-a-pdf.txt", Buffer.from("not a PDF", "utf8"))
    await $("[role='alert']").waitForDisplayed()
    await browser.pause(3_000)
    await openPdfFromDisk("not-a-pdf.txt", Buffer.from("not a PDF", "utf8"))
    await browser.pause(2_500)
    await expect($("[role='alert']")).toBeDisplayed()
    await $("[role='alert']").waitForDisplayed({
      reverse: true,
      timeout: 4_000,
      timeoutMsg: "the repeated warning did not dismiss itself",
    })

    await openPdfFromDisk("one-page.pdf", minimalPdf())

    const firstPage = await $("[data-page-number='1']")
    await firstPage.waitForDisplayed()
    await expect($("[data-slot='page-status']")).toHaveAttribute(
      "aria-label",
      "Page 1 of 1",
    )

    const canvas = await firstPage.$("canvas")
    await browser.waitUntil(
      async () => Number(await canvas.getAttribute("width")) > 200,
      {
        timeout: 15_000,
        timeoutMsg: "PDF page did not finish rendering through PDFium",
      },
    )
    // The viewer debounces its render scale 150ms past the first fit, so an early
    // bitmap is far smaller than its CSS box; wait for the ratio to settle first.
    let backingPixelsPerCssPixel = 0
    await browser.waitUntil(
      async () => {
        backingPixelsPerCssPixel = (await browser.execute(() => {
          const canvas = document.querySelector<HTMLCanvasElement>(
            "[data-page-number='1'] canvas",
          )!
          const cssWidth = canvas.getBoundingClientRect().width
          return cssWidth > 0 ? canvas.width / cssWidth : 0
        })) as number
        return (
          backingPixelsPerCssPixel >= 1.24 &&
          backingPixelsPerCssPixel <= 2.01
        )
      },
      {
        timeout: 15_000,
        timeoutMsg:
          "PDF page backing-pixel ratio did not settle into [1.24, 2.01]",
      },
    )
    // Low-DPI desktops need modest supersampling for PDFium's grayscale glyph
    // edges; HiDPI displays may naturally reach the shared 2x ceiling instead.
    expect(backingPixelsPerCssPixel).toBeGreaterThanOrEqual(1.24)
    expect(backingPixelsPerCssPixel).toBeLessThanOrEqual(2.01)

    const pageInput = await $("input[aria-label='Page number']")
    await pageInput.setValue("99")
    await browser.keys("Enter")
    await expect(pageInput).toHaveValue("1")

    const bookmarksToggle = $("button[aria-label='Show bookmarks']")
    await expect(bookmarksToggle).toBeDisabled()
    await $("button[aria-label='Thumbnails']").click()
    await expect(bookmarksToggle).toBeEnabled()
    await bookmarksToggle.click()
    await expect($("nav[aria-label='Bookmarks']")).toHaveText(
      "This document has no bookmarks.",
    )
    await $("button[aria-label='Single page']").click()
    await expect(bookmarksToggle).toBeDisabled()
    await expect($("nav[aria-label='Bookmarks']")).not.toBeExisting()

    await clickAppMenuItem("settings")
    await expect($("[role='dialog']")).toBeDisplayed()

    await $("[role='tab'][aria-controls='settings-panel-about']").click()
    await expect($("#settings-panel-about")).toBeDisplayed()

    // Light then Dark: under "follow system" the app may already be dark before
    // the click, so the pair proves the toggle regardless of the OS scheme.
    await $("[role='tab'][aria-controls='settings-panel-appearance']").click()
    await $("//*[@role='radio' and normalize-space()='Light']").click()
    const isDarkAfterLight = await browser.execute(() =>
      document.documentElement.classList.contains("dark"),
    )
    expect(isDarkAfterLight).toBe(false)

    await $("//*[@role='radio' and normalize-space()='Dark']").click()
    const isDarkAfterDark = await browser.execute(() =>
      document.documentElement.classList.contains("dark"),
    )
    expect(isDarkAfterDark).toBe(true)

    await $("#settings-language").click()
    await $(
      "//*[@role='option' and normalize-space()='Simplified Chinese']",
    ).click()

    const documentLanguage = await browser.execute(
      () => document.documentElement.lang,
    )
    expect(documentLanguage).toBe("zh-CN")
  })

  it("switches between the single, book, and thumbnail views", async () => {
    // This test both asserts the single-view default and leaves a mode behind,
    // so it clears the key itself rather than leaning on the one-time `before`.
    await seedSettings({ ui: { language: "en" } })
    await refreshApp()
    await openPdfFromDisk("nine-pages.pdf", minimalPdf(9))
    await $("[data-page-number='1']").waitForDisplayed()

    const toggle = (label: string) => $(`button[aria-label='${label}']`)
    const pageInput = await $("input[aria-label='Page number']")

    await expect(toggle("Single page")).toHaveAttribute("aria-pressed", "true")
    await expect(toggle("Show bookmarks")).toBeDisabled()

    // Book view pairs from page 1, so pages 1 and 2 share a spread.
    await toggle("Book").click()
    await expect(toggle("Book")).toHaveAttribute("aria-pressed", "true")
    await expect(toggle("Show bookmarks")).toBeDisabled()
    await $("[data-page-number='2']").waitForDisplayed()

    const spread = await browser.execute(() => {
      const rowOf = (pageNumber: number) =>
        document.querySelector(`[data-page-number='${pageNumber}']`)
          ?.parentElement

      return {
        pairsFirstTwo: rowOf(1) === rowOf(2),
        startsNewRowOnThird: rowOf(1) !== rowOf(3),
        trailingRowSize: rowOf(9)?.childElementCount,
      }
    })
    expect(spread.pairsFirstTwo).toBe(true)
    expect(spread.startsNewRowOnThird).toBe(true)
    expect(spread.trailingRowSize).toBe(1)

    // Each layout stacks to a different height, and the viewer keeps its scroll
    // offset across a switch, so the reader's page has to be sought back out.
    await toggle("Single page").click()
    await pageInput.setValue("5")
    await browser.keys("Enter")
    await trackerSettled()
    await expect(pageInput).toHaveValue("5")
    await toggle("Book").click()
    await trackerSettled("book")
    await expect(pageInput).toHaveValue("5")

    // Thumbnails are an image and no selectable text layer; since M7 a click
    // selects, and it is the double-click that navigates.
    await toggle("Thumbnails").click()
    await expect(toggle("Show bookmarks")).toBeEnabled()
    await toggle("Show bookmarks").click()
    await expect($("nav[aria-label='Bookmarks']")).toBeDisplayed()
    const thirdThumbnail = await $("button[aria-label='Select page 3']")
    await thirdThumbnail.waitForDisplayed()
    await expect($$(".pdf-text-layer")).toBeElementsArrayOfSize(0)

    await browser.execute(() => {
      document
        .querySelector("button[aria-label='Select page 3']")!
        .dispatchEvent(new MouseEvent("dblclick", { bubbles: true }))
    })
    await expect(toggle("Single page")).toHaveAttribute("aria-pressed", "true")
    await expect(toggle("Show bookmarks")).toBeDisabled()
    await expect($("nav[aria-label='Bookmarks']")).not.toBeExisting()
    await expect(pageInput).toHaveValue("3")
  })

  it("turns whole pages and spreads with Page Up and Page Down at any zoom", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("page-turns.pdf", minimalPdf(8))
    await $("[data-page-number='1']").waitForDisplayed()

    // Scaled so the viewport holds more than one short page: a document turn must
    // land at the next page's top exactly, not a viewport-height scroll away.
    const zoomOut = () => $("button[aria-label='Zoom out']")

    while (await zoomOut().isEnabled()) {
      await zoomOut().click()
    }
    for (let rung = 0; rung < 5; rung += 1) {
      await $("button[aria-label='Zoom in']").click()
    }
    await expect(
      $("[data-slot='button-group'][aria-label^='Zoom ']"),
    ).toHaveAttribute("aria-label", "Zoom 75%")

    const pageInput = $("input[aria-label='Page number']")
    const focusViewerAtStart = () =>
      browser.execute(() => {
        const viewer = document.querySelector<HTMLElement>(
          "[data-document-session][data-active='true'] main",
        )!
        viewer.scrollTop = 0
        viewer.tabIndex = -1
        viewer.focus()
      })
    const pageTopInViewer = (pageNumber: number) =>
      browser.execute((number: number) => {
        const viewer = document.querySelector<HTMLElement>(
          "[data-document-session][data-active='true'] main",
        )!
        const page = document.querySelector<HTMLElement>(
          `[data-page-number='${number}']`,
        )!

        return Math.round(
          page.getBoundingClientRect().top - viewer.getBoundingClientRect().top,
        )
      }, pageNumber)
    // The embedded WebKit WebDriver passes W3C navigation-key constants through as
    // private-use characters, so the cancellable DOM key event is dispatched here.
    const pressPageKey = (key: "PageDown" | "PageUp") =>
      browser.execute((value: "PageDown" | "PageUp") => {
        const event = new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: value,
        })
        document.activeElement!.dispatchEvent(event)

        return event.defaultPrevented
      }, key)

    // The field holds the number, but what is read is the odometer over it,
    // which draws the field's value while nobody is typing into it.
    const odometer = $("[data-slot='page-odometer']")

    await focusViewerAtStart()
    await expect(pageInput).toHaveValue("1")
    await expect(odometer).toHaveText("1")
    expect(await pressPageKey("PageDown")).toBe(true)
    await expect(pageInput).toHaveValue("2")
    // Settles once the digit that was replaced has rolled out of its box.
    await expect(odometer).toHaveText("2")
    expect(await pageTopInViewer(2)).toBe(20)

    expect(await pressPageKey("PageUp")).toBe(true)
    await expect(pageInput).toHaveValue("1")
    await expect(odometer).toHaveText("1")

    await $("button[aria-label='Book']").click()
    await expect($("button[aria-label='Book']")).toHaveAttribute(
      "aria-pressed",
      "true",
    )
    await focusViewerAtStart()
    await expect(pageInput).toHaveValue("1")
    expect(await pressPageKey("PageDown")).toBe(true)
    await expect(pageInput).toHaveValue("3")
    expect(await pageTopInViewer(3)).toBe(20)

    expect(await pressPageKey("PageUp")).toBe(true)
    await expect(pageInput).toHaveValue("1")
  })

  // A case of its own rather than a coda to the one above: a reload plus a second
  // document is most of a test's time budget on its own.
  it("keeps the chosen view mode across a reload", async () => {
    await seedSettings({ ui: { language: "en" } })
    await refreshApp()
    await openPdfFromDisk("mode-kept.pdf", minimalPdf(3))
    await $("[data-page-number='1']").waitForDisplayed()

    const toggle = (label: string) => $(`button[aria-label='${label}']`)

    await toggle("Book").click()
    await expect(toggle("Book")).toHaveAttribute("aria-pressed", "true")

    // The home tab carries no view controls — it has no document to act on — so
    // it takes the next document opened to say whether the mode was kept.
    await refreshApp()
    await dropZoneButton().waitForExist()
    await openPdfFromDisk("reopened.pdf", minimalPdf(3))
    await $("[data-page-number='1']").waitForDisplayed()
    await expect(toggle("Book")).toHaveAttribute("aria-pressed", "true")
  })

  it("zooms from the toolbar and from ctrl+wheel", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("two-pages.pdf", minimalPdf(2))
    await $("[data-page-number='1']").waitForDisplayed()

    // The toolbar no longer prints the level — it flashes over the page — so the
    // group's aria-label is the readout always there to be read.
    const zoomGroup = () => $("[data-slot='button-group'][aria-label^='Zoom ']")
    const zoomLevel = async () =>
      (await zoomGroup().getAttribute("aria-label")) ?? ""
    const indicator = () =>
      $("[data-document-session][data-active='true'] [data-slot='zoom-indicator']")

    // No button names a level now, so the ladder is the only way back: out until
    // `-` gives up at the 10% floor, then in along the rungs to 100%.
    const zoomToActualSize = async () => {
      const zoomOut = () => $("button[aria-label='Zoom out']")

      while (await zoomOut().isEnabled()) {
        await zoomOut().click()
      }

      for (let rung = 0; rung < 6; rung += 1) {
        await $("button[aria-label='Zoom in']").click()
      }
    }

    expect((await pageBox()).scrollableX).toBe(0)

    // A point is 1/72 inch against a CSS pixel's 1/96, so 200pt measures 200 *
    // 96/72 on screen — point-for-pixel would be a quarter short of every reader.
    const actualSize = (percent: number) =>
      Math.round((200 * 96 * percent) / (72 * 100))

    await zoomToActualSize()
    await expect(zoomGroup()).toHaveAttribute("aria-label", "Zoom 100%")
    expect((await pageBox()).width).toBe(actualSize(100))

    await $("button[aria-label='Zoom in']").click()
    await expect(zoomGroup()).toHaveAttribute("aria-label", "Zoom 125%")
    expect((await pageBox()).width).toBe(actualSize(125))

    await $("button[aria-label='Zoom out']").click()
    await $("button[aria-label='Zoom out']").click()
    await expect(zoomGroup()).toHaveAttribute("aria-label", "Zoom 75%")
    expect((await pageBox()).width).toBe(actualSize(75))

    // The zooms above left a flash of their own on screen, and a HUD already up
    // would let the poll below settle on it instead of on the press it makes.
    await expect(indicator()).toHaveAttribute("data-visible", "false")

    // The flash is shorter than a WebDriver round trip, so press and read happen
    // together in the page; only the fade is slow enough to assert from out here.
    const flashed = (await browser.executeAsync((done) => {
      const hud = document.querySelector<HTMLElement>(
        "[data-document-session][data-active='true'] [data-slot='zoom-indicator']",
      )!
      document
        .querySelector<HTMLButtonElement>("button[aria-label='Zoom in']")!
        .click()
      const deadline = performance.now() + 500

      const read = () =>
        done({
          opacity: window.getComputedStyle(hud).opacity,
          text: hud.textContent ?? "",
          visible: hud.dataset.visible ?? "",
        })

      const poll = () => {
        if (performance.now() > deadline) {
          read()
          return
        }

        // One frame after the flag turns: a transition queried on the very frame
        // its class lands still reports the level it is coming from.
        if (hud.dataset.visible === "true") {
          requestAnimationFrame(read)
          return
        }

        requestAnimationFrame(poll)
      }

      requestAnimationFrame(poll)
    })) as { opacity: string; text: string; visible: string }

    expect(flashed.visible).toBe("true")
    expect(flashed.text).toBe("100%")
    expect(Number(flashed.opacity)).toBeGreaterThan(0)
    await expect(indicator()).toHaveAttribute("data-visible", "false")

    // A fit takes the tighter dimension — height, for a portrait page in a
    // landscape window — and must actually fit, padding aside.
    await $("button[aria-label='Fit page']").click()
    const fittedPage = await pageBox()
    expect(fittedPage.height).toBe(Math.round(fittedPage.availableHeight))
    expect(fittedPage.width).toBeLessThanOrEqual(
      Math.round(fittedPage.availableWidth),
    )

    // The button offers the fit that is not on, and which one *is* on is said by
    // the group rather than by a pressed state that would contradict that name.
    await expect($("button[aria-label='Fit width']")).toBeExisting()
    await expect(zoomGroup()).toHaveAttribute(
      "aria-label",
      expect.stringContaining("fitting the page"),
    )

    await $("button[aria-label='Fit width']").click()
    const fittedWide = await pageBox()
    expect(fittedWide.width).toBe(Math.round(fittedWide.availableWidth))

    // Fit width is now active, so the button offers fit page while retaining
    // the selected fill. Its outer edge must stay visible in the joined group.
    const fitButtonBorder = await browser.execute(() => {
      const button = document.querySelector<HTMLButtonElement>(
        "button[aria-label='Fit page']",
      )!
      const style = window.getComputedStyle(button)

      return {
        color: style.borderTopColor,
        style: style.borderTopStyle,
        width: style.borderTopWidth,
      }
    })
    expect(fitButtonBorder.width).not.toBe("0px")
    expect(fitButtonBorder.style).not.toBe("none")
    expect(["transparent", "rgba(0, 0, 0, 0)"]).not.toContain(
      fitButtonBorder.color,
    )

    await zoomToActualSize()
    await expect(zoomGroup()).toHaveAttribute("aria-label", "Zoom 100%")
    const widthBeforePreview = (await pageBox()).width
    const preview = (await browser.executeAsync((done) => {
      const viewer = document.querySelector<HTMLElement>(
        "[data-document-session][data-active='true'] main",
      )!
      const rect = viewer.getBoundingClientRect()
      let remaining = 8

      const tick = () => {
        viewer.dispatchEvent(
          new WheelEvent("wheel", {
            bubbles: true,
            cancelable: true,
            clientX: rect.left + rect.width / 2,
            clientY: rect.top + rect.height / 2,
            ctrlKey: true,
            deltaY: -12,
          }),
        )
        remaining -= 1

        if (remaining > 0) {
          requestAnimationFrame(tick)
          return
        }

        // The app consumes the last wheel in its own next animation frame.
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            const layout = document.querySelector<HTMLElement>(
              "[data-pdf-viewer-layout]",
            )!
            done({
              layoutTransform: layout.style.transform,
              pageWidth: document.querySelector<HTMLElement>(
                "[data-page-number='1']",
              )!.offsetWidth,
              zoomText:
                document
                  .querySelector<HTMLElement>(
                    "[data-slot='button-group'][aria-label^='Zoom ']",
                  )!
                  .getAttribute("aria-label") ?? "",
            })
          }),
        )
      }

      requestAnimationFrame(tick)
    })) as { layoutTransform: string; pageWidth: number; zoomText: string }

    // The burst is one compositor transform. React page boxes and the toolbar
    // stay at the committed scale until the viewer-level settle timer fires.
    expect(preview.layoutTransform).toContain("scale(")
    expect(preview.pageWidth).toBe(widthBeforePreview)
    expect(preview.zoomText).toBe("Zoom 100%")

    await browser.waitUntil(async () => (await zoomLevel()) !== "Zoom 100%", {
      timeout: 5_000,
      timeoutMsg: "ctrl+wheel did not zoom",
    })

    const committedPreview = await browser.execute(() => ({
      layoutTransform: document.querySelector<HTMLElement>(
        "[data-pdf-viewer-layout]",
      )!.style.transform,
      pageWidth: document.querySelector<HTMLElement>(
        "[data-page-number='1']",
      )!.offsetWidth,
    }))
    expect(committedPreview.layoutTransform).toBe("")
    expect(committedPreview.pageWidth).toBeGreaterThan(widthBeforePreview)

    // The flash starts at the commit and is gone before a round trip could look,
    // so an observer latches it; a HUD still up never re-fires, so it fades first.
    await expect(indicator()).toHaveAttribute("data-visible", "false")
    await browser.execute(() => {
      const hud = document.querySelector<HTMLElement>(
        "[data-document-session][data-active='true'] [data-slot='zoom-indicator']",
      )!
      const window_ = window as unknown as { __hudFlashed?: boolean }
      window_.__hudFlashed = false
      new MutationObserver(() => {
        if (hud.dataset.visible === "true") {
          window_.__hudFlashed = true
        }
      }).observe(hud, { attributeFilter: ["data-visible"] })
    })

    const scrolledPreview = (await browser.executeAsync((done) => {
      const viewer = document.querySelector<HTMLElement>(
        "[data-document-session][data-active='true'] main",
      )!
      const viewerRect = viewer.getBoundingClientRect()

      viewer.dispatchEvent(
        new WheelEvent("wheel", {
          bubbles: true,
          cancelable: true,
          clientX: viewerRect.left + viewerRect.width / 2,
          clientY: viewerRect.top + viewerRect.height / 2,
          ctrlKey: true,
          deltaY: -60,
        }),
      )

      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const layout = document.querySelector<HTMLElement>(
            "[data-pdf-viewer-layout]",
          )!
          const page = document.querySelector<HTMLElement>(
            "[data-page-number='1']",
          )!
          const topBeforeScroll = page.getBoundingClientRect().top
          viewer.scrollTop = Math.min(
            viewer.scrollTop + 80,
            viewer.scrollHeight - viewer.clientHeight,
          )

          done({
            layoutTransform: layout.style.transform,
            pageTopAfterScroll: page.getBoundingClientRect().top,
            scrollMovement: topBeforeScroll - page.getBoundingClientRect().top,
          })
        }),
      )
    })) as {
      layoutTransform: string
      pageTopAfterScroll: number
      scrollMovement: number
    }
    expect(scrolledPreview.layoutTransform).toContain("scale(")
    expect(scrolledPreview.scrollMovement).toBeGreaterThan(40)

    await browser.waitUntil(
      () =>
        browser.execute(
          () =>
            document.querySelector<HTMLElement>("[data-pdf-viewer-layout]")!
              .style.transform === "",
        ),
      { timeout: 5_000, timeoutMsg: "scroll did not settle the zoom preview" },
    )
    expect(
      await browser.execute(
        () => (window as unknown as { __hudFlashed?: boolean }).__hudFlashed,
      ),
    ).toBe(true)
    const pageTopAfterCommit = await browser.execute(
      () =>
        document
          .querySelector<HTMLElement>("[data-page-number='1']")!
          .getBoundingClientRect().top,
    )
    // The compositor scales the fixed gap too, which the committed layout does
    // not; allow that sub-5px reconciliation, not the ~80px snap-back regression.
    expect(
      Math.abs(pageTopAfterCommit - scrolledPreview.pageTopAfterScroll),
    ).toBeLessThan(5)

    const zoomed = await zoomLevel()
    await wheelOverViewer({ ctrlKey: false, deltaY: -300 })
    await browser.pause(500)
    await expect(zoomGroup()).toHaveAttribute("aria-label", zoomed)

    // The thumbnail grid has one width for every page and so no single scale to
    // report; the controls go away rather than sit there showing a stale figure.
    await $("button[aria-label='Thumbnails']").click()
    await $("button[aria-label='Select page 1']").waitForDisplayed()
    await expect($("button[aria-label='Zoom in']")).not.toBeExisting()
    await expect(zoomGroup()).not.toBeExisting()

    await $("button[aria-label='Single page']").click()
    await expect(zoomGroup()).toHaveAttribute("aria-label", zoomed)
  })

  // A fit is of the page the reader is on: in a document of two page sizes, the
  // odd landscape page must be measured as itself, not the usual portrait size.
  it("fits the page the reader is on, not the document's usual page", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk(
      "mixed.pdf",
      minimalPdf(6, (index) => (index === 3 ? "0 0 400 200" : "0 0 200 300")),
    )
    await $("[data-page-number='1']").waitForDisplayed()

    await $("button[aria-label='Fit page']").click()
    const portrait = await pageBox(1)
    expect(portrait.height).toBe(Math.round(portrait.availableHeight))

    const pageInput = await $("input[aria-label='Page number']")
    await pageInput.setValue("4")
    await browser.keys("Enter")
    // The tracker revises the page only once the scroll lands, and the fit is
    // measured from whatever it reports when the button is pressed.
    await trackerSettled()
    await expect(pageInput).toHaveValue("4")

    await $("button[aria-label='Fit width']").click()
    const landscape = await pageBox(4)
    expect(landscape.width).toBe(Math.round(landscape.availableWidth))
    expect(landscape.height).toBeLessThanOrEqual(
      Math.round(landscape.availableHeight),
    )
  })

  // The OS window cannot be resized here — `setWindowRect` is accepted and does
  // nothing — so the root box narrows instead, firing the same resize callback.
  it("holds the reading position when the viewport changes width", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("resized.pdf", minimalPdf(12))
    await $("[data-page-number='1']").waitForDisplayed()

    // Fit width is where the drift is worst and a mode readers sit in. The button
    // cycles fit-page first, so reaching fit width takes both rungs.
    await $("button[aria-label='Fit page']").click()
    await $("button[aria-label='Fit width']").click()

    const readingLine = () =>
      browser.execute(() => {
        const viewer = document.querySelector<HTMLElement>(
          "[data-document-session][data-active='true'] main",
        )!
        const top = viewer.getBoundingClientRect().top

        for (const element of viewer.querySelectorAll<HTMLElement>(
          "[data-page-number]",
        )) {
          const rect = element.getBoundingClientRect()

          if (rect.bottom > top + 1) {
            return {
              at:
                Number(element.dataset.pageNumber) +
                (top - rect.top) / rect.height,
              pageWidth: Math.round(rect.width),
            }
          }
        }

        return { at: 0, pageWidth: 0 }
      })

    const setAppWidth = (width: number | null) =>
      browser.execute((value: number | null) => {
        document.body.style.width = value === null ? "" : `${value}px`
      }, width)

    await browser.execute(() => {
      const viewer = document.querySelector<HTMLElement>(
        "[data-document-session][data-active='true'] main",
      )!
      viewer.scrollTop = Math.round(viewer.scrollHeight * 0.35)
    })
    // The report follows the scroll by a few frames, so wait for the tracker's
    // own output to stop moving before the resize lands.
    const pageInput = await $("input[aria-label='Page number']")
    await browser.waitUntil(
      async () => {
        const reported = await pageInput.getValue()
        await browser.pause(200)
        return (
          (await pageInput.getValue()) === reported &&
          Number(reported) > 1
        )
      },
      {
        timeout: 5_000,
        timeoutMsg: "the tracker never settled on the scrolled-to page",
      },
    )

    const before = await readingLine()
    expect(before.at).toBeGreaterThan(1)

    await setAppWidth(900)
    await browser.waitUntil(
      async () => (await readingLine()).pageWidth < before.pageWidth,
      {
        timeout: 5_000,
        timeoutMsg: "a narrower viewport never re-fitted the pages",
      },
    )
    await browser.pause(300)

    const narrowed = await readingLine()
    // A fifth of the width gone: the pages really were laid out again, so the
    // position below is a position across two different layouts.
    expect(narrowed.pageWidth).toBeLessThan(before.pageWidth)
    // A fiftieth of a page — before the anchor this drifted by a third of one.
    expect(Math.abs(narrowed.at - before.at)).toBeLessThan(0.02)

    await setAppWidth(null)
    await browser.waitUntil(
      async () => (await readingLine()).pageWidth === before.pageWidth,
      {
        timeout: 5_000,
        timeoutMsg: "the restored viewport never re-fitted the pages",
      },
    )
    await browser.pause(300)

    const restored = await readingLine()
    expect(Math.abs(restored.at - before.at)).toBeLessThan(0.02)
  })

  it("keeps only near-viewport full-page surfaces mounted", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("forty-pages.pdf", minimalPdf(40))
    await $("[data-page-number='1'] canvas").waitForExist()

    const initialSurfaces = await browser.execute(() => ({
      canvases: document.querySelectorAll("[data-page-number] canvas").length,
      pages: document.querySelectorAll("[data-page-number]").length,
    }))
    expect(initialSurfaces.pages).toBe(40)
    expect(initialSurfaces.canvases).toBeLessThan(initialSurfaces.pages)

    const pageInput = await $("input[aria-label='Page number']")
    await pageInput.setValue("40")
    await browser.keys("Enter")
    await $("[data-page-number='40'] canvas").waitForExist({ timeout: 10_000 })
    await browser.waitUntil(
      () =>
        browser.execute(
          () => !document.querySelector("[data-page-number='1'] canvas"),
        ),
      {
        timeout: 10_000,
        timeoutMsg: "the offscreen first-page surface was not evicted",
      },
    )

    const finalSurfaces = await browser.execute(() => ({
      canvases: document.querySelectorAll("[data-page-number] canvas").length,
      pages: document.querySelectorAll("[data-page-number]").length,
    }))
    expect(finalSurfaces.pages).toBe(40)
    expect(finalSurfaces.canvases).toBeLessThan(finalSurfaces.pages)
  })

  // Landscape rows are a fraction of a page's height, so tracking must not assume
  // a row is tall enough to reach some fixed depth — the report would run ahead.
  it("stays on the requested page in a grid of landscape pages", async () => {
    await seedSettings({ ui: { language: "en" } })
    await refreshApp()
    await openPdfFromDisk("landscape.pdf", minimalPdf(40, "0 0 300 200"))
    await $("[data-page-number='1']").waitForDisplayed()

    await $("button[aria-label='Thumbnails']").click()
    await $("button[aria-label='Select page 1']").waitForDisplayed()

    // The grid fits as many columns as the window allows, so derive a page that
    // really does start a row rather than hard-coding one.
    const columns = await browser.execute(() => {
      const cellTop = (pageNumber: number) =>
        document
          .querySelector(`[data-page-number='${pageNumber}']`)!
          .getBoundingClientRect().top
      const firstTop = cellTop(1)
      let count = 0

      for (let pageNumber = 1; pageNumber <= 40; pageNumber += 1) {
        if (Math.abs(cellTop(pageNumber) - firstTop) < 1) count += 1
      }

      return count
    })

    const target = String(1 + columns * 3) // leftmost cell of the fourth row
    const pageInput = await $("input[aria-label='Page number']")

    await pageInput.setValue(target)
    await browser.keys("Enter")
    await trackerSettled()
    await expect(pageInput).toHaveValue(target)
  })

  // The WebView's own menu is the browser's over a page of a PDF, so only a typed
  // field keeps it; dispatchEvent reports the app's real listener's cancellation.
  it("drops the WebView's context menu away from a text field", async () => {
    await seedSettings({ ui: { language: "en" } })
    await refreshApp()
    await openPdfFromDisk("one-page.pdf", minimalPdf())
    await $("[data-page-number='1']").waitForDisplayed()

    const prevented = await browser.execute(() => {
      const rightClick = (selector: string) =>
        !document.querySelector(selector)!.dispatchEvent(
          new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
        )

      return {
        input: rightClick("input[aria-label='Page number']"),
        page: rightClick("[data-page-number='1']"),
        toolbar: rightClick("[data-slot='page-status']"),
      }
    })

    expect(prevented).toEqual({ input: false, page: true, toolbar: true })
  })
  // readText is refused and the driver's keys are events, not native input, so
  // the clipboard cannot be read: the real writeText is wrapped and awaited instead.
  it("copies selected page text from a menu of its own", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("text.pdf", textPdf())
    await $(".pdf-text-layer span").waitForDisplayed({ timeout: 15_000 })

    await browser.execute(() => {
      const clipboard = navigator.clipboard
      const write = clipboard.writeText.bind(clipboard)
      const watched = window as CopyWatch

      watched.__copied = "not called"
      clipboard.writeText = (text: string) => {
        watched.__copied = "pending"

        return write(text).then(
          () => {
            watched.__copied = text
          },
          (error: unknown) => {
            watched.__copied = `refused: ${String(error)}`

            throw error
          },
        )
      }
    })

    // Nothing selected: the menu would have no entry to show, so the
    // right-click opens nothing at all rather than an empty popup.
    await rightClick(".pdf-text-layer span")
    await browser.pause(500)
    await expect($("[data-slot='context-menu-content']")).not.toExist()

    const selected = await browser.execute(() => {
      const span = document.querySelector(".pdf-text-layer span")!
      const range = document.createRange()
      const selection = window.getSelection()!

      range.selectNodeContents(span)
      selection.removeAllRanges()
      selection.addRange(range)

      return span.textContent
    })
    expect(selected).toContain("Highlight")

    await rightClick(".pdf-text-layer span")

    const copyItem = await $("[data-action='copy-text']")
    await copyItem.waitForDisplayed({ timeout: 15_000 })
    await expect(copyItem).toHaveText("Copy")
    await copyItem.click()
    await expect($("[data-slot='context-menu-content']")).not.toExist()

    await browser.waitUntil(
      async () =>
        (await browser.execute(() => (window as CopyWatch).__copied)) ===
        selected,
      {
        timeout: 10_000,
        timeoutMsg: "the selected text never reached the clipboard",
      },
    )
  })
})
