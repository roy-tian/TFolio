import { describe, expect, test } from "bun:test"

import {
  describeRecentFiles,
  directoryFromPath,
  parseRecentPdfView,
  type RecentPdfView,
} from "./recentFiles"

describe("recent files", () => {
  test("reads the containing folder from either platform's separator", () => {
    expect(directoryFromPath("/home/roy/docs/a.pdf")).toBe("/home/roy/docs")
    expect(directoryFromPath("C:\\Users\\roy\\a.pdf")).toBe("C:\\Users\\roy")
    expect(directoryFromPath("/a.pdf")).toBe("/")
    expect(directoryFromPath("C:\\a.pdf")).toBe("C:\\")
    expect(directoryFromPath("a.pdf")).toBe("")
  })

  test("shows the newest files first and no more than the limit", () => {
    const paths = ["/1.pdf", "/2.pdf", "/3.pdf", "/4.pdf", "/5.pdf", "/6.pdf"]

    expect(describeRecentFiles(paths).map((file) => file.path)).toEqual([
      "/1.pdf",
      "/2.pdf",
      "/3.pdf",
      "/4.pdf",
      "/5.pdf",
    ])
  })

  test("names the file and the folder it sits in", () => {
    expect(describeRecentFiles(["/home/roy/docs/report.pdf"])).toEqual([
      {
        directory: "/home/roy/docs",
        name: "report.pdf",
        path: "/home/roy/docs/report.pdf",
      },
    ])
  })

  test("accepts a usable persisted view", () => {
    const view: RecentPdfView = {
      position: { fractionX: 0.5, fractionY: 0.4, pageNumber: 3 },
      viewMode: "book",
      zoom: { customScale: 1.25, fitPage: 3, mode: "custom" },
    }

    expect(parseRecentPdfView(view)).toEqual(view)
  })

  test("drops a persisted view with unusable geometry", () => {
    const view: RecentPdfView = {
      position: { fractionX: 0.5, fractionY: 0.4, pageNumber: 3 },
      viewMode: "book",
      zoom: { customScale: 1.25, fitPage: 3, mode: "custom" },
    }

    expect(
      parseRecentPdfView({
        ...view,
        zoom: { ...view.zoom, customScale: 1000 },
      }),
    ).toBeNull()
    expect(
      parseRecentPdfView({
        ...view,
        position: { ...view.position, pageNumber: "3" },
      }),
    ).toBeNull()
    expect(parseRecentPdfView({ ...view, viewMode: "continuous" })).toBeNull()
  })
})
