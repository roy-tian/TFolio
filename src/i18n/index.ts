import i18n from "i18next"
import { initReactI18next } from "react-i18next"

import {
  detectPreferredLanguage,
  fallbackLanguage,
  resolveSupportedLanguage,
  storeLanguage,
  supportedLanguages,
  type SupportedLanguage,
} from "./config"
import en from "./locales/en"
import zhCN from "./locales/zh-CN"

const resources = {
  "zh-CN": { translation: zhCN },
  en: { translation: en },
} as const

function syncDocumentLanguage(language: string) {
  const supportedLanguage =
    resolveSupportedLanguage(language) ?? fallbackLanguage

  document.documentElement.lang = supportedLanguage
  document.documentElement.dir = i18n.dir(supportedLanguage)
  document.title = i18n.t("app.documentTitle")
}

export async function initializeI18n() {
  if (!i18n.isInitialized) {
    await i18n.use(initReactI18next).init({
      resources,
      lng: detectPreferredLanguage(),
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

export async function changeLanguage(language: SupportedLanguage) {
  await i18n.changeLanguage(language)
  storeLanguage(language)
}

export { default as i18n } from "i18next"
