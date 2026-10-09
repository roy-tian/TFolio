import { rememberSettings, storedSettings } from "@/lib/settings"

export const supportedLanguages = [
  "zh-CN",
  "zh-TW",
  "en",
  "fr",
  "es",
  "it",
  "de",
  "th",
] as const

export type SupportedLanguage = (typeof supportedLanguages)[number]

/** Each language named in itself, never translated: a reader stranded in an
    interface they cannot read must still recognise their own. */
export const languageNames: Record<SupportedLanguage, string> = {
  "zh-CN": "简体中文",
  "zh-TW": "繁體中文",
  en: "English",
  fr: "Français",
  es: "Español",
  it: "Italiano",
  de: "Deutsch",
  th: "ภาษาไทย",
}

export const defaultLanguage: SupportedLanguage = "zh-CN"
export const fallbackLanguage: SupportedLanguage = "en"

/** Read only when no script subtag (Hans/Hant) settles it. */
const traditionalChineseRegions = new Set(["tw", "hk", "mo"])

export function resolveSupportedLanguage(
  language: string | null | undefined,
): SupportedLanguage | null {
  if (!language) {
    return null
  }

  const [base, ...subtags] = language
    .trim()
    .replaceAll("_", "-")
    .toLowerCase()
    .split("-")

  if (base === "zh") {
    if (subtags.includes("hant")) {
      return "zh-TW"
    }

    if (subtags.includes("hans")) {
      return "zh-CN"
    }

    return subtags.some((tag) => traditionalChineseRegions.has(tag))
      ? "zh-TW"
      : "zh-CN"
  }

  return supportedLanguages.find((supported) => supported === base) ?? null
}

function readStoredLanguage(): string | null {
  const stored = storedSettings().ui?.language

  return typeof stored === "string" ? stored : null
}

export function selectPreferredLanguage(
  storedLanguage: string | null | undefined,
  preferredLanguages: readonly string[],
): SupportedLanguage {
  const supportedStoredLanguage = resolveSupportedLanguage(storedLanguage)

  if (supportedStoredLanguage) {
    return supportedStoredLanguage
  }

  for (const language of preferredLanguages) {
    const supportedLanguage = resolveSupportedLanguage(language)

    if (supportedLanguage) {
      return supportedLanguage
    }
  }

  return defaultLanguage
}

export function detectPreferredLanguage(): SupportedLanguage {
  const preferredLanguages = navigator.languages.length
    ? navigator.languages
    : [navigator.language]

  return selectPreferredLanguage(readStoredLanguage(), preferredLanguages)
}

export function storeLanguage(language: SupportedLanguage) {
  rememberSettings({ ui: { language } })
}
