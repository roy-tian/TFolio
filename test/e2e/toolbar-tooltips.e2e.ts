import { readFileSync } from "node:fs"

import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  activeSidebar,
  minimalPdf,
  openPdfFromDisk,
  refreshApp,
  seedSettings,
  tooltipOn,
  tooltipOpen,
} from "./helpers"

// WebKitGTK's embedded WebDriver does not emit Base UI's mouseenter sequence
// for moveTo(), so exercise the same accessible tooltip through keyboard focus.
async function focusToolbarControl(label: string) {
  const control = $(`button[aria-label='${label}']`)
  await control.waitForDisplayed()
  await browser.execute((ariaLabel: string) => {
    const target = Array.from(
      document.querySelectorAll<HTMLElement>("button[aria-label]"),
    ).find((element) => element.getAttribute("aria-label") === ariaLabel)

    target?.focus()
  }, label)

  return control
}

async function expectShadcnTooltip(label: string) {
  const control = await focusToolbarControl(label)
  expect(await control.getAttribute("title")).toBeNull()

  const tooltip = $(
    `//*[@data-slot='tooltip-content' and normalize-space(.)='${label}']`,
  )
  await tooltip.waitForDisplayed()

  return control
}

// Every style rule's selector and media rule's condition the app ships,
// nested rules included.
async function shippedRules() {
  return browser.execute(() => {
    const selectors: string[] = []
    const media: string[] = []
    const walk = (rules: CSSRuleList) => {
      for (const rule of rules) {
        if (rule instanceof CSSStyleRule) selectors.push(rule.selectorText)
        if (rule instanceof CSSMediaRule) media.push(rule.conditionText)
        if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules)
      }
    }

    for (const sheet of document.styleSheets) walk(sheet.cssRules)

    return { media, selectors }
  })
}

async function shippedSelectors() {
  return (await shippedRules()).selectors
}

/** Whether a combinator after a `:has()` reaches any element at all, as in
    `:has(…) *` (group-has-*) or `:has(…) ~ *` (peer-has-*). */
function hasOverEveryElement(selector: string) {
  for (let start = selector.indexOf(":has("); start >= 0; start = selector.indexOf(":has(", start + 1)) {
    let index = start + ":has(".length

    // Bounded, and skipping escapes: an escaped class such as `.w-\(--x\)`
    // or a parenthesis in an attribute string would otherwise never balance.
    for (let level = 1; level > 0 && index < selector.length; index += 1) {
      if (selector[index] === "\\") index += 1
      else if (selector[index] === "(") level += 1
      else if (selector[index] === ")") level -= 1
    }

    if (/^(?:\s*[>~+]\s*|\s+)\*/.test(selector.slice(index))) return true
  }

  return false
}

/** Whether a combinator after `:focus-within` reaches any element at all, as
    in `:focus-within *` (group-focus-within-*) or `:focus-within ~ *`. */
function focusWithinOverEveryElement(selector: string) {
  return /:focus-within(?:\s*[>~+]\s*|\s+)\*/.test(selector)
}

/** The argument of every `name(` in `selector`, its parentheses balanced. */
function pseudoArguments(selector: string, name: string) {
  const found: string[] = []
  const token = `${name}(`
  let quote: string | null = null

  for (let start = 0; start < selector.length; start += 1) {
    const char = selector[start]

    if (char === "\\") {
      start += 1
      continue
    }

    if (quote) {
      if (char === quote) quote = null
      continue
    }

    if (char === "\"" || char === "'") {
      quote = char
      continue
    }

    if (!selector.startsWith(token, start)) continue

    const from = start + token.length
    let index = from
    let innerQuote: string | null = null
    let level = 1

    for (; level > 0 && index < selector.length; index += 1) {
      const next = selector[index]

      if (next === "\\") index += 1
      else if (innerQuote) {
        if (next === innerQuote) innerQuote = null
      } else if (next === "\"" || next === "'") innerQuote = next
      else if (next === "(") level += 1
      else if (next === ")") level -= 1
    }

    if (level === 0) found.push(selector.slice(from, index - 1))
  }

  return found
}

/** Whether a `:has()` holds a combinator inside `:is()` or `:where()`, as
    Tailwind's `has-[a_b]` compiles to `:has(:is(a b))`. */
function hasCombinatorThroughIs(selector: string) {
  return pseudoArguments(selector, ":has").some((argument) =>
    [...pseudoArguments(argument, ":is"), ...pseudoArguments(argument, ":where")].some((inner) =>
      // Attribute values may hold spaces, `~`, and brackets; a comma's space is no combinator.
      /[^\s,]\s*[>~+]|[^\s,]\s+[^\s,]/.test(
        inner.replace(/\[(?:\\.|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\]\\])*\]/g, "[]").trim(),
      ),
    ),
  )
}

describe("TFolio toolbar tooltips", () => {
  before(async () => {
    await seedSettings({ ui: { language: "zh-CN", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("toolbar-tooltips.pdf", minimalPdf(2))
    await $("[data-page-number='1']").waitForDisplayed()
  })

  it("uses shadcn tooltips and the complete Chinese view labels", async () => {
    const menu = await expectShadcnTooltip("菜单")
    await menu.click()
    const newItem = $("[data-action='new']")
    await newItem.waitForDisplayed()
    await browser.keys("Escape")
    await newItem.waitForDisplayed({ reverse: true })

    for (const label of ["单页视图", "书籍视图"]) {
      await expectShadcnTooltip(label)
    }

    const highlightOptions = await expectShadcnTooltip("高亮设置")
    await highlightOptions.click()
    await expect($("#highlight-color-label")).toHaveText("高亮颜色")
  })

  it("names the shown sidebar panel in a tooltip only once its word is cut short", async () => {
    const switcher = `${activeSidebar} [data-slot='sidebar-panel-switch']`
    const focus = async (maxWidth: string) => {
      await browser.execute(
        (css: string, width: string) => {
          const item = document.querySelector<HTMLElement>(css)!

          item.blur()
          item.style.maxWidth = width
        },
        switcher,
        maxWidth,
      )
      // The control eases from one width to the next, and what its word has
      // room for is read as the focus lands.
      await browser.pause(300)
      await browser.execute((css: string) => document.querySelector<HTMLElement>(css)!.focus(), switcher)
    }

    // Whole, the word is all a tooltip would say, over the panel's own bar.
    await focus("")
    await browser.pause(500)
    expect(await tooltipOpen(switcher)).toBe(false)

    // Narrowed past its word, as a long language's can be at the opening width.
    await focus("72px")
    await browser.waitUntil(() => tooltipOpen(switcher), {
      timeout: 5_000,
      timeoutMsg: "the cut-short panel name never opened its tooltip",
    })
    await focus("")
    await browser.execute((css: string) => document.querySelector<HTMLElement>(css)!.blur(), switcher)
  })

  it("folds the layer buttons' words while the title bar cannot hold them", async () => {
    const watermark = $("[data-slot='toolbar'] button[aria-label='水印']")
    // What the bar's parts take as they stand, against the room it has.
    const room = () =>
      browser.execute(() => {
        const bar = document.querySelector<HTMLElement>("[data-slot='toolbar']")!
        const style = getComputedStyle(bar)
        const parts = [...bar.children] as HTMLElement[]

        return {
          have: bar.clientWidth,
          need:
            parseFloat(style.paddingLeft) +
            parseFloat(style.paddingRight) +
            parseFloat(style.columnGap) * (parts.length - 1) +
            parts.reduce((sum, part) => sum + part.scrollWidth, 0),
        }
      })
    // The window itself cannot be resized from here, so the bar's right edge
    // comes in instead, or goes back.
    const pullRightEdge = (by: number | null) =>
      browser.execute((px: number | null) => {
        document.querySelector<HTMLElement>("[data-slot='toolbar']")!.style.right =
          px === null ? "" : `${px}px`
      }, by)

    const labelled = await watermark.getSize("width")
    expect(labelled).toBeGreaterThan(28)

    // Ten pixels short of what every word needs.
    const unfolded = await room()
    await pullRightEdge(unfolded.have - unfolded.need + 10)
    try {
      await browser.waitUntil(async () => (await watermark.getSize("width")) === 28, {
        timeout: 5_000,
        timeoutMsg: "the words never folded in a bar too narrow for them",
      })
      const folded = await room()
      expect(folded.need).toBeLessThanOrEqual(folded.have)
    } finally {
      // A failure here must not leave later tests a narrowed bar.
      await pullRightEdge(null)
    }
    await browser.waitUntil(async () => (await watermark.getSize("width")) === labelled, {
      timeout: 5_000,
      timeoutMsg: "the words never came back once the bar had room",
    })
  })

  it("leaves no native tooltip in the workspace", async () => {
    // Every hint the app shows is a shadcn tooltip, so nothing on screen may
    // still carry the attribute the WebView would draw its own from.
    const natives = await browser.execute(() =>
      [...document.querySelectorAll("[title]")].map(
        (node) => `${node.tagName.toLowerCase()}: ${node.getAttribute("title")}`,
      ),
    )

    expect(natives).toEqual([])
  })

  it("ships no last-child test that WebKit runs against every element", async () => {
    // With its ancestor hidden in :is()/:where(), WebKit can neither bucket nor
    // filter such a rule, so every parent counts as watching its last child,
    // which it restyles whole when a sibling follows: each tooltip's portal
    // restyled the app, 250 ms with a fragmented page mounted. Tailwind's
    // space-*, divide-* and *:last: utilities compile to exactly these.
    const structural = "(?:last-child|only-child|last-of-type|only-of-type|nth-last-child|nth-last-of-type)"
    const patterns = [
      new RegExp(`:where\\([^()]*>\\s*:not\\(:${structural}\\)\\)`),
      new RegExp(`:is\\([^()]*\\*\\)(?::is\\([a-z]+\\))?:${structural}`),
    ]
    const offending = (await shippedSelectors()).filter((selector) =>
      patterns.some((pattern) => pattern.test(selector)),
    )

    expect(offending).toEqual([])
  })

  it("ships no :has() over every element, which Chromium restyles all for", async () => {
    // Tailwind's group-has-* compiles to `:is(:where(.group):has(…) *)`. For
    // such a rule Chromium (WebView2) restyles the whole document whenever a
    // node is added anywhere: 400–900 ms a frame with a fragmented page's text
    // mounted, while scrolling and for every tooltip. A `:has()` whose
    // combinator names its targets measured harmless.
    expect((await shippedSelectors()).filter(hasOverEveryElement)).toEqual([])
  })

  it("ships no :focus-within over every element, which WebKit restyles all for", async () => {
    // Every focus change flips `:focus-within` on the focused element's
    // ancestors up to the root, and for a rule reaching their descendants
    // WebKit restyles the whole document: one group-focus-within-* made each
    // focus change on a 400-page board of thumbnails take 29 ms, against 2 ms.
    expect((await shippedSelectors()).filter(focusWithinOverEveryElement)).toEqual([])
  })

  it("ships no :has() reaching through :is() with a combinator, which WebKit checks per node", async () => {
    // A combinator inside :is() can match outside the :has() subject, so
    // WebKit checks every element the rule could light whenever a node is
    // added anywhere: a bookmark row's tools lit by their :focus-visible made
    // each node a page's text adds cost 16 ms beside a 615-bookmark outline,
    // 2–4 µs without.
    expect(hasCombinatorThroughIs(":has(:is([data-label=\")\"] a))")).toBe(true)
    expect(hasCombinatorThroughIs(":has(:is([data-label=\"x\"] a))")).toBe(true)
    expect(hasCombinatorThroughIs(":has(:is([data-label=\"a b\"]))")).toBe(false)
    expect((await shippedSelectors()).filter(hasCombinatorThroughIs)).toEqual([])
  })

  it("ships no width media query a resizable window can flip", async () => {
    // Chromium restyles the whole document when a media query flips: Tailwind's
    // unused `.container` breakpoints stalled a window resize 300–700 ms per
    // crossing with a fragmented page's text mounted. Narrower than the window
    // can go, a breakpoint never flips.
    const { minWidth } = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"))
      .app.windows[0] as { minWidth: number }
    const flipping = (await shippedRules()).media.filter((condition) =>
      [...condition.matchAll(/width\s*(?::|[<>]=?)\s*([\d.]+)(px|r?em)/g)].some(
        ([, value, unit]) => Number(value) * (unit === "px" ? 1 : 16) > minWidth,
      ),
    )

    expect(flipping).toEqual([])
  })
})

describe("TFolio controls that cannot act", () => {
  before(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "single" } })
    await refreshApp()
    await openPdfFromDisk("greyed.pdf", minimalPdf(1))
    await $("[data-page-number='1'] canvas[data-rendered='true']").waitForExist()
  })

  it("show no hover ground, a not-allowed cursor, and a tooltip saying why", async () => {
    // Scripted moves set no :hover, and a real pointer's leaves the next
    // spec's app showing no :focus-visible: the rules are read instead, every
    // one that grounds a hovered element tried on the control without it.
    const hoverGrounds = (css: string) =>
      browser.execute((selector: string) => {
        const element = document.querySelector(selector)!
        const found: string[] = []
        const walk = (rules: CSSRuleList) => {
          for (const rule of Array.from(rules)) {
            // The pseudo-class, not the escaped `\:hover` in a class's name.
            const unhovered = /(?<!\\):hover/g

            if (rule instanceof CSSStyleRule && unhovered.test(rule.selectorText)) {
              const grounds = rule.style.getPropertyValue("background-color") !== ""

              try {
                if (grounds && element.matches(rule.selectorText.replace(unhovered, ""))) {
                  found.push(rule.selectorText)
                }
              } catch {
                // A selector this engine cannot match is none of the control's.
              }
            }

            if ("cssRules" in rule) {
              walk((rule as CSSGroupingRule).cssRules)
            }
          }
        }

        for (const sheet of Array.from(document.styleSheets)) {
          walk(sheet.cssRules)
        }

        return found
      }, css)

    // An enabled button is grounded under the pointer, so the reading finds
    // what it looks for.
    expect(await hoverGrounds("button[aria-label='Zoom in']")).not.toEqual([])

    for (const [css, why] of [
      ["button[aria-label='Undo']", "Nothing to undo"],
      ["button[aria-label='Book']", "Book view needs at least two pages"],
      [`${activeSidebar} [data-slot='pages-rotate-left']`, "Select pages to rotate or delete them"],
      [`${activeSidebar} [data-slot='sidebar-fold-all']`, "Nothing here to fold"],
      [
        `${activeSidebar} [data-slot='pages-smart-padding']`,
        "Start every file on an odd page: available once the document has several files",
      ],
    ] as const) {
      await expect($(css)).toBeDisabled()
      expect(await hoverGrounds(css)).toEqual([])
      expect(
        await browser.execute((selector: string) => getComputedStyle(document.querySelector(selector)!).cursor, css),
      ).toBe("not-allowed")
      expect(await tooltipOn(css)).toBe(why)
    }
  })
})
