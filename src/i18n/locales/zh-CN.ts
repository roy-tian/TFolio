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
    viewMode: "视图模式",
    viewModeSingle: "单页",
    viewModeBook: "书本",
    viewModeThumbnail: "缩略图",
    pageStatus: "第 {{current}} 页，共 {{total}} 页",
    pageNumberInput: "页码",
    rotate: "顺时针旋转",
    zoomOut: "缩小",
    zoomIn: "放大",
    zoomReset: "实际大小",
    zoomLevel: "缩放 {{percent}}%",
    zoomLevelFitWidth: "缩放 {{percent}}%，适合宽度",
    zoomLevelFitHeight: "缩放 {{percent}}%，适合高度",
    zoomFitWidth: "适合宽度",
    zoomFitHeight: "适合高度",
  },
  annotate: {
    undo: "撤销",
    redo: "重做",
    highlight: "文字高亮",
    highlightOptions: "高亮设置",
    highlightColor: "高亮颜色",
    customColor: "自定义颜色",
    export: "导出副本…",
    exportFilter: "PDF 文件",
    exportDefaultName: "已批注.pdf",
    exportFailed: "无法导出此 PDF。",
    failed: "无法添加该批注。",
  },
  settings: {
    open: "设置",
    title: "设置",
    description: "调整外观、语言等应用设置。",
    appearance: "外观",
    about: "关于",
    theme: "主题",
    themeHint: "选择明亮或暗黑外观。",
    themeLight: "明亮",
    themeSystem: "跟随系统",
    themeDark: "暗黑",
    language: "语言",
    languageHint: "选择界面显示语言。",
    close: "关闭",
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
    thumbnailLabel: "跳转到第 {{pageNumber}} 页",
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
  },
} as const satisfies TranslationSchema<typeof en>

export default zhCN
