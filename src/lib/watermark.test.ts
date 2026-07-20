import { describe, expect, it } from "bun:test"

import {
  clampWatermarkText,
  defaultWatermarkConfig,
  defaultWatermarkPreferences,
  isWatermarkPreferences,
  normalizeWatermarkRotation,
  readStoredWatermarkPreferences,
  sameWatermarkConfig,
  validateWatermarkConfig,
  watermarkFontWeightValue,
  watermarkPreferences,
  watermarkUsesEmbeddedFont,
  WATERMARK_MAX_CHARS,
  WATERMARK_MAX_FONT_SIZE,
  WATERMARK_MAX_SPACING,
  WATERMARK_MIN_FONT_SIZE,
  WATERMARK_MIN_OPACITY,
  WATERMARK_MIN_SPACING,
  type WatermarkConfig,
} from "@/lib/watermark"

function config(changes: Partial<WatermarkConfig> = {}): WatermarkConfig {
  return { ...defaultWatermarkConfig(), text: "CONFIDENTIAL", ...changes }
}

describe("validateWatermarkConfig", () => {
  it("accepts every shared range endpoint", () => {
    expect(
      validateWatermarkConfig(
        config({
          fontSize: WATERMARK_MIN_FONT_SIZE,
          opacity: WATERMARK_MIN_OPACITY,
          spacing: WATERMARK_MIN_SPACING,
        }),
      ),
    ).toBeNull()
    expect(
      validateWatermarkConfig(
        config({
          fontSize: WATERMARK_MAX_FONT_SIZE,
          opacity: 1,
          spacing: WATERMARK_MAX_SPACING,
        }),
      ),
    ).toBeNull()
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

  it("rejects non-finite and out-of-range style values", () => {
    expect(validateWatermarkConfig(config({ fontSize: Number.NaN }))).toBe("style")
    expect(validateWatermarkConfig(config({ opacity: 0 }))).toBe("style")
    expect(validateWatermarkConfig(config({ rotation: Number.POSITIVE_INFINITY }))).toBe(
      "style",
    )
    expect(validateWatermarkConfig(config({ spacing: 0 }))).toBe("style")
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

describe("normalizeWatermarkRotation", () => {
  // Mirrors `normalizes_equivalent_rotations` in the backend's watermark.rs:
  // the two sides have to agree, or the frontend commits a history step the
  // backend recognises as a no-op.
  it("canonicalises equivalent directions the way the backend does", () => {
    expect(normalizeWatermarkRotation(0)).toBe(0)
    expect(normalizeWatermarkRotation(360)).toBe(0)
    expect(normalizeWatermarkRotation(540)).toBe(180)
    expect(normalizeWatermarkRotation(181)).toBe(-179)
    expect(normalizeWatermarkRotation(-181)).toBe(179)
  })

  it("folds both ends of the angle control onto one value", () => {
    expect(normalizeWatermarkRotation(-180)).toBe(normalizeWatermarkRotation(180))
    expect(sameWatermarkConfig(
      config({ rotation: normalizeWatermarkRotation(-180) }),
      config({ rotation: normalizeWatermarkRotation(180) }),
    )).toBe(true)
  })
})

describe("watermark preferences", () => {
  it("never includes the watermark text in persisted preferences", () => {
    const preferences = watermarkPreferences(config({ text: "sensitive" }))

    expect("text" in preferences).toBe(false)
    expect(JSON.stringify(preferences)).not.toContain("sensitive")
    expect(isWatermarkPreferences(preferences)).toBe(true)
    expect(isWatermarkPreferences({ ...preferences, bold: "yes" })).toBe(false)
  })

  it("detects configurations without relying on object identity", () => {
    const value = config()

    expect(sameWatermarkConfig(value, { ...value })).toBe(true)
    expect(sameWatermarkConfig(value, { ...value, bold: true })).toBe(false)
    expect(sameWatermarkConfig(value, { ...value, opacity: 0.5 })).toBe(false)
    expect(sameWatermarkConfig(null, null)).toBe(true)
  })

  it("migrates stored styles from before the bold preference existed", () => {
    const { bold: _bold, ...legacy } = defaultWatermarkPreferences
    const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")

    expect(_bold).toBe(false)

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: () => JSON.stringify(legacy),
        },
      },
    })

    try {
      expect(readStoredWatermarkPreferences()).toEqual({ ...legacy, bold: false })
    } finally {
      if (previousWindow) {
        Object.defineProperty(globalThis, "window", previousWindow)
      } else {
        Reflect.deleteProperty(globalThis, "window")
      }
    }
  })

  it("uses the bundled face for text outside printable Latin-1", () => {
    expect(watermarkUsesEmbeddedFont("CONFIDENTIAL")).toBe(false)
    expect(watermarkUsesEmbeddedFont("机密")).toBe(true)
  })
})

describe("watermark font weight", () => {
  it("uses 400/800 for the bundled face and Regular/Bold for standard fonts", () => {
    expect(watermarkFontWeightValue(false, true)).toBe(400)
    expect(watermarkFontWeightValue(true, true)).toBe(800)
    expect(watermarkFontWeightValue(false, false)).toBe(400)
    expect(watermarkFontWeightValue(true, false)).toBe(700)
  })
})
