import type { SupportedLanguage } from "./config"
import de from "./locales/de"
import en from "./locales/en"
import es from "./locales/es"
import fr from "./locales/fr"
import it from "./locales/it"
import ja from "./locales/ja"
import ko from "./locales/ko"
import pt from "./locales/pt"
import th from "./locales/th"
import zhCN from "./locales/zh-CN"
import zhTW from "./locales/zh-TW"
import type { TranslationSchema } from "./schema"

export const translations = {
  "zh-CN": zhCN,
  "zh-TW": zhTW,
  th,
  ja,
  ko,
  en,
  de,
  fr,
  es,
  pt,
  it,
} as const satisfies Record<SupportedLanguage, TranslationSchema>
