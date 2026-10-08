import { $, browser, expect } from "@wdio/globals"

import type { E2eOverrides } from "../../src/lib/e2e"
import type { AppUpdateStatus } from "../../src/lib/update"
import {
  clickAppMenuItem,
  minimalPdf,
  openPdfFromDisk,
  refreshApp,
  seedSettings,
} from "./helpers"

async function mockUpdater(status: AppUpdateStatus = { state: "available", version: "0.1.15" }) {
  await browser.execute((next: AppUpdateStatus) => {
    const app = window as unknown as Window & {
      __tfolioE2E?: E2eOverrides
      __TAURI__: typeof import("@tauri-apps/api")
    }
    document.documentElement.dataset.updateChecks = "0"
    app.__tfolioE2E = {
      ...app.__tfolioE2E,
      checkUpdates: async () => {
        document.documentElement.dataset.updateChecks = String(
          Number(document.documentElement.dataset.updateChecks) + 1,
        )
        await app.__TAURI__.event.emit("update://changed", next)
      },
      downloadUpdate: async () => {
        document.documentElement.dataset.downloadRequested = "true"
        await app.__TAURI__.event.emit("update://changed", {
          state: "downloading", version: "0.1.15", received: 50, total: 100,
        })
      },
      installUpdate: async () => {
        document.documentElement.dataset.installRequested = "true"
      },
    }
  }, status)
}

async function publish(status: AppUpdateStatus) {
  await browser.execute(async (next: AppUpdateStatus) => {
    const app = window as unknown as Window & {
      __TAURI__: typeof import("@tauri-apps/api")
    }
    await app.__TAURI__.event.emit("update://changed", next)
  }, status)
}

const offer = () => $("[data-slot='about-update']")
const action = () => $("[data-action='about-update']")
const checkCount = () => browser.execute(() => Number(document.documentElement.dataset.updateChecks))
const installed = () => browser.execute(() => document.documentElement.dataset.installRequested === "true")

describe("About updates", () => {
  beforeEach(async () => {
    await seedSettings({ ui: { language: "en", viewMode: "thumbnail" } })
    await refreshApp()
    await mockUpdater()
  })

  it("checks on both About entry paths and again on each visit", async () => {
    await clickAppMenuItem("settings")
    expect(await checkCount()).toBe(0)
    await $("#settings-tab-about").click()
    await expect(offer()).toHaveText(expect.stringContaining("New version 0.1.15 available"))
    await expect(action()).toBeEnabled()
    expect(await checkCount()).toBe(1)
    await expect($("#settings-panel-about")).not.toHaveText(expect.stringContaining("internal beta"))

    await $("#settings-tab-appearance").click()
    await $("#settings-tab-about").click()
    await browser.waitUntil(async () => await checkCount() === 2)
    await $("[role='dialog'] button[aria-label='Close']").click()
    await clickAppMenuItem("about")
    await browser.waitUntil(async () => await checkCount() === 3)
    await expect(action()).toBeEnabled()
  })

  it("downloads from the inline link, reports progress, then offers installation", async () => {
    await clickAppMenuItem("about")
    await expect(action()).toHaveText("Update now")
    await expect(action()).toBeEnabled()
    await action().click()
    await expect(offer()).toHaveText(expect.stringContaining("Downloading… 50%"))
    await expect(action()).not.toExist()
    expect(await browser.execute(() => document.documentElement.dataset.downloadRequested)).toBe("true")

    await publish({ state: "ready", version: "0.1.15" })
    await expect(action()).toHaveText("Install now")
    await action().click()
    await browser.waitUntil(installed)
    await expect($("[role='alertdialog']")).not.toBeDisplayed()
  })

  it("asks before installing from About even when the update notice was dismissed", async () => {
    await openPdfFromDisk("about-unsaved.pdf", minimalPdf(2))
    await $("button[aria-label='Delete page 1']").click()
    await $("[aria-label='Unsaved changes']").waitForExist()
    await mockUpdater({ state: "ready", version: "0.1.15" })
    await publish({ state: "ready", version: "0.1.15" })
    await $("[data-notice='updateReady'] button[aria-label='Dismiss notification']").click()
    await clickAppMenuItem("about")
    await expect(action()).toHaveText("Install now")
    await expect(action()).toBeEnabled()
    await action().click()
    await expect($("[role='alertdialog']")).toBeDisplayed()
    expect(await installed()).toBe(false)
    await $("button=Not now").click()
    await expect($("[role='alertdialog']")).not.toBeDisplayed()
    expect(await installed()).toBe(false)
    await action().click()
    await $("button=Discard all changes and restart to install").click()
    await browser.waitUntil(installed)
  })

  it("allows a failed download to be retried", async () => {
    await clickAppMenuItem("about")
    await expect(action()).toBeEnabled()
    await action().click()
    await publish({ state: "failed", version: "0.1.15" })
    await expect(offer()).toHaveText(expect.stringContaining("could not be downloaded"))
    await expect(action()).toHaveText("Update now")
    await action().click()
    await expect(offer()).toHaveText(expect.stringContaining("Downloading…"))
  })

  it("shows no download link when no update is available and reports check failures", async () => {
    await mockUpdater({ state: "idle" })
    await clickAppMenuItem("about")
    await browser.waitUntil(async () => await checkCount() === 1)
    await expect(action()).not.toExist()
    await $("#settings-tab-appearance").click()
    await browser.execute(() => {
      const app = window as Window & { __tfolioE2E?: E2eOverrides }
      app.__tfolioE2E!.checkUpdates = () => Promise.reject(new Error("offline"))
    })
    await $("#settings-tab-about").click()
    await expect(offer()).toHaveText(expect.stringContaining("Could not check for updates."))
    await expect(action()).not.toExist()
  })

  it("uses the requested Chinese labels beside the current version", async () => {
    await seedSettings({ ui: { language: "zh-CN", viewMode: "single" } })
    await refreshApp()
    await mockUpdater()
    await clickAppMenuItem("about")
    await expect(offer()).toHaveText(expect.stringContaining("发现新版本 0.1.15"))
    await expect(action()).toHaveText("立即更新")
    await expect($("#settings-panel-about")).not.toHaveText(expect.stringContaining("内部测试版"))
    await browser.saveScreenshot("artifacts/e2e/about-update-available.png")
    await publish({ state: "ready", version: "0.1.15" })
    await expect(action()).toHaveText("立即安装")
    await browser.saveScreenshot("artifacts/e2e/about-update-ready.png")
  })
})
