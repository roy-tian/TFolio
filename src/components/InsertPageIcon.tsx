import { createLucideIcon, type IconNode } from "lucide-react"

const plusNode = (x: number): IconNode => [
  ["path", { d: `M${x} 8.5v7`, key: "upright" }],
  ["path", { d: `M${x - 3.5} 12h7`, key: "across" }],
]

const pageNode = (x: number): IconNode => [
  ["rect", { height: "18", key: "page", rx: "1", width: "9", x: String(x), y: "3" }],
]

/** A plus on the side of the page it lands: the board reads left to right.
    Lucide's `between-*` glyphs point at a gap between two items instead. */
export const InsertBeforeIcon = createLucideIcon("insert-before", [
  ...plusNode(5.5),
  ...pageNode(12),
])

export const InsertAfterIcon = createLucideIcon("insert-after", [
  ...pageNode(3),
  ...plusNode(18.5),
])
