import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  minimalPdf,
  openPdfFromDisk,
  refreshApp,
  seedSettings,
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

    for (const label of ["单页视图", "书籍视图", "缩略图视图"]) {
      await expectShadcnTooltip(label)
    }

    const highlightOptions = await expectShadcnTooltip("高亮设置")
    await highlightOptions.click()
    await expect($("#highlight-color-label")).toHaveText("高亮颜色")
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
    const offending = await browser.execute(() => {
      const structural = "(?:last-child|only-child|last-of-type|only-of-type|nth-last-child|nth-last-of-type)"
      const patterns = [
        new RegExp(`:where\\([^()]*>\\s*:not\\(:${structural}\\)\\)`),
        new RegExp(`:is\\([^()]*\\*\\)(?::is\\([a-z]+\\))?:${structural}`),
      ]
      const found: string[] = []
      const walk = (rules: CSSRuleList) => {
        for (const rule of rules) {
          if (rule instanceof CSSStyleRule && patterns.some((pattern) => pattern.test(rule.selectorText))) {
            found.push(rule.selectorText)
          }
          if ("cssRules" in rule) walk((rule as CSSGroupingRule).cssRules)
        }
      }

      for (const sheet of document.styleSheets) walk(sheet.cssRules)

      return found
    })

    expect(offending).toEqual([])
  })
})
