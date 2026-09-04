import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import {
  minimalPdf,
  openPdfFromDisk,
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
    await browser.refresh()
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
})
