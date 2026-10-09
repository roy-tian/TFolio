import type { SupportedLanguage } from "./config"
import de from "./locales/de"
import en from "./locales/en"
import es from "./locales/es"
import fr from "./locales/fr"
import it from "./locales/it"
import th from "./locales/th"
import zhCN from "./locales/zh-CN"
import zhTW from "./locales/zh-TW"
import type { TranslationSchema } from "./schema"

export const translations = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  en,
  fr,
  es,
  it,
  de,
  th,
} as const satisfies Record<SupportedLanguage, TranslationSchema>
