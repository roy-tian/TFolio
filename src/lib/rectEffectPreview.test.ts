import { describe, expect, it } from "bun:test"

import {
  MAX_RECT_EFFECT_PREVIEW_PIXELS,
  rectEffectPreviewScale,
  sourceCropForRotatedRect,
} from "@/lib/rectEffectPreview"

const rect = { height: 0.3, left: 0.2, top: 0.1, width: 0.4 }
const source = { height: 300, width: 200 }

describe("sourceCropForRotatedRect", () => {
  it("uses the displayed box directly without a reader rotation", () => {
    expect(sourceCropForRotatedRect(rect, source, 0)).toEqual({
      height: 90,
      left: 40,
      top: 30,
      width: 80,
    })
  })

  it("maps a clockwise quarter-turn back to the source canvas", () => {
    expect(sourceCropForRotatedRect(rect, source, 90)).toEqual({
      height: 120,
      left: 20,
      top: 120,
      width: 60,
    })
  })

  it("maps a half-turn back to the opposite source corner", () => {
    expect(sourceCropForRotatedRect(rect, source, 180)).toEqual({
      height: 90,
      left: 80,
      top: 180,
      width: 80,
    })
  })

  it("maps a counter-clockwise quarter-turn back to the source canvas", () => {
    expect(sourceCropForRotatedRect(rect, source, 270)).toEqual({
      height: 120,
      left: 120,
      top: 60,
      width: 60,
    })
  })
})

describe("rectEffectPreviewScale", () => {
  it("keeps a small mosaic at source resolution", () => {
    expect(
      rectEffectPreviewScale(
        { height: 300, width: 200 },
        { kind: "mosaic", strength: 12 },
        2,
      ),
    ).toBe(1)
  })

  it("caps a full-page mosaic preview", () => {
    const scale = rectEffectPreviewScale(
      { height: 1754, width: 1240 },
      { kind: "mosaic", strength: 12 },
      1240 / 595,
    )

    expect(scale).toBeLessThan(1)
    expect(1240 * scale * (1754 * scale)).toBeLessThanOrEqual(
      MAX_RECT_EFFECT_PREVIEW_PIXELS + 1,
    )
  })

  it("includes blur padding in the same pixel budget", () => {
    const crop = { height: 1754, width: 1240 }
    const pixelsPerPoint = 1240 / 595
    const strength = 24
    const scale = rectEffectPreviewScale(
      crop,
      { kind: "blur", strength },
      pixelsPerPoint,
    )
    const padding = strength * pixelsPerPoint * scale * 3

    expect(
      (crop.width * scale + padding * 2) *
        (crop.height * scale + padding * 2),
    ).toBeLessThanOrEqual(MAX_RECT_EFFECT_PREVIEW_PIXELS + 1)
  })
})
