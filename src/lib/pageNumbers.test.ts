import { afterEach, beforeEach, describe, expect, it } from "bun:test"

import {
  draftFromConfig,
  draftFromPreferences,
  defaultPageNumbersPreferences,
  pageNumbersLabel,
  pageNumbersPreferencesStorageKey,
  parsePageNumbersDraft,
  readStoredPageNumbersPreferences,
  samePageNumbersConfig,
  storePageNumbersPreferences,
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
    ...overrides,
  }
}

function draft(overrides: Partial<PageNumbersDraft> = {}): PageNumbersDraft {
  return {
    mode: "single",
    position: "bottomCenter",
    smartColor: true,
    allPages: true,
    rangeFrom: "",
    rangeTo: "",
    start: "",
    ...overrides,
  }
}

describe("parsePageNumbersDraft", () => {
  it("numbers every page when the range is off", () => {
    const { config: parsed, error } = parsePageNumbersDraft(draft(), 10)

    expect(error).toBeNull()
    expect(parsed).toEqual(config())
  })

  it("reads a valid range", () => {
    const { config: parsed, error } = parsePageNumbersDraft(
      draft({ allPages: false, rangeFrom: "2", rangeTo: "4" }),
      10,
    )

    expect(error).toBeNull()
    expect(parsed?.range).toEqual([2, 4])
  })

  it("rejects an unusable range", () => {
    const cases: PageNumbersDraft[] = [
      draft({ allPages: false, rangeFrom: "", rangeTo: "4" }),
      draft({ allPages: false, rangeFrom: "0", rangeTo: "4" }),
      draft({ allPages: false, rangeFrom: "5", rangeTo: "4" }),
      draft({ allPages: false, rangeFrom: "1", rangeTo: "11" }),
      draft({ allPages: false, rangeFrom: "1.5", rangeTo: "4" }),
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

  it("reads and bounds a custom start", () => {
    expect(parsePageNumbersDraft(draft({ start: "10" }), 10).config?.start).toBe(10)

    for (const start of ["0", "-1", "100000", "abc", "1.5"]) {
      const { config: parsed, error } = parsePageNumbersDraft(draft({ start }), 10)
      expect(parsed).toBeNull()
      expect(error).toBe("start")
    }
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
    expect(samePageNumbersConfig(null, null)).toBe(true)
    expect(samePageNumbersConfig(config(), null)).toBe(false)
  })
})

describe("draft round trips", () => {
  it("restores an existing config into an editable draft", () => {
    const source = config({ position: "bottomRight", range: [2, 5], start: 3 })
    const { config: parsed } = parsePageNumbersDraft(draftFromConfig(source), 10)

    expect(parsed).toEqual(source)
  })

  it("opens fresh from preferences with every page numbered", () => {
    const fresh = draftFromPreferences(defaultPageNumbersPreferences)

    expect(fresh.allPages).toBe(true)
    expect(fresh.start).toBe("")
    expect(fresh.smartColor).toBe(true)
  })
})

describe("preferences persistence", () => {
  // The Bun runner has no DOM, so stand up an in-memory localStorage the way
  // `watermark.test.ts` does for its own migration test.
  let previousWindow: PropertyDescriptor | undefined
  let store: Map<string, string>

  beforeEach(() => {
    previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window")
    store = new Map<string, string>()

    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        localStorage: {
          getItem: (key: string) => store.get(key) ?? null,
          setItem: (key: string, value: string) => store.set(key, value),
          removeItem: (key: string) => store.delete(key),
        },
      },
    })
  })

  afterEach(() => {
    if (previousWindow) {
      Object.defineProperty(globalThis, "window", previousWindow)
    } else {
      Reflect.deleteProperty(globalThis, "window")
    }
  })

  it("stores only the style, never the document-relative range or start", () => {
    storePageNumbersPreferences(
      config({ position: "bottomRight", range: [2, 4], start: 9, smartColor: false }),
    )

    expect(JSON.parse(store.get(pageNumbersPreferencesStorageKey)!)).toEqual({
      mode: "single",
      position: "bottomRight",
      smartColor: false,
    })
    expect(readStoredPageNumbersPreferences()).toEqual({
      mode: "single",
      position: "bottomRight",
      smartColor: false,
    })
  })

  it("rejects a malformed record", () => {
    store.set(pageNumbersPreferencesStorageKey, "{ not json")
    expect(readStoredPageNumbersPreferences()).toBeNull()

    store.set(pageNumbersPreferencesStorageKey, JSON.stringify({ mode: "triple" }))
    expect(readStoredPageNumbersPreferences()).toBeNull()
  })
})

describe("pageNumbersLabel", () => {
  it("wraps a number in em dashes", () => {
    expect(pageNumbersLabel(7)).toBe("— 7 —")
  })
})
