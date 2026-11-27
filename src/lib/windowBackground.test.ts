import { describe, expect, test } from "bun:test"

import { applyWorkspaceMaterial, isWorkspaceMaterial } from "@/lib/windowBackground"

function fakeRoot() {
  const classes = new Set<string>()
  const dataset: Record<string, string | undefined> = {}

  return {
    classList: {
      contains: (name: string) => classes.has(name),
      toggle: (name: string, force?: boolean) => {
        const next = force ?? !classes.has(name)
        if (next) {
          classes.add(name)
        } else {
          classes.delete(name)
        }
        return next
      },
    },
    dataset,
  } as unknown as HTMLElement
}

describe("windowBackground", () => {
  test("recognizes only supported native workspace materials", () => {
    expect(isWorkspaceMaterial("glass")).toBe(true)
    expect(isWorkspaceMaterial("mica")).toBe(true)
    expect(isWorkspaceMaterial("acrylic")).toBe(false)
    expect(isWorkspaceMaterial(true)).toBe(false)
    expect(isWorkspaceMaterial(null)).toBe(false)
  })

  test("marks and clears native workspace material on the document root", () => {
    const root = fakeRoot()

    applyWorkspaceMaterial(root, "glass")
    expect(root.classList.contains("native-workspace")).toBe(true)
    expect(root.dataset.nativeMaterial).toBe("glass")

    applyWorkspaceMaterial(root, "mica")
    expect(root.classList.contains("native-workspace")).toBe(true)
    expect(root.dataset.nativeMaterial).toBe("mica")

    applyWorkspaceMaterial(root, null)
    expect(root.classList.contains("native-workspace")).toBe(false)
    expect("nativeMaterial" in root.dataset).toBe(false)
  })
})
