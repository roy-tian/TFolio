import { describe, expect, it } from "bun:test"

import { loadSettings } from "@/lib/settings"

import {
  clampWatermarkText,
  defaultWatermarkConfig,
  defaultWatermarkWidthRatio,
  readStoredWatermarkConfig,
  sameWatermarkConfig,
  validateWatermarkConfig,
  watermarkFontSize,
  watermarkRotation,
  WATERMARK_MAX_CHARS,
  WATERMARK_MAX_WIDTH_RATIO,
  WATERMARK_MIN_WIDTH_RATIO,
  WATERMARK_REFERENCE_FONT_SIZE,
  type WatermarkConfig,
} from "@/lib/watermark"

function config(changes: Partial<WatermarkConfig> = {}): WatermarkConfig {
  return { ...defaultWatermarkConfig("CONFIDENTIAL"), ...changes }
}

/**
 * The load goes through the real IPC seam, so this also pins that a
 * watermark reaches the dialog as the backend sends it.
 */
async function withStoredWatermark<Value>(stored: unknown, read: () => Value) {
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")

  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: (command: string) =>
          Promise.resolve(command === "settings" ? { watermark: stored } : null),
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

describe("validateWatermarkConfig", () => {
  it("accepts every shared range endpoint", () => {
    for (const widthRatio of [
      WATERMARK_MIN_WIDTH_RATIO,
      WATERMARK_MAX_WIDTH_RATIO,
    ]) {
      expect(validateWatermarkConfig(config({ widthRatio }))).toBeNull()
    }
  })

  it("rejects blank, multiline, and overlong text", () => {
    expect(validateWatermarkConfig(config({ text: "  " }))).toBe("empty")
    expect(validateWatermarkConfig(config({ text: "two\nlines" }))).toBe(
      "multiline",
    )
    expect(
      validateWatermarkConfig(
        config({ text: "水".repeat(WATERMARK_MAX_CHARS + 1) }),
      ),
    ).toBe("tooLong")
  })

  it("rejects non-finite and out-of-range settings", () => {
    expect(validateWatermarkConfig(config({ widthRatio: Number.NaN }))).toBe(
      "style",
    )
    expect(validateWatermarkConfig(config({ widthRatio: 0 }))).toBe("style")
    expect(
      validateWatermarkConfig(
        config({ widthRatio: WATERMARK_MAX_WIDTH_RATIO + 0.05 }),
      ),
    ).toBe("style")
    expect(
      validateWatermarkConfig({
        ...config(),
        direction: "sideways" as WatermarkConfig["direction"],
      }),
    ).toBe("style")
  })
})

describe("clampWatermarkText", () => {
  it("counts the code points the validator and the backend count", () => {
    // An astral character is two UTF-16 code units, so `maxLength` — which the
    // field deliberately does not use — would have cut this in half.
    const emoji = "🙂".repeat(WATERMARK_MAX_CHARS)

    expect(clampWatermarkText(emoji)).toBe(emoji)
    expect(validateWatermarkConfig(config({ text: emoji }))).toBeNull()
  })

  it("cuts an overlong paste to exactly the shared limit", () => {
    const clamped = clampWatermarkText("🙂".repeat(WATERMARK_MAX_CHARS + 40))

    expect([...clamped]).toHaveLength(WATERMARK_MAX_CHARS)
    // The cut has to fall between code points, never inside a surrogate pair.
    expect(clamped).not.toContain("�")
    expect(validateWatermarkConfig(config({ text: clamped }))).toBeNull()
  })

  it("leaves text within the limit untouched", () => {
    expect(clampWatermarkText("内部资料")).toBe("内部资料")
    expect(clampWatermarkText("")).toBe("")
  })
})

describe("watermark geometry", () => {
  // Mirrors the two geometry tests in the backend's watermark.rs: the preview
  // draws what the page will carry, so the derivations have to agree.
  it("leans both directions along the page's own diagonal", () => {
    expect(watermarkRotation("ascending", 600, 800)).toBeCloseTo(-53.13, 2)
    expect(watermarkRotation("descending", 600, 800)).toBeCloseTo(53.13, 2)
    // A landscape sheet leans by less, so the mark still meets its corners.
    expect(watermarkRotation("descending", 800, 600)).toBeCloseTo(36.87, 2)
  })

  it("scales the measured mark to the share of the width it was given", () => {
    expect(watermarkFontSize(1, 600, 300)).toBe(
      WATERMARK_REFERENCE_FONT_SIZE * 2,
    )
    expect(watermarkFontSize(0.5, 600, 300)).toBe(WATERMARK_REFERENCE_FONT_SIZE)
    // Nothing has been measured yet on the first render of the sheet.
    expect(watermarkFontSize(0.8, 600, 0)).toBe(0)
  })
})

describe("watermark settings", () => {
  it("starts a new watermark as a single 80% mark", () => {
    expect(defaultWatermarkConfig("CONFIDENTIAL")).toEqual({
      direction: "ascending",
      layout: "single",
      text: "CONFIDENTIAL",
      widthRatio: 0.8,
    })
  })

  it("gives each repeat pattern its own starting size", () => {
    expect(defaultWatermarkWidthRatio("single")).toBe(0.8)
    expect(defaultWatermarkWidthRatio("zebra")).toBe(0.3)
  })

  it("detects configurations without relying on object identity", () => {
    const value = config()

    expect(sameWatermarkConfig(value, { ...value })).toBe(true)
    expect(sameWatermarkConfig(value, { ...value, widthRatio: 0.5 })).toBe(false)
    expect(sameWatermarkConfig(value, { ...value, direction: "descending" })).toBe(
      false,
    )
    expect(sameWatermarkConfig(value, { ...value, layout: "zebra" })).toBe(false)
    expect(sameWatermarkConfig(null, null)).toBe(true)
  })

  it("reads back a stored watermark, text included", async () => {
    const stored = config({ layout: "zebra", text: "内部文件", widthRatio: 0.5 })

    expect(await withStoredWatermark(stored, readStoredWatermarkConfig)).toEqual(
      stored,
    )
  })

  it("drops fields this version no longer reads from a stored watermark", async () => {
    const stored = config({ layout: "zebra" })

    expect(
      await withStoredWatermark({ ...stored, rasterize: true }, readStoredWatermarkConfig),
    ).toEqual(stored)
  })

  it("drops a stored record this version cannot use", async () => {
    // What earlier versions kept — a font, a colour, an angle — no longer
    // describes a watermark, so the reader starts from the defaults instead.
    const legacy = {
      bold: false,
      color: "#64748b",
      fontFamily: "sans",
      fontSize: 36,
      layout: "single",
      opacity: 0.25,
      rotation: -30,
      spacing: 54,
    }

    expect(await withStoredWatermark(legacy, readStoredWatermarkConfig)).toBeNull()
    expect(await withStoredWatermark("zebra", readStoredWatermarkConfig)).toBeNull()
    expect(
      await withStoredWatermark(undefined, readStoredWatermarkConfig),
    ).toBeNull()
  })
})
