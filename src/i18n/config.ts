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

/** Follows the system's languages, read at each boot; also what an unset or
    unreadable setting means, so a fresh install starts on it. */
export const systemLanguage = "system"

export type LanguagePreference = SupportedLanguage | typeof systemLanguage

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

/** A hand-edited "zh" still counts as Chinese; anything unrecognised follows the system. */
export function resolveLanguagePreference(
  stored: unknown,
): LanguagePreference {
  return typeof stored === "string"
    ? (resolveSupportedLanguage(stored) ?? systemLanguage)
    : systemLanguage
}

export function storedLanguagePreference(): LanguagePreference {
  return resolveLanguagePreference(storedSettings().ui?.language)
}

export function selectSystemLanguage(
  preferredLanguages: readonly string[],
): SupportedLanguage {
  for (const language of preferredLanguages) {
    const supportedLanguage = resolveSupportedLanguage(language)

    if (supportedLanguage) {
      return supportedLanguage
    }
  }

  return defaultLanguage
}

export function detectSystemLanguage(): SupportedLanguage {
  return selectSystemLanguage(
    navigator.languages.length ? navigator.languages : [navigator.language],
  )
}

export function languageForPreference(
  preference: LanguagePreference,
): SupportedLanguage {
  return preference === systemLanguage ? detectSystemLanguage() : preference
}

export function storeLanguagePreference(preference: LanguagePreference) {
  rememberSettings({ ui: { language: preference } })
}
