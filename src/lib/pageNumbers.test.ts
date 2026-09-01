import { describe, expect, it } from "bun:test"

import {
  clampPageNumbersStart,
  draftFirstPrinted,
  draftFromConfig,
  draftFromPreferences,
  defaultPageNumbersPreferences,
  isPageNumbersPreferences,
  pageNumbersLabel,
  pageNumbersPreferences,
  parsePageNumbersDraft,
  samePageNumbersConfig,
  type PageNumbersConfig,
  type PageNumbersDraft,
} from "@/lib/pageNumbers"

function config(overrides: Partial<PageNumbersConfig> = {}): PageNumbersConfig {
  return {
    mode: "single",
    position: "bottomCenter",
    range: null,
    smartColor: true,
    start: null,
    blankNumbered: true,
    blankCounted: true,
    ...overrides,
  }
}

function draft(overrides: Partial<PageNumbersDraft> = {}): PageNumbersDraft {
  return {
    mode: "single",
    position: "bottomCenter",
    smartColor: true,
    blankNumbered: true,
    blankCounted: true,
    rangeFrom: "",
    rangeTo: "",
    start: "",
    ...overrides,
  }
}

describe("parsePageNumbersDraft", () => {
  it("numbers every page when both ends of the range are blank", () => {
    const { config: parsed, error } = parsePageNumbersDraft(draft(), 10)

    expect(error).toBeNull()
    expect(parsed).toEqual(config())
  })

  it("reads a valid range", () => {
    const { config: parsed, error } = parsePageNumbersDraft(
      draft({ rangeFrom: "2", rangeTo: "4" }),
      10,
    )

    expect(error).toBeNull()
    expect(parsed?.range).toEqual([2, 4])
  })

  it("reads the whole document as no range at all", () => {
    const { config: parsed, error } = parsePageNumbersDraft(
      draft({ rangeFrom: "1", rangeTo: "10" }),
      10,
    )

    expect(error).toBeNull()
    expect(parsed?.range).toBeNull()
  })

  it("fills a blank end of the range from the document", () => {
    expect(parsePageNumbersDraft(draft({ rangeFrom: "3" }), 10).config?.range).toEqual(
      [3, 10],
    )
    expect(parsePageNumbersDraft(draft({ rangeTo: "4" }), 10).config?.range).toEqual([
      1, 4,
    ])
  })

  it("rejects an unusable range", () => {
    const cases: PageNumbersDraft[] = [
      draft({ rangeFrom: "0", rangeTo: "4" }),
      draft({ rangeFrom: "5", rangeTo: "4" }),
      draft({ rangeFrom: "1", rangeTo: "11" }),
      draft({ rangeFrom: "1.5", rangeTo: "4" }),
      draft({ rangeFrom: "11" }),
      draft({ rangeTo: "0" }),
    ]

    for (const value of cases) {
      const { config: parsed, error } = parsePageNumbersDraft(value, 10)
      expect(parsed).toBeNull()
      expect(error).toBe("range")
    }
  })

  it("treats a blank start as document positions", () => {
    expect(parsePageNumbersDraft(draft({ start: "  " }), 10).config?.start).toBeNull()
  })

  it("reads a custom start, bounded by the document", () => {
    expect(parsePageNumbersDraft(draft({ start: "10" }), 10).config?.start).toBe(10)

    for (const start of ["0", "-1", "11", "100000", "abc", "1.5"]) {
      const { config: parsed, error } = parsePageNumbersDraft(draft({ start }), 10)
      expect(parsed).toBeNull()
      expect(error).toBe("start")
    }
  })

  it("gives an uncounted blank page no number to print", () => {
    const parsed = parsePageNumbersDraft(
      draft({ blankCounted: false, blankNumbered: true }),
      10,
    ).config

    expect(parsed?.blankCounted).toBe(false)
    expect(parsed?.blankNumbered).toBe(false)
  })
})

describe("clampPageNumbersStart", () => {
  it("snaps a start back into the document", () => {
    expect(clampPageNumbersStart("11", 10)).toBe("10")
    expect(clampPageNumbersStart("100000", 10)).toBe("10")
    expect(clampPageNumbersStart("0", 10)).toBe("1")
    expect(clampPageNumbersStart("-4", 10)).toBe("1")
    expect(clampPageNumbersStart(" 1.5 ", 10)).toBe("2")
  })

  it("leaves a start the document reaches alone", () => {
    expect(clampPageNumbersStart("1", 10)).toBe("1")
    expect(clampPageNumbersStart("10", 10)).toBe("10")
  })

  it("keeps a blank field blank, and anything unreadable as it is", () => {
    expect(clampPageNumbersStart("", 10)).toBe("")
    expect(clampPageNumbersStart("   ", 10)).toBe("")
    expect(clampPageNumbersStart("abc", 10)).toBe("abc")
  })
})

describe("samePageNumbersConfig", () => {
  it("compares by field, including the range tuple", () => {
    expect(samePageNumbersConfig(config(), config())).toBe(true)
    expect(
      samePageNumbersConfig(config({ range: [1, 3] }), config({ range: [1, 3] })),
    ).toBe(true)
    expect(
      samePageNumbersConfig(config({ range: [1, 3] }), config({ range: [1, 4] })),
    ).toBe(false)
    expect(samePageNumbersConfig(config(), config({ smartColor: false }))).toBe(
      false,
    )
    expect(samePageNumbersConfig(config(), config({ blankCounted: false }))).toBe(
      false,
    )
    expect(samePageNumbersConfig(null, null)).toBe(true)
    expect(samePageNumbersConfig(config(), null)).toBe(false)
  })
})

describe("draft round trips", () => {
  it("restores an existing config into an editable draft", () => {
    const source = config({ position: "bottomRight", range: [2, 5], start: 3 })
    const { config: parsed } = parsePageNumbersDraft(draftFromConfig(source, 10), 10)

    expect(parsed).toEqual(source)
  })

  it("opens fresh from preferences on the whole document", () => {
    const fresh = draftFromPreferences(defaultPageNumbersPreferences, 10)

    expect(fresh.rangeFrom).toBe("1")
    expect(fresh.rangeTo).toBe("10")
    expect(fresh.start).toBe("1")
    expect(fresh.smartColor).toBe(true)
    expect(fresh.blankNumbered).toBe(true)
    expect(fresh.blankCounted).toBe(true)
    expect(parsePageNumbersDraft(fresh, 10).config?.range).toBeNull()
  })

  it("spells the document out for a config that numbers every page", () => {
    expect(draftFromConfig(config(), 10)).toMatchObject({
      rangeFrom: "1",
      rangeTo: "10",
    })
  })

  it("leaves the range blank with no document to measure", () => {
    const fresh = draftFromPreferences(defaultPageNumbersPreferences, 0)

    expect(fresh.rangeFrom).toBe("")
    expect(fresh.rangeTo).toBe("")
  })
})

describe("preferences", () => {
  it("keeps only the style, never the document-relative range or start", () => {
    expect(
      pageNumbersPreferences(
        config({
          position: "bottomRight",
          range: [2, 4],
          start: 9,
          smartColor: false,
          blankNumbered: false,
        }),
      ),
    ).toEqual({
      mode: "single",
      position: "bottomRight",
      smartColor: false,
      blankNumbered: false,
      blankCounted: true,
    })
  })

  it("rejects a record the stored file could have been edited into", () => {
    const stored = pageNumbersPreferences(config())

    expect(isPageNumbersPreferences(stored)).toBe(true)
    expect(isPageNumbersPreferences(null)).toBe(false)
    expect(isPageNumbersPreferences({ ...stored, mode: "triple" })).toBe(false)
    expect(isPageNumbersPreferences({ ...stored, blankCounted: "yes" })).toBe(false)
    // A record from before the blank-page rules existed is not one either: the
    // dialog falls back to its defaults rather than to half a style.
    const { blankCounted, ...older } = stored
    expect(isPageNumbersPreferences(older)).toBe(false)
  })
})

describe("draftFirstPrinted", () => {
  it("prefers a custom start, then the range's first page, then one", () => {
    expect(draftFirstPrinted(draft())).toBe(1)
    expect(draftFirstPrinted(draft({ rangeFrom: "4" }))).toBe(4)
    expect(draftFirstPrinted(draft({ rangeFrom: "4", start: "12" }))).toBe(12)
    expect(draftFirstPrinted(draft({ start: "not a number" }))).toBe(1)
  })
})

describe("pageNumbersLabel", () => {
  it("wraps a number in em dashes", () => {
    expect(pageNumbersLabel(7)).toBe("— 7 —")
  })
})
