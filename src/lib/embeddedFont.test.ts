import { describe, expect, it } from "bun:test"

import { usesEmbeddedFont } from "@/lib/embeddedFont"

describe("usesEmbeddedFont", () => {
  it("leaves text a standard PDF font can draw alone", () => {
    expect(usesEmbeddedFont("CONFIDENTIAL")).toBe(false)
    expect(usesEmbeddedFont("two\nlines")).toBe(false)
    expect(usesEmbeddedFont("Voilà, café")).toBe(false)
    expect(usesEmbeddedFont("")).toBe(false)
  })

  it("claims text that leaves Latin-1", () => {
    expect(usesEmbeddedFont("机密")).toBe(true)
    expect(usesEmbeddedFont("Hello 你好")).toBe(true)
    expect(usesEmbeddedFont("，")).toBe(true)
    expect(usesEmbeddedFont("Привет")).toBe(true)
    // Reads as Western text but is outside Latin-1 all the same.
    expect(usesEmbeddedFont("a — b")).toBe(true)
  })

  it("agrees with the backend on the boundary itself", () => {
    // The two ends of each range the Rust side accepts, and the gap between
    // them — where the two could most easily drift apart.
    expect(usesEmbeddedFont("\u0020\u007e")).toBe(false)
    expect(usesEmbeddedFont("\u00a0\u00ff")).toBe(false)
    // The gap between the two ranges, which neither side may quietly widen.
    expect(usesEmbeddedFont("\u007f")).toBe(true)
    expect(usesEmbeddedFont("\u009f")).toBe(true)
    expect(usesEmbeddedFont("\u0100")).toBe(true)
  })
})
