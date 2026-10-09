import type en from "./locales/en"

type Schema<T> = {
  readonly [Key in keyof T]: T[Key] extends string ? string : Schema<T[Key]>
}

/** Every locale carries exactly `en`'s keys, with free text in place of its literals. */
export type TranslationSchema = Schema<typeof en>
