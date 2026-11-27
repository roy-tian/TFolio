import { describe, expect, it, mock } from "bun:test"
import i18next from "i18next"

import {
  buildFileMenuItems,
  buildPageMenuItems,
  runFileMenuAction,
  runPageMenuAction,
  type FileMenuActions,
  type PageMenuActions,
} from "@/components/PageContextMenu"
import en from "@/i18n/locales/en"
import {
  buildMacMenuStaticLabels,
  formatRecentMenuEntries,
} from "@/lib/nativeMenu"

async function createEnglishT() {
  const instance = i18next.createInstance()
  await instance.init({
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    lng: "en",
    resources: { en: { translation: en } },
    returnNull: false,
  })
  return instance.t.bind(instance)
}

function makePageActions(overrides: Partial<PageMenuActions> = {}): PageMenuActions {
  return {
    canPaste: false,
    count: 1,
    deleteDisabled: false,
    onCopy: mock(() => {}),
    onCut: mock(() => {}),
    onDelete: mock(() => {}),
    onExtract: mock(() => {}),
    onInsertBlank: mock(() => {}),
    onPaste: mock(() => {}),
    onRotate: mock(() => {}),
    ...overrides,
  }
}

function makeFileActions(overrides: Partial<FileMenuActions> = {}): FileMenuActions {
  return {
    canPaste: false,
    onPaste: mock(() => {}),
    onRemove: mock(() => {}),
    onRename: mock(() => {}),
    removeDisabled: false,
    ...overrides,
  }
}

describe("nativeMenu helpers", () => {
  it("builds all macOS static menu labels from English translations", async () => {
    const t = await createEnglishT()
    const labels = buildMacMenuStaticLabels(t)

    for (const [key, value] of Object.entries(labels)) {
      expect(typeof value, `${key} should be a string`).toBe("string")
      expect(value.trim().length, `${key} should be non-empty`).toBeGreaterThan(0)
      expect(value, `${key} should not contain uninterpolated placeholders`).not.toContain("{{")
    }

    expect(labels.appName).toBe("TFolio")
    expect(labels.aboutApp).toBe("About TFolio")
    expect(labels.hideApp).toBe("Hide TFolio")
    expect(labels.quitApp).toBe("Quit TFolio")
    expect(labels.appHelp).toBe("TFolio Help")
  })

  it("builds page context menu items respecting paste and delete state", async () => {
    const t = await createEnglishT()

    const withoutPaste = buildPageMenuItems(
      makePageActions({ canPaste: false, deleteDisabled: true }),
      t,
    )
    expect(withoutPaste.some((item) => item.kind === "item" && item.id === "paste-pages-before")).toBe(
      false,
    )
    const deleteDisabledItem = withoutPaste.find(
      (item) => item.kind === "item" && item.id === "delete-pages",
    )
    expect(deleteDisabledItem).toEqual({
      enabled: false,
      id: "delete-pages",
      kind: "item",
      label: "Delete page",
    })

    const withPaste = buildPageMenuItems(makePageActions({ canPaste: true, count: 3 }), t)
    expect(withPaste.some((item) => item.kind === "item" && item.id === "paste-pages-before")).toBe(
      true,
    )
    expect(withPaste.some((item) => item.kind === "item" && item.id === "paste-pages-after")).toBe(
      true,
    )
  })

  it("dispatches page context menu actions and respects deleteDisabled", () => {
    const actions = makePageActions({ deleteDisabled: true })

    expect(runPageMenuAction("rotate-pages", actions)).toBe(true)
    expect(actions.onRotate).toHaveBeenCalledWith(90)

    expect(runPageMenuAction("rotate-pages-left", actions)).toBe(true)
    expect(actions.onRotate).toHaveBeenCalledWith(270)

    expect(runPageMenuAction("paste-pages-before", actions)).toBe(true)
    expect(actions.onPaste).toHaveBeenCalledWith("before")

    expect(runPageMenuAction("insert-blank-after", actions)).toBe(true)
    expect(actions.onInsertBlank).toHaveBeenCalledWith("after")

    expect(runPageMenuAction("delete-pages", actions)).toBe(true)
    expect(actions.onDelete).not.toHaveBeenCalled()

    expect(runPageMenuAction("unknown", actions)).toBe(false)
  })

  it("builds and dispatches file context menu actions", async () => {
    const t = await createEnglishT()
    const onSelect = mock(() => {})
    const actions = makeFileActions({ canPaste: true, onSelect, removeDisabled: true })

    const items = buildFileMenuItems(actions, t)
    expect(items.some((item) => item.kind === "item" && item.id === "select-file")).toBe(true)
    expect(items.some((item) => item.kind === "item" && item.id === "paste-file-start")).toBe(true)
    expect(items.find((item) => item.kind === "item" && item.id === "remove-file")).toEqual({
      enabled: false,
      id: "remove-file",
      kind: "item",
      label: "Remove from this document",
    })

    expect(runFileMenuAction("select-file", actions)).toBe(true)
    expect(onSelect).toHaveBeenCalledTimes(1)

    expect(runFileMenuAction("rename-file", actions)).toBe(true)
    expect(actions.onRename).toHaveBeenCalledTimes(1)

    expect(runFileMenuAction("paste-file-end", actions)).toBe(true)
    expect(actions.onPaste).toHaveBeenCalledWith("end")

    expect(runFileMenuAction("remove-file", actions)).toBe(true)
    expect(actions.onRemove).not.toHaveBeenCalled()

    expect(runFileMenuAction("unknown", actions)).toBe(false)
  })

  it("disambiguates duplicate recent file names with leaf or full directory", () => {
    const entries = formatRecentMenuEntries(
      [
        { directory: "/Users/roy/Work/2025", name: "report.pdf", path: "/Users/roy/Work/2025/report.pdf" },
        { directory: "/Users/roy/Archive/2025", name: "report.pdf", path: "/Users/roy/Archive/2025/report.pdf" },
        { directory: "/Users/roy/Desktop", name: "unique.pdf", path: "/Users/roy/Desktop/unique.pdf" },
        { directory: "/Users/roy/Work", name: "notes.pdf", path: "/Users/roy/Work/notes.pdf" },
        { directory: "/Users/roy/Personal", name: "notes.pdf", path: "/Users/roy/Personal/notes.pdf" },
      ],
      10,
    )

    expect(entries).toEqual([
      { name: "report.pdf — /Users/roy/Work/2025", path: "/Users/roy/Work/2025/report.pdf" },
      { name: "report.pdf — /Users/roy/Archive/2025", path: "/Users/roy/Archive/2025/report.pdf" },
      { name: "unique.pdf", path: "/Users/roy/Desktop/unique.pdf" },
      { name: "notes.pdf — Work", path: "/Users/roy/Work/notes.pdf" },
      { name: "notes.pdf — Personal", path: "/Users/roy/Personal/notes.pdf" },
    ])

    expect(
      formatRecentMenuEntries(
        [
          { directory: "/a", name: "doc.pdf", path: "/a/doc.pdf" },
          { directory: "/b", name: "doc.pdf", path: "/b/doc.pdf" },
        ],
        1,
      ),
    ).toEqual([{ name: "doc.pdf", path: "/a/doc.pdf" }])
  })
})
