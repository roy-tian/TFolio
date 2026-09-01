import {
  pageNumbersLabel,
  PAGE_NUMBERS_BOTTOM_MARGIN,
  PAGE_NUMBERS_FONT_STACK,
  PAGE_NUMBERS_SIDE_MARGIN,
  type PageNumbersMode,
  type PageNumbersPosition,
} from "@/lib/pageNumbers"

/** A4's width in points: the sheet this preview stands in for, so the margins
    below can be read straight off the backend's own constants. */
const A4_WIDTH = 595.276
/** How much of the page's bottom is shown, in points — a third of A4. The torn
    top edge is what says the rest of the page carries on above. */
const SLICE_HEIGHT = 280
/** Teeth across the tear. Even, so it starts and ends on the paper's edge. */
const TEAR_TEETH = 28
/**
 * The label's size here, in pixels, against the 11 pt it is set in on the page.
 * At this width a true-to-scale label would be four pixels tall and unreadable,
 * so the preview magnifies the number and keeps only its placement honest.
 */
const LABEL_SIZE = 10

/** Which edge of the sheet a number is measured from, mirroring
    `PageNumberAnchor` in `page_numbers.rs`. */
type Anchor = "center" | "left" | "right"

function offset(points: number, extent: number) {
  return `${(points / extent) * 100}%`
}

function anchorStyle(anchor: Anchor) {
  const side = offset(PAGE_NUMBERS_SIDE_MARGIN, A4_WIDTH)

  switch (anchor) {
    case "left":
      return { left: side }
    case "right":
      return { right: side }
    default:
      return { left: "50%", transform: "translateX(-50%)" }
  }
}

/** The paper's ragged top: everything above the zigzag is the dialog's own
    surface, so the sheet reads as a page torn across rather than a short one. */
function TornEdge() {
  const points = Array.from(
    { length: TEAR_TEETH + 1 },
    (_, index) => `${index},${index % 2 === 0 ? 0 : 1}`,
  ).join(" ")

  return (
    <svg
      aria-hidden
      className="absolute inset-x-0 top-0 h-1.5 w-full"
      preserveAspectRatio="none"
      viewBox={`0 0 ${TEAR_TEETH} 1`}
    >
      <polygon fill="var(--popover)" points={points} />
      <polyline
        fill="none"
        points={points}
        stroke="var(--border)"
        strokeWidth={1}
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  )
}

type SheetProps = {
  anchor: Anchor
  caption: string
  printed: number
  testId?: string
}

function Sheet({ anchor, caption, printed, testId }: SheetProps) {
  return (
    <div className="flex flex-col gap-1">
      <div
        className="relative w-full overflow-hidden rounded-b-md border border-t-0 bg-white shadow-sm"
        style={{ aspectRatio: `${A4_WIDTH} / ${SLICE_HEIGHT}` }}
      >
        <TornEdge />
        <span
          className="absolute whitespace-nowrap text-black"
          data-testid={testId}
          style={{
            bottom: offset(PAGE_NUMBERS_BOTTOM_MARGIN, SLICE_HEIGHT),
            fontFamily: PAGE_NUMBERS_FONT_STACK,
            fontSize: `${LABEL_SIZE}px`,
            lineHeight: 1,
            ...anchorStyle(anchor),
          }}
        >
          {pageNumbersLabel(printed)}
        </span>
      </div>
      <span className="text-center text-xs text-muted-foreground">{caption}</span>
    </div>
  )
}

type PageNumbersPreviewProps = {
  /** What the sheets are called: one sheet for single-sided printing, an odd
      and an even one for double-sided. */
  captions: { even: string; every: string; odd: string }
  mode: PageNumbersMode
  position: PageNumbersPosition
  /** The number the first numbered page prints, so a custom start shows. */
  printed: number
}

/**
 * The bottom of the page as the reader will get it: one sheet for single-sided
 * printing, two for double-sided, where odd pages carry the number on the
 * outer right and even pages mirror it to the outer left.
 */
export function PageNumbersPreview({
  captions,
  mode,
  position,
  printed,
}: PageNumbersPreviewProps) {
  if (mode === "duplex") {
    return (
      <div className="flex flex-col gap-3" data-testid="page-numbers-preview">
        <Sheet
          anchor="right"
          caption={captions.odd}
          printed={printed}
          testId="page-numbers-sample"
        />
        <Sheet anchor="left" caption={captions.even} printed={printed + 1} />
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-3" data-testid="page-numbers-preview">
      <Sheet
        anchor={position === "bottomRight" ? "right" : "center"}
        caption={captions.every}
        printed={printed}
        testId="page-numbers-sample"
      />
    </div>
  )
}
