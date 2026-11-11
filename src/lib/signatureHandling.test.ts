import { describe, expect, test } from "bun:test"

import { isSignatureHandling } from "./signatureHandling"

describe("isSignatureHandling", () => {
  test("takes the three choices the settings offer", () => {
    expect(isSignatureHandling("ask")).toBe(true)
    expect(isSignatureHandling("flatten")).toBe(true)
    expect(isSignatureHandling("keep")).toBe(true)
  })

  test("refuses what a hand edit of the file may leave", () => {
    expect(isSignatureHandling("Flatten")).toBe(false)
    expect(isSignatureHandling("")).toBe(false)
    expect(isSignatureHandling(true)).toBe(false)
    expect(isSignatureHandling(undefined)).toBe(false)
  })
})
