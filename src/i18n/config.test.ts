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
    ["zh-SG", "zh-CN"],
    ["zh_Hans_CN", "zh-CN"],
    ["zh-Hans-HK", "zh-CN"],
    ["zh-TW", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh_Hant", "zh-TW"],
    ["en", "en"],
    ["en-GB", "en"],
    ["EN_us", "en"],
    ["fr", "fr"],
    ["fr-CA", "fr"],
    ["es-419", "es"],
    ["it-IT", "it"],
    ["de-AT", "de"],
    ["th-TH-u-nu-thai", "th"],
  ] as const)("maps %s to %s", (language, expected) => {
    expect(resolveSupportedLanguage(language)).toBe(expected)
  })

  test.each([null, undefined, "", "pt-BR", "eng"])(
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
    expect(selectPreferredLanguage(null, ["pt-BR", "de-CH", "zh-CN"])).toBe(
      "de",
    )
  })

  test("ignores an invalid saved value", () => {
    expect(selectPreferredLanguage("invalid", ["zh-TW"])).toBe("zh-TW")
  })

  test("falls back when no candidate is supported", () => {
    expect(selectPreferredLanguage(null, ["pt-BR"])).toBe(defaultLanguage)
  })
})
