import { describe, expect, test } from "bun:test"

import { odometerColumns } from "@/lib/odometer"

describe("odometerColumns", () => {
  test("turns only the places that changed", () => {
    expect(odometerColumns(12, 13)).toEqual([
      { from: "1", place: 1, rolls: false, to: "1" },
      { from: "2", place: 0, rolls: true, to: "3" },
    ])
    expect(odometerColumns(19, 20)).toEqual([
      { from: "1", place: 1, rolls: true, to: "2" },
      { from: "9", place: 0, rolls: true, to: "0" },
    ])
  })

  test("opens a column the shorter value never reached", () => {
    expect(odometerColumns(9, 10)).toEqual([
      { from: "", place: 1, rolls: true, to: "1" },
      { from: "9", place: 0, rolls: true, to: "0" },
    ])
    expect(odometerColumns(100, 99)).toEqual([
      { from: "1", place: 2, rolls: true, to: "" },
      { from: "0", place: 1, rolls: true, to: "9" },
      { from: "0", place: 0, rolls: true, to: "9" },
    ])
  })

  test("leaves a value that did not move standing still", () => {
    expect(odometerColumns(7, 7)).toEqual([
      { from: "7", place: 0, rolls: false, to: "7" },
    ])
  })
})
