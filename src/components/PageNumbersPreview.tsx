import {
  pageNumbersLabel,
  PAGE_NUMBERS_BOTTOM_MARGIN,
  PAGE_NUMBERS_FONT_STACK,
  PAGE_NUMBERS_SIDE_MARGIN,
  type PageNumbersPlacement,
} from "@/lib/pageNumbers"

/** A4's width in points: the sheet this preview stands in for, so the margins
    below can be read straight off the backend's own constants. */
const A4_WIDTH = 595.276
/** How much of the page's bottom is shown, in points — a third of A4. The torn
    top edge is what says the rest of the page carries on above. */
const SLICE_HEIGHT = 280
/** Teeth across the tear. Even, so it starts and ends on the paper's edge. */
const TEAR_TEETH = 56
/** Against the 11 pt the page sets: true to scale the label would be four
    pixels tall, so the preview magnifies it and keeps placement honest. */
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
      className="absolute inset-x-0 top-0 h-[3px] w-full"
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
  captions: { even: string; every: string; odd: string }
  placement: PageNumbersPlacement
  printed: number
}

export function PageNumbersPreview({
  captions,
  placement,
  printed,
}: PageNumbersPreviewProps) {
  if (placement === "auto") {
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
        anchor={placement === "bottomRight" ? "right" : "center"}
        caption={captions.every}
        printed={printed}
        testId="page-numbers-sample"
      />
    </div>
  )
}
