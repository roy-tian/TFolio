import { describe, expect, test } from "bun:test"

import {
  defaultLanguage,
  resolveSupportedLanguage,
  selectPreferredLanguage,
} from "./config"

describe("resolveSupportedLanguage", () => {
  test.each([
    ["zh", "zh-CN"],
    ["zh-CN", "zh-CN"],
    ["zh_Hans_CN", "zh-CN"],
    ["zh-TW", "zh-CN"],
    ["en", "en"],
    ["en-GB", "en"],
    ["EN_us", "en"],
  ] as const)("maps %s to %s", (language, expected) => {
    expect(resolveSupportedLanguage(language)).toBe(expected)
  })

  test.each([null, undefined, "", "fr-FR"])(
    "does not map unsupported locale %s",
    (language) => {
      expect(resolveSupportedLanguage(language)).toBeNull()
    },
  )
})

describe("selectPreferredLanguage", () => {
  test("prefers a saved selection over system languages", () => {
    expect(selectPreferredLanguage("en", ["zh-CN"])).toBe("en")
  })

  test("uses the first supported system language", () => {
    expect(selectPreferredLanguage(null, ["fr-FR", "en-GB", "zh-CN"])).toBe(
      "en",
    )
  })

  test("ignores an invalid saved value", () => {
    expect(selectPreferredLanguage("invalid", ["zh-TW"])).toBe("zh-CN")
  })

  test("falls back when no candidate is supported", () => {
    expect(selectPreferredLanguage(null, ["fr-FR"])).toBe(defaultLanguage)
  })
})
