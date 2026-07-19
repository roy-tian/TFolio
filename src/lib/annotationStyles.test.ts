import { describe, expect, it } from "bun:test"

import { defaultRectStyle, isRectStyle } from "@/lib/annotationStyles"

describe("isRectStyle", () => {
  it("accepts a style the app writes", () => {
    expect(isRectStyle(defaultRectStyle)).toBe(true)
    expect(
      isRectStyle({
        cornerRadius: 12,
        effect: { kind: "mosaic", strength: 12 },
        fillColor: "#ffcc00",
        opacity: 0.5,
        strokeColor: null,
        strokeWidth: 3,
      }),
    ).toBe(true)
  })

  // The range comparisons are inclusive, so the sliders' own ends stay valid; a
  // stray `<`/`>` in place of `<=`/`>=` would reject these and fail here.
  it("accepts the ends of every slider's range", () => {
    expect(isRectStyle({ ...defaultRectStyle, opacity: 0.1 })).toBe(true)
    expect(isRectStyle({ ...defaultRectStyle, opacity: 1 })).toBe(true)
    expect(isRectStyle({ ...defaultRectStyle, strokeWidth: 1 })).toBe(true)
    expect(isRectStyle({ ...defaultRectStyle, strokeWidth: 12 })).toBe(true)
    expect(isRectStyle({ ...defaultRectStyle, cornerRadius: 0 })).toBe(true)
    expect(isRectStyle({ ...defaultRectStyle, cornerRadius: 40 })).toBe(true)
    expect(
      isRectStyle({
        ...defaultRectStyle,
        effect: { kind: "blur", strength: 2 },
      }),
    ).toBe(true)
    expect(
      isRectStyle({
        ...defaultRectStyle,
        effect: { kind: "blur", strength: 24 },
      }),
    ).toBe(true)
  })

  // A style loaded with these would draw an invisible mark that still records as
  // an edit, so it is rejected in favour of the visible default.
  it("rejects an opacity the sliders never produce", () => {
    expect(isRectStyle({ ...defaultRectStyle, opacity: 0 })).toBe(false)
    expect(isRectStyle({ ...defaultRectStyle, opacity: 1.5 })).toBe(false)
  })

  it("rejects non-finite sizes", () => {
    expect(isRectStyle({ ...defaultRectStyle, cornerRadius: Number.NaN })).toBe(false)
    expect(
      isRectStyle({ ...defaultRectStyle, strokeWidth: Number.POSITIVE_INFINITY }),
    ).toBe(false)
    expect(
      isRectStyle({
        ...defaultRectStyle,
        effect: { kind: "blur", strength: Number.NaN },
      }),
    ).toBe(false)
  })

  // Just outside each slider's range, so a boundary widened by one still fails
  // here rather than slipping through a far-off value like 99 or 999.
  it("rejects values just past the sliders' ranges", () => {
    expect(isRectStyle({ ...defaultRectStyle, strokeWidth: 0.9 })).toBe(false)
    expect(isRectStyle({ ...defaultRectStyle, strokeWidth: 13 })).toBe(false)
    expect(isRectStyle({ ...defaultRectStyle, cornerRadius: -0.5 })).toBe(false)
    expect(isRectStyle({ ...defaultRectStyle, cornerRadius: 41 })).toBe(false)
    expect(isRectStyle({ ...defaultRectStyle, opacity: 0.09 })).toBe(false)
    expect(isRectStyle({ ...defaultRectStyle, opacity: 1.05 })).toBe(false)
    expect(
      isRectStyle({
        ...defaultRectStyle,
        effect: { kind: "mosaic", strength: 1 },
      }),
    ).toBe(false)
    expect(
      isRectStyle({
        ...defaultRectStyle,
        effect: { kind: "mosaic", strength: 25 },
      }),
    ).toBe(false)
  })

  it("rejects an effect mode the app does not offer", () => {
    expect(
      isRectStyle({
        ...defaultRectStyle,
        effect: { kind: "pixelate", strength: 8 },
      }),
    ).toBe(false)
  })

  it("rejects a style with neither a border nor a fill", () => {
    expect(
      isRectStyle({ ...defaultRectStyle, fillColor: null, strokeColor: null }),
    ).toBe(false)
  })

  it("rejects a shape that is not a style at all", () => {
    expect(isRectStyle(null)).toBe(false)
    expect(isRectStyle({ opacity: 1 })).toBe(false)
    expect(isRectStyle({ ...defaultRectStyle, strokeColor: "red" })).toBe(false)
  })
})
