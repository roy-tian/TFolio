import { describe, expect, test } from "bun:test"

import {
  defaultLanguage,
  resolveLanguagePreference,
  resolveSupportedLanguage,
  selectSystemLanguage,
  systemLanguage,
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
    ["ja-JP", "ja"],
    ["ko_KR", "ko"],
    ["pt-BR", "pt"],
    ["pt-PT", "pt"],
  ] as const)("maps %s to %s", (language, expected) => {
    expect(resolveSupportedLanguage(language)).toBe(expected)
  })

  test.each([null, undefined, "", "nl-NL", "eng"])(
    "does not map unsupported locale %s",
    (language) => {
      expect(resolveSupportedLanguage(language)).toBeNull()
    },
  )
})

describe("resolveLanguagePreference", () => {
  test("keeps a chosen language", () => {
    expect(resolveLanguagePreference("en")).toBe("en")
    expect(resolveLanguagePreference("zh")).toBe("zh-CN")
  })

  test.each([undefined, null, 3, "", "invalid", systemLanguage])(
    "follows the system for %s",
    (stored) => {
      expect(resolveLanguagePreference(stored)).toBe(systemLanguage)
    },
  )
})

describe("selectSystemLanguage", () => {
  test("uses the first supported system language", () => {
    expect(selectSystemLanguage(["nl-NL", "de-CH", "zh-CN"])).toBe("de")
  })

  test("falls back when no candidate is supported", () => {
    expect(selectSystemLanguage(["nl-NL"])).toBe(defaultLanguage)
  })
})
