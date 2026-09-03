import { $, $$, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  clickAppMenuItem,
  dropZoneButton,
  minimalPdf,
  openPdfFromDisk,
  seedSettings,
  textPdf,
} from "./helpers"

// Every workspace panel carries a `<main>`, the home tab's included, and all but
// the showing one are `hidden` — which measures 0x0. A viewer read for its
// geometry, or dispatched an event, has to be the active document's; the
// selector is repeated inline because these run in the app's own context.
//
// The zoom listener is bound natively and non-passively, so a wheel has to be
// dispatched as a real event rather than through WebDriver's scroll action.
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

/** Where the copy test parks the outcome of the page's real clipboard call. */
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
    await browser.refresh()
    await dropZoneButton().waitForExist()
  })

  // The room a fit has to fill is measured off the layout itself rather than
  // recomputed from the padding the code already uses, so that a fit which
  // silently stopped filling it would fail here.
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
      "Choose a PDF file",
    )
    expect(location).toContain("tauri")
  })

  it("rejects invalid input, renders a PDF, and exercises viewer controls", async () => {
    // A real file on disk whose path fails the PDF check at the boundary.
    await openPdfFromDisk("not-a-pdf.txt", Buffer.from("not a PDF", "utf8"))
    await expect($("[role='alert']")).toHaveText("Please choose a PDF file.")

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
    // The viewer debounces the render scale for 150ms after the first fit, so an
    // early bitmap renders at the boot-time MIN_ZOOM of 0.25 before the settled
    // fit redraws it. That transient bitmap is far smaller than its CSS box, so
    // its backing-pixel ratio would fall well outside the bounds below; wait for
    // the ratio to settle into that band before asserting it.
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

    // The About section preserves the existing application information.
    await $("[role='tab'][aria-controls='settings-panel-about']").click()
    await expect($("#settings-panel-about")).toBeDisplayed()

    // The Appearance section switches the color theme. Selecting Light then Dark
    // proves the toggle works regardless of the operating system's default scheme
    // (under "follow system" the app may already be dark before the click).
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

    // …and the interface language.
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
    await browser.refresh()
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
        // The trailing odd page keeps the left cell, alone in its row.
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
    await browser.pause(1500)
    await expect(pageInput).toHaveValue("5")
    await toggle("Book").click()
    // Give the page tracker time to settle. It only revises the current page
    // once the new layout has mounted, so asserting right away would pass
    // against the stale value before the layout can strand it.
    await browser.pause(1500)
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

    // Double-clicking one drops back into the single view at that page.
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

  // A case of its own rather than a coda to the one above: a reload plus a second
  // document is most of a test's time budget on its own.
  it("keeps the chosen view mode across a reload", async () => {
    await seedSettings({ ui: { language: "en" } })
    await browser.refresh()
    await openPdfFromDisk("mode-kept.pdf", minimalPdf(3))
    await $("[data-page-number='1']").waitForDisplayed()

    const toggle = (label: string) => $(`button[aria-label='${label}']`)

    await toggle("Book").click()
    await expect(toggle("Book")).toHaveAttribute("aria-pressed", "true")

    // The home tab carries no view controls — it has no document to act on — so
    // it takes the next document opened to say whether the mode was kept.
    await browser.refresh()
    await dropZoneButton().waitForExist()
    await openPdfFromDisk("reopened.pdf", minimalPdf(3))
    await $("[data-page-number='1']").waitForDisplayed()
    await expect(toggle("Book")).toHaveAttribute("aria-pressed", "true")
  })

  it("zooms from the toolbar and from ctrl+wheel", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await browser.refresh()
    await openPdfFromDisk("two-pages.pdf", minimalPdf(2))
    await $("[data-page-number='1']").waitForDisplayed()

    // The toolbar no longer prints the level anywhere — it flashes over the
    // page instead — so the group's own name is the readout that is always
    // there to be read.
    const zoomGroup = () => $("[data-slot='button-group'][aria-label^='Zoom ']")
    const zoomLevel = async () =>
      (await zoomGroup().getAttribute("aria-label")) ?? ""
    const indicator = () =>
      $("[data-document-session][data-active='true'] [data-slot='zoom-indicator']")

    // The rung ladder is the only way back to a known level now that no button
    // names one: out until `-` gives up at the 25% floor, then in along
    // `zoomSteps` — 50, 75, 100.
    const zoomToActualSize = async () => {
      const zoomOut = () => $("button[aria-label='Zoom out']")

      while (await zoomOut().isEnabled()) {
        await zoomOut().click()
      }

      for (let rung = 0; rung < 3; rung += 1) {
        await $("button[aria-label='Zoom in']").click()
      }
    }

    // A document opens sized to be read, never already scrolled sideways.
    expect((await pageBox()).scrollableX).toBe(0)

    // Actual size is the page's paper size: a point is 1/72 inch against a CSS
    // pixel's 1/96, so the 200pt media box measures 200 * 96/72 on screen. A
    // point-for-pixel 200 here would be a quarter short of every other reader.
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

    // What the reader actually sees a press answer with. The flash is shorter
    // than a WebDriver round trip can be relied on to be, so the press and the
    // read happen together in the page; only the fade is slow enough to assert
    // from out here.
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

        // One frame after the flag turns, so the opacity read is a frame of the
        // fade rather than its starting value — a transition queried on the very
        // frame its class lands still reports the level it is coming from.
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

    // Each fit has to actually fit, padding aside — the whole point of the two.
    // A fit page takes the tighter dimension, which for this portrait page in a
    // landscape window is the height, and leaves the other one inside the column.
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

    // Ctrl+wheel zooms; the same wheel without it is an ordinary scroll.
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

    // A pinch answers with the level too, once it settles — the toolbar has no
    // figure left to read it off. Latched by an observer armed before the
    // gesture, because the flash starts at the commit and is gone again long
    // before a round trip could go and look for it. The burst above left a
    // flash of its own, and it has to fade first: a HUD still up when the next
    // commit lands never changes the attribute the observer is watching.
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
    // The compositor also scales the fixed page gap/padding while the committed
    // layout deliberately does not. Allow that sub-5px reconciliation, but not
    // the ~80px snap-back this regression produced before scroll rebasing.
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

    // Leaving the grid brings them back, still at the zoom they were left at.
    await $("button[aria-label='Single page']").click()
    await expect(zoomGroup()).toHaveAttribute("aria-label", zoomed)
  })

  // A fit is of *the page*, and in a document of two page sizes that means the
  // one the reader is on. Standing on the odd landscape page and asking for a
  // fit must measure that page, not the portrait size the document is mostly
  // made of — which is still what the opening zoom and the spread column go on.
  it("fits the page the reader is on, not the document's usual page", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await browser.refresh()
    await openPdfFromDisk(
      "mixed.pdf",
      minimalPdf(6, (index) => (index === 3 ? "0 0 400 200" : "0 0 200 300")),
    )
    await $("[data-page-number='1']").waitForDisplayed()

    // Page 1 is portrait in a window wider than it is tall, so its fit is the
    // one the height gives.
    await $("button[aria-label='Fit page']").click()
    const portrait = await pageBox(1)
    expect(portrait.height).toBe(Math.round(portrait.availableHeight))

    // Page 4 is the landscape one, and wide enough that its fit is the width's.
    // Measured against the document's usual page it would come out at more than
    // twice the column and hang out of it.
    const pageInput = await $("input[aria-label='Page number']")
    await pageInput.setValue("4")
    await browser.keys("Enter")
    // The tracker revises the page only once the scroll lands, and the fit is
    // measured from whatever it reports when the button is pressed.
    await browser.pause(1500)
    await expect(pageInput).toHaveValue("4")

    await $("button[aria-label='Fit width']").click()
    const landscape = await pageBox(4)
    expect(landscape.width).toBe(Math.round(landscape.availableWidth))
    expect(landscape.height).toBeLessThanOrEqual(
      Math.round(landscape.availableHeight),
    )
  })

  // A viewport dragged sideways re-fits every page, and the scroll offset the
  // browser keeps is a count of pixels — so without an anchor the document
  // slides vertically under a change the reader asked for horizontally.
  //
  // The OS window cannot be resized from here: the embedded WebDriver bridge
  // has no window-rect command (a `setWindowRect` is accepted and does
  // nothing). Narrowing the app's own root box instead reaches the viewer as
  // exactly the ResizeObserver callback a window resize delivers.
  it("holds the reading position when the viewport changes width", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await browser.refresh()
    await openPdfFromDisk("resized.pdf", minimalPdf(12))
    await $("[data-page-number='1']").waitForDisplayed()

    // Fit width ties the page scale to the viewer's width, so it is where the
    // drift is worst — and it is a mode readers sit in. The button cycles, and
    // it offers fit-page first, so reaching fit width takes both rungs.
    await $("button[aria-label='Fit page']").click()
    await $("button[aria-label='Fit width']").click()

    // Where the top edge of the viewer — everything above it read, everything
    // below still to come — falls in the document, measured in pages so that it
    // means the same thing at any scale.
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
    // The anchor is taken on the page the tracker reports, which follows a
    // scroll a frame later.
    await browser.pause(500)

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
    await browser.refresh()
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

  // Landscape thumbnail rows are a fraction of a page's height. Page tracking
  // must not assume a row is tall enough to reach some fixed depth down the
  // viewer, or navigation lands on a row and the tracker reports a later one.
  it("stays on the requested page in a grid of landscape pages", async () => {
    await seedSettings({ ui: { language: "en" } })
    await browser.refresh()
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
    // Let the tracker settle: it revises the page only after the scroll lands,
    // so asserting straight away would pass against the pre-scroll value.
    await browser.pause(1500)
    await expect(pageInput).toHaveValue(target)
  })

  // The WebView's own context menu is the browser's — reload, back, view
  // source over a page of a PDF — so only a field being typed in keeps it.
  // `dispatchEvent` reports the cancellation, so this reads the app's real
  // listener rather than a stand-in for it.
  it("drops the WebView's context menu away from a text field", async () => {
    await seedSettings({ ui: { language: "en" } })
    await browser.refresh()
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
  // What stands in for the menu the last test drops: over selected page text
  // the app opens one of its own, and its copy hands that text to the WebView's
  // clipboard. The clipboard cannot be read back here — `readText` is refused
  // and this driver's keys reach the page as events, not as native input, so no
  // paste happens — so the assertion wraps the real call and waits on the real
  // promise instead of replacing either.
  it("copies selected page text from a menu of its own", async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await browser.refresh()
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
