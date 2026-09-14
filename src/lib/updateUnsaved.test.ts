import { afterEach, describe, expect, test } from "bun:test"
import { clearMocks } from "@tauri-apps/api/mocks"

import { mockUpdateWindows } from "./test-support/updateWindows"
import { updateNeedsConfirmation } from "./updateUnsaved"

afterEach(() => {
  clearMocks()
  Reflect.deleteProperty(globalThis, "window")
})

describe("update confirmation across windows", () => {
  test("skips confirmation in a clean single window", async () => {
    mockUpdateWindows({})
    expect(await updateNeedsConfirmation(() => false)).toBe(false)
  })

  test("keeps confirmation for local edits", async () => {
    const { requests } = mockUpdateWindows({ "window-1": false })
    expect(await updateNeedsConfirmation(() => true)).toBe(true)
    expect(requests).toEqual([])
  })

  test("skips confirmation only after every other window answers clean", async () => {
    const { listeners, requests } = mockUpdateWindows({
      "window-1": false, "window-2": false,
    })
    expect(await updateNeedsConfirmation(() => false)).toBe(false)
    expect(requests).toEqual(["window-1", "window-2"])
    expect(listeners.size).toBe(0)
  })

  test("keeps confirmation when another window has edits", async () => {
    mockUpdateWindows({ "window-1": false, "window-2": true })
    expect(await updateNeedsConfirmation(() => false)).toBe(true)
  })

  test("keeps confirmation when another window cannot answer", async () => {
    const { listeners } = mockUpdateWindows({ "window-1": null })
    expect(await updateNeedsConfirmation(() => false)).toBe(true)
    expect(listeners.size).toBe(0)
  })

  test("rechecks local work after collecting other windows' answers", async () => {
    mockUpdateWindows({ "window-1": false })
    let reads = 0
    expect(await updateNeedsConfirmation(() => ++reads > 1)).toBe(true)
  })
})
