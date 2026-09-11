import { describe, expect, it } from "bun:test"

import {
  defaultRectStyle,
  isRectStyle,
  readStoredHighlightColor,
} from "@/lib/annotationStyles"
import { loadSettings } from "@/lib/settings"

/** `readStoredHighlightColor` answers from what the backend sent, so its test
    loads a document through the real IPC seam with `window` stubbed out. */
async function withStoredSettings(stored: unknown, read: () => unknown) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: { invoke: () => Promise.resolve(stored) },
      localStorage: {
        length: 0,
        key: () => null,
        getItem: () => null,
        removeItem: () => undefined,
        setItem: () => undefined,
      },
    },
  })

  try {
    await loadSettings()

    return read()
  } finally {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow)
    } else {
      Reflect.deleteProperty(globalThis, "window")
    }
  }
}

describe("isRectStyle", () => {
  it("accepts a style the app writes", () => {
    expect(isRectStyle(defaultRectStyle)).toBe(true)
    expect(
      isRectStyle({
        color: "#000000",
        effect: "mosaic",
        opacity: 0.5,
        strength: 12,
      }),
    ).toBe(true)
  })

  // The range comparisons are inclusive, so the sliders' own ends stay valid; a
  // stray `<`/`>` in place of `<=`/`>=` would reject these and fail here.
  it("accepts the ends of every slider's range", () => {
    expect(isRectStyle({ ...defaultRectStyle, opacity: 0.1 })).toBe(true)
    expect(isRectStyle({ ...defaultRectStyle, opacity: 1 })).toBe(true)
    expect(isRectStyle({ ...defaultRectStyle, strength: 2 })).toBe(true)
    expect(isRectStyle({ ...defaultRectStyle, strength: 24 })).toBe(true)
  })

  // Both numbers are checked whichever effect is stored: the one it does not
  // use is kept, and one switch away from being the mark.
  it("checks the settings the stored effect does not use", () => {
    expect(isRectStyle({ ...defaultRectStyle, effect: "blur", opacity: 0 })).toBe(
      false,
    )
    expect(
      isRectStyle({ ...defaultRectStyle, effect: "translucent", strength: 99 }),
    ).toBe(false)
  })

  // A style loaded with these would draw an invisible mark that still records as
  // an edit, so it is rejected in favour of the visible default.
  it("rejects an opacity the sliders never produce", () => {
    expect(isRectStyle({ ...defaultRectStyle, opacity: 0 })).toBe(false)
    expect(isRectStyle({ ...defaultRectStyle, opacity: 1.5 })).toBe(false)
  })

  it("rejects non-finite sizes", () => {
    expect(isRectStyle({ ...defaultRectStyle, opacity: Number.NaN })).toBe(false)
    expect(
      isRectStyle({ ...defaultRectStyle, strength: Number.POSITIVE_INFINITY }),
    ).toBe(false)
  })

  // Just outside each slider's range, so a boundary widened by one still fails
  // here rather than slipping through a far-off value like 99 or 999.
  it("rejects values just past the sliders' ranges", () => {
    expect(isRectStyle({ ...defaultRectStyle, opacity: 0.09 })).toBe(false)
    expect(isRectStyle({ ...defaultRectStyle, opacity: 1.05 })).toBe(false)
    expect(isRectStyle({ ...defaultRectStyle, strength: 1 })).toBe(false)
    expect(isRectStyle({ ...defaultRectStyle, strength: 25 })).toBe(false)
  })

  it("rejects an effect the app does not offer", () => {
    expect(isRectStyle({ ...defaultRectStyle, effect: "pixelate" })).toBe(false)
    expect(isRectStyle({ ...defaultRectStyle, effect: "none" })).toBe(false)
  })

  it("rejects a shape that is not a style at all", () => {
    expect(isRectStyle(null)).toBe(false)
    expect(isRectStyle({ opacity: 1 })).toBe(false)
    expect(isRectStyle({ ...defaultRectStyle, color: "red" })).toBe(false)
    expect(isRectStyle({ ...defaultRectStyle, color: null })).toBe(false)
    // A well-formed colour the swatches no longer offer: an older schema's, and
    // one the panel could show no swatch checked for.
    expect(isRectStyle({ ...defaultRectStyle, color: "#ff3b30" })).toBe(false)
  })
})

describe("readStoredHighlightColor", () => {
  it("keeps a colour the swatches offer", async () => {
    expect(
      await withStoredSettings(
        { annotate: { highlightColor: "#b2bec3" } },
        readStoredHighlightColor,
      ),
    ).toBe("#b2bec3")
  })

  // The same contract `isRectStyle` holds its colour to: no swatch to check
  // for an off-row colour, so the default takes over.
  it("falls back past a well-formed colour off the row", async () => {
    expect(
      await withStoredSettings(
        { annotate: { highlightColor: "#7f1d1d" } },
        readStoredHighlightColor,
      ),
    ).toBe(null)
  })

  it("falls back past a malformed value", async () => {
    expect(
      await withStoredSettings(
        { annotate: { highlightColor: "red" } },
        readStoredHighlightColor,
      ),
    ).toBe(null)
  })
})
