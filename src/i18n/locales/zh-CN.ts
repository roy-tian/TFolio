import type en from "./en"

type TranslationSchema<T> = {
  readonly [Key in keyof T]: T[Key] extends string
    ? string
    : TranslationSchema<T[Key]>
}

const zhCN = {
  app: {
    documentTitle: "TFolio",
  },
} as const satisfies TranslationSchema<typeof en>

export default zhCN
