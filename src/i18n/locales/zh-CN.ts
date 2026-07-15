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
  toolbar: {
    hideBookmarks: "隐藏书签",
    showBookmarks: "显示书签",
    pageStatus: "第 {{current}} 页，共 {{total}} 页",
    pageNumberInput: "页码",
    more: "更多",
    language: "语言",
    about: "关于",
  },
  language: {
    simplifiedChinese: "简体中文",
    english: "英文",
  },
  viewer: {
    dropTitle: "将 PDF 拖到这里",
    dropDescription: "也可以点击选择文件",
    chooseFile: "选择 PDF 文件",
    loading: "正在打开 PDF…",
    dropNow: "松开以打开此 PDF",
    replaceHint: "当前文档将被替换",
    fileTooLarge: "PDF 文件不能超过 512 MiB。",
    invalidFile: "请选择 PDF 文件。",
    openFailed: "无法打开此 PDF 文件。",
    pageLabel: "第 {{pageNumber}} 页",
    pageError: "第 {{pageNumber}} 页渲染失败",
  },
  bookmarks: {
    title: "书签",
    empty: "此文档没有书签。",
    untitled: "未命名书签",
  },
  about: {
    title: "TFolio",
    description: "专注于阅读和编辑 PDF 文件的桌面工作空间。",
    copyright: "版权所有 © 2026 Roy Tian",
    close: "关闭",
  },
} as const satisfies TranslationSchema<typeof en>

export default zhCN
