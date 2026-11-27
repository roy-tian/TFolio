import { describe, expect, test } from "bun:test"

import {
  formatUpdateError,
  isAppUpdateStatus,
  shouldShowUpdate,
  type AppUpdateStatus,
} from "./update"

describe("isAppUpdateStatus", () => {
  test("accepts every state the backend publishes", () => {
    expect(isAppUpdateStatus({ state: "idle" })).toBe(true)
    expect(isAppUpdateStatus({ state: "available", version: "1.2.3" })).toBe(
      true,
    )
    expect(isAppUpdateStatus({ state: "ready", version: "1.2.3" })).toBe(true)
    expect(isAppUpdateStatus({ state: "failed", version: "1.2.3" })).toBe(true)
    expect(
      isAppUpdateStatus({
        state: "failed",
        version: "1.2.3",
        error: "operation timed out",
      }),
    ).toBe(true)
    expect(
      isAppUpdateStatus({
        state: "downloading",
        version: "1.2.3",
        received: 2048,
        total: null,
      }),
    ).toBe(true)
  })

  test("rejects a payload it cannot place", () => {
    expect(isAppUpdateStatus(null)).toBe(false)
    expect(isAppUpdateStatus({ state: "installing" })).toBe(false)
    // A version is what every notice is written around, so a state without one
    // has nothing to show.
    expect(isAppUpdateStatus({ state: "available" })).toBe(false)
    expect(
      isAppUpdateStatus({ state: "downloading", version: "1.2.3", total: 4 }),
    ).toBe(false)
    expect(
      isAppUpdateStatus({ state: "failed", version: "1.2.3", error: 42 }),
    ).toBe(false)
  })
})

describe("formatUpdateError", () => {
  test("compacts string and Error messages and drops empty values", () => {
    expect(formatUpdateError("  timed\n  out  ")).toBe("timed out")
    expect(formatUpdateError(new Error("dns lookup failed"))).toBe(
      "dns lookup failed",
    )
    expect(formatUpdateError("   ")).toBeNull()
    expect(formatUpdateError(null)).toBeNull()
  })

  test("truncates very long error messages", () => {
    const formatted = formatUpdateError("x".repeat(250))
    expect(formatted?.length).toBe(200)
    expect(formatted?.endsWith("…")).toBe(true)
  })
})

describe("shouldShowUpdate", () => {
  const available: AppUpdateStatus = { state: "available", version: "1.2.3" }

  test("says nothing about an app that is already current", () => {
    expect(shouldShowUpdate({ state: "idle" }, null)).toBe(false)
  })

  test("shows an update nobody has answered yet", () => {
    expect(shouldShowUpdate(available, null)).toBe(true)
  })

  test("keeps a dismissed notice away", () => {
    expect(shouldShowUpdate(available, "available")).toBe(false)
  })

  test("returns with the next step, which the reader has not dismissed", () => {
    expect(
      shouldShowUpdate({ state: "ready", version: "1.2.3" }, "available"),
    ).toBe(true)
  })
})
