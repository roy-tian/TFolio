import { $, browser, expect } from "@wdio/globals"

import type { E2eOverrides } from "../../src/lib/e2e"
import { minimalPdf, openPdfFromDisk, refreshApp, seedSettings } from "./helpers"

async function offerUpdate() {
  await browser.execute(async () => {
    const app = window as unknown as Window & {
      __tfolioE2E?: E2eOverrides
      __TAURI__: typeof import("@tauri-apps/api")
    }
    app.__tfolioE2E = {
      ...app.__tfolioE2E,
      installUpdate: async () => {
        document.documentElement.dataset.installRequested = "true"
      },
    }
    await app.__TAURI__.event.emit("update://changed", {
      state: "ready", version: "9.9.9",
    })
  })
  await $("[data-notice='updateReady'] button").waitForDisplayed()
}

async function requestInstall() {
  await $("[data-notice='updateReady'] button").click()
}

async function expectInstalled() {
  await browser.waitUntil(() => browser.execute(
    () => document.documentElement.dataset.installRequested === "true",
  ))
  await expect($("[role='alertdialog']")).not.toBeDisplayed()
}

describe("update installation confirmation", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "thumbnail" } })
    await refreshApp()
  })

  it("installs directly from an empty workspace", async () => {
    await offerUpdate()
    await requestInstall()
    await expectInstalled()
  })

  it("installs directly with an unchanged PDF open", async () => {
    await openPdfFromDisk("clean-update.pdf", minimalPdf(2))
    await offerUpdate()
    await requestInstall()
    await expectInstalled()
  })

  it("asks before discarding edits in a background tab and respects cancel", async () => {
    await openPdfFromDisk("edited-update.pdf", minimalPdf(2))
    await $("button[aria-label='Delete page 1']").click()
    await $("[aria-label='Unsaved changes']").waitForExist()
    await $("#workspace-tab-home").click()
    await offerUpdate()
    await requestInstall()
    await expect($("[role='alertdialog']")).toBeDisplayed()
    expect(await browser.execute(
      () => document.documentElement.dataset.installRequested === "true",
    )).toBe(false)
    await $("button=Not now").click()
    await expect($("[role='alertdialog']")).not.toBeDisplayed()
    expect(await browser.execute(
      () => document.documentElement.dataset.installRequested === "true",
    )).toBe(false)

    await requestInstall()
    await $("button=Discard all changes and restart to install").click()
    await expectInstalled()
  })

  it("skips confirmation after edits are undone", async () => {
    await openPdfFromDisk("undo-update.pdf", minimalPdf(2))
    await $("button[aria-label='Delete page 1']").click()
    await $("[aria-label='Unsaved changes']").waitForExist()
    await $("[data-active='true'] button[aria-label^='Undo']").click()
    await $("[aria-label='Unsaved changes']").waitForExist({ reverse: true })
    await offerUpdate()
    await requestInstall()
    await expectInstalled()
  })
})
