import { $, browser, expect } from "@wdio/globals"
import "@wdio/tauri-service"

import { languageStorageKey } from "../../src/i18n/config"

function minimalPdf() {
  const objects = [
    "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
    "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
    "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 300] /Contents 4 0 R >>\nendobj\n",
    "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n",
  ]
  const chunks = ["%PDF-1.4\n"]
  const offsets: number[] = []
  let byteLength = Buffer.byteLength(chunks[0], "ascii")

  for (const object of objects) {
    offsets.push(byteLength)
    chunks.push(object)
    byteLength += Buffer.byteLength(object, "ascii")
  }

  const xrefOffset = byteLength
  chunks.push(`xref\n0 ${objects.length + 1}\n`)
  chunks.push("0000000000 65535 f \n")

  for (const offset of offsets) {
    chunks.push(`${String(offset).padStart(10, "0")} 00000 n \n`)
  }

  chunks.push(
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`,
  )

  return Buffer.from(chunks.join(""), "ascii")
}

async function selectFile(name: string, type: string, contents: Uint8Array) {
  await browser.execute(({ bytes, fileName, mimeType }) => {
    const input = document.querySelector<HTMLInputElement>(
      "input[type='file']",
    )

    if (!input) {
      throw new Error("PDF file input was not found")
    }

    const file = new File([new Uint8Array(bytes)], fileName, {
      type: mimeType,
    })

    Object.defineProperty(input, "files", {
      configurable: true,
      value: [file],
    })
    input.dispatchEvent(new Event("change", { bubbles: true }))
  }, {
    bytes: Array.from(contents),
    fileName: name,
    mimeType: type,
  })
}

describe("TFolio PDF viewer", () => {
  before(async () => {
    await browser.execute((storageKey) => {
      window.localStorage.setItem(storageKey, "en")
    }, languageStorageKey)
    await browser.refresh()
    await $("input[aria-label='Choose a PDF file']").waitForExist()
  })

  it("starts with the isolated WDIO bridge available", async () => {
    const location = await browser.tauri.execute(() => window.location.href)
    const chooseFile = await $("input[aria-label='Choose a PDF file']")

    await expect(chooseFile).toExist()
    expect(location).toContain("tauri")
  })

  it("rejects invalid input, renders a PDF, and exercises viewer controls", async () => {
    await selectFile(
      "not-a-pdf.txt",
      "text/plain",
      Buffer.from("not a PDF", "utf8"),
    )
    await expect($("[role='alert']")).toHaveText("Please choose a PDF file.")

    await selectFile("one-page.pdf", "application/pdf", minimalPdf())

    const firstPage = await $("[data-page-number='1']")
    await firstPage.waitForDisplayed()
    await expect($("[role='group']")).toHaveAttribute(
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

    const pageInput = await $("input[aria-label='Page number']")
    await pageInput.setValue("99")
    await browser.keys("Enter")
    await expect(pageInput).toHaveValue("1")

    await $("button[aria-label='Show bookmarks']").click()
    await expect($("nav[aria-label='Bookmarks']")).toHaveText(
      "This document has no bookmarks.",
    )

    await $("button[aria-label='Settings']").click()
    await expect($("[role='dialog']")).toBeDisplayed()

    // The About section preserves the existing application information.
    await $("[role='tab'][aria-controls='settings-panel-about']").click()
    await expect($("#settings-panel-about")).toBeDisplayed()

    // The Appearance section switches the color theme. Selecting Light then Dark
    // proves the toggle works regardless of the operating system's default scheme
    // (under "follow system" the app may already be dark before the click).
    await $("[role='tab'][aria-controls='settings-panel-appearance']").click()
    await $("//button[@role='radio' and normalize-space()='Light']").click()
    const isDarkAfterLight = await browser.execute(() =>
      document.documentElement.classList.contains("dark"),
    )
    expect(isDarkAfterLight).toBe(false)

    await $("//button[@role='radio' and normalize-space()='Dark']").click()
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
})
