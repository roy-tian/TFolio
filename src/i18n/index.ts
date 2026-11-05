import i18n from "i18next"
import { useSyncExternalStore } from "react"
import { initReactI18next } from "react-i18next"

import {
  fallbackLanguage,
  languageForPreference,
  resolveSupportedLanguage,
  storedLanguagePreference,
  storeLanguagePreference,
  supportedLanguages,
  systemLanguage,
  type LanguagePreference,
} from "./config"
import { translations } from "./resources"

const resources = Object.fromEntries(
  supportedLanguages.map((language) => [
    language,
    { translation: translations[language] },
  ]),
)

function syncDocumentLanguage(language: string) {
  const supportedLanguage =
    resolveSupportedLanguage(language) ?? fallbackLanguage

  document.documentElement.lang = supportedLanguage
  document.documentElement.dir = i18n.dir(supportedLanguage)
  document.title = i18n.t("app.documentTitle")
}

/** This window's own choice, not the stored one: language applies only at boot,
    so another window's later pick must not show here as if it were in effect. */
let preference: LanguagePreference = systemLanguage
const listeners = new Set<() => void>()

export async function initializeI18n() {
  if (!i18n.isInitialized) {
    preference = storedLanguagePreference()

    await i18n.use(initReactI18next).init({
      resources,
      lng: languageForPreference(preference),
      fallbackLng: fallbackLanguage,
      supportedLngs: supportedLanguages,
      load: "currentOnly",
      interpolation: {
        escapeValue: false,
      },
      react: {
        useSuspense: false,
      },
      returnNull: false,
    })

    i18n.on("languageChanged", syncDocumentLanguage)
  }

  syncDocumentLanguage(i18n.resolvedLanguage ?? i18n.language)

  return i18n
}

export async function changeLanguagePreference(next: LanguagePreference) {
  preference = next
  listeners.forEach((listener) => listener())
  storeLanguagePreference(next)
  await i18n.changeLanguage(languageForPreference(next))
}

function subscribe(listener: () => void) {
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
  }
}

function getLanguagePreference(): LanguagePreference {
  return preference
}

export function useLanguagePreference(): LanguagePreference {
  return useSyncExternalStore(
    subscribe,
    getLanguagePreference,
    getLanguagePreference,
  )
}

export { default as i18n } from "i18next"
