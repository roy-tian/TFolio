export const supportedLanguages = ["zh-CN", "en"] as const

export type SupportedLanguage = (typeof supportedLanguages)[number]

export const defaultLanguage: SupportedLanguage = "zh-CN"
export const fallbackLanguage: SupportedLanguage = "en"
export const languageStorageKey = "tfolio.ui.language"

export function resolveSupportedLanguage(
  language: string | null | undefined,
): SupportedLanguage | null {
  if (!language) {
    return null
  }

  const normalizedLanguage = language.trim().replaceAll("_", "-").toLowerCase()

  if (normalizedLanguage === "zh" || normalizedLanguage.startsWith("zh-")) {
    return "zh-CN"
  }

  if (normalizedLanguage === "en" || normalizedLanguage.startsWith("en-")) {
    return "en"
  }

  return null
}

function readStoredLanguage(): string | null {
  try {
    return window.localStorage.getItem(languageStorageKey)
  } catch {
    return null
  }
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
  try {
    window.localStorage.setItem(languageStorageKey, language)
  } catch {
    // A restricted WebView can disable storage. The active session still works.
  }
}
