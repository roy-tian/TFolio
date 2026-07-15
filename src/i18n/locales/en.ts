const en = {
  app: {
    documentTitle: "TFolio",
  },
  toolbar: {
    hideBookmarks: "Hide bookmarks",
    showBookmarks: "Show bookmarks",
    pageStatus: "Page {{current}} of {{total}}",
    pageNumberInput: "Page number",
    more: "More",
    language: "Language",
    about: "About",
  },
  language: {
    simplifiedChinese: "Simplified Chinese",
    english: "English",
  },
  viewer: {
    dropTitle: "Drop a PDF here",
    dropDescription: "or click to choose a file",
    chooseFile: "Choose a PDF file",
    loading: "Opening PDF…",
    dropNow: "Drop to open this PDF",
    replaceHint: "The current document will be replaced",
    fileTooLarge: "PDF files must be no larger than 512 MiB.",
    invalidFile: "Please choose a PDF file.",
    openFailed: "This PDF could not be opened.",
    pageLabel: "Page {{pageNumber}}",
    pageError: "Page {{pageNumber}} could not be rendered",
  },
  bookmarks: {
    title: "Bookmarks",
    empty: "This document has no bookmarks.",
    untitled: "Untitled bookmark",
  },
  about: {
    title: "TFolio",
    description: "A focused desktop workspace for reading and editing PDF files.",
    copyright: "Copyright © 2026 Roy Tian",
    close: "Close",
  },
} as const

export default en
