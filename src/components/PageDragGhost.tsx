import { useImperativeHandle, useLayoutEffect, useRef, type Ref } from "react"
import { FileText } from "lucide-react"
import { createPortal } from "react-dom"

import { DRAG_MOTION, prefersReducedMotion } from "@/lib/motion"
import { THUMBNAIL_WIDTH } from "@/lib/viewMode"

export type GhostPaper = {
  /** The pressed preview's pixels, copied once: a bitmap the frontend already
      holds, as page bitmaps never become `blob:` URLs. */
  canvas: HTMLCanvasElement | null
  height: number
  /** A file carried by its name: the ghost is that name alone, a strip like
      the outline's, however many pages it holds. */
  label?: string
  width: number
}

// A name strip reaches this far left of the name it was lifted by, so its
// padding puts the icon and the words over the name's own.
const STRIP_INSET = 8

export type PageDragGhostHandle = {
  /** Where the pointer is now, in client pixels. */
  moveTo: (point: { x: number; y: number }) => void
  /** Settles the stack onto a paper at this client position, or fades it out
      where it is when there is none to see; resolves once done, at once when
      no motion is wanted. */
  land: (box: { left: number; top: number } | null) => Promise<void>
}

export type PageDragGhostState = {
  count: number
  grip: { x: number; y: number }
  /** The ghost's key. A drag starting before the last one's ghost unmounted
      must not inherit its grip, its pixels or its landing's held transform. */
  id: number
  paper: GhostPaper
  point: { x: number; y: number }
}

// The landing normally ends a drag; this ends it if a motion never reports
// back, so no page stays a hole.
const LANDING_TIMEOUT_MS = 600
let ghostsLifted = 0

/** The ghost of the paper a drag has just lifted, measured rather than
    recomputed so it matches whichever surface it came from. */
export function liftGhost(
  paper: HTMLElement,
  count: number,
  start: { x: number; y: number },
  point: { x: number; y: number },
  label?: string,
): PageDragGhostState {
  const box = paper.getBoundingClientRect()
  const inset = label === undefined ? 0 : STRIP_INSET

  ghostsLifted += 1

  return {
    count,
    grip: { x: box.left - inset - start.x, y: box.top - start.y },
    id: ghostsLifted,
    paper: {
      canvas: label === undefined ? paper.querySelector("canvas") : null,
      height: box.height,
      label,
      width: box.width + inset,
    },
    point,
  }
}

/**
 * The client position a ghost lands on: the paper inside a laid-out cell, read
 * through `offset*` so a slide still running on the cell is ignored. None when
 * that paper is scrolled out of `view`: the ghost would streak across the
 * window to a place nobody sees.
 */
export function landingBox(
  container: HTMLElement,
  cell: HTMLElement | null,
  paperSelector: string,
  view: HTMLElement | null,
) {
  const paper = cell?.querySelector<HTMLElement>(paperSelector)

  if (!cell || !paper || !view) {
    return null
  }

  const origin = container.getBoundingClientRect()
  const cellBox = cell.getBoundingClientRect()
  const paperBox = paper.getBoundingClientRect()
  const shown = view.getBoundingClientRect()
  const left = origin.left + cell.offsetLeft + paperBox.left - cellBox.left
  const top = origin.top + cell.offsetTop + paperBox.top - cellBox.top

  return top < shown.bottom &&
    top + paperBox.height > shown.top &&
    left < shown.right &&
    left + paperBox.width > shown.left
    ? { left, top }
    : null
}

const LIFTED = "rotate(-2deg) scale(1.03)"
// Two cards behind the lead for a block of any size: the stack says "more than
// this one", the badge says how many.
const STACK_STEPS = [8, 4]
const stackTransform = (step: number) =>
  `translate(${step}px, ${step}px) rotate(${step / 2}deg)`

/**
 * The pages in hand: the pressed page lifted and tilted, a stack behind it for
 * more; or a file carried by its name, as that name. It follows the pointer by
 * writing its own transform, so the owner re-renders only when the landing
 * place changes, not on every pointer move.
 */
export function PageDragGhost({
  count,
  grip,
  paper,
  point,
  ref,
}: {
  count: number
  /** The paper's top-left less the pointer's, so the grabbed spot stays put. */
  grip: { x: number; y: number }
  paper: GhostPaper
  point: { x: number; y: number }
  ref: Ref<PageDragGhostHandle>
}) {
  const strip = paper.label !== undefined
  // Upright, as the outline's is: only a paper tilts as it is lifted.
  const lifted = strip ? "none" : LIFTED
  const stacked = count > 1 && !strip
  const frameRef = useRef<HTMLDivElement>(null)
  const liftRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stackRefs = useRef<(HTMLDivElement | null)[]>([])
  const badgeRef = useRef<HTMLSpanElement>(null)
  const placeAt = (at: { x: number; y: number }) =>
    `translate(${at.x + grip.x}px, ${at.y + grip.y}px)`

  useImperativeHandle(
    ref,
    () => ({
      moveTo: (at) => {
        if (frameRef.current) {
          frameRef.current.style.transform = placeAt(at)
        }
      },
      land: async (box) => {
        const frame = frameRef.current
        const lift = liftRef.current

        if (!frame || !lift || prefersReducedMotion()) {
          return
        }

        const settle = { ...DRAG_MOTION, duration: 240, fill: "forwards" } as const
        // The lifted card and whatever stack is behind it go out together.
        const vanish = () => [
          lift.animate(
            [
              { opacity: 1, transform: lifted },
              { opacity: 0, transform: strip ? "scale(0.95)" : "rotate(-2deg) scale(0.9)" },
            ],
            { ...settle, duration: 160 },
          ),
        ]
        const settleOnto = (to: { left: number; top: number }) => [
          frame.animate(
            [
              { transform: frame.style.transform },
              {
                transform: `translate(${to.left - (strip ? STRIP_INSET : 0)}px, ${to.top}px)`,
              },
            ],
            settle,
          ),
          lift.animate([{ transform: lifted }, { transform: "none" }], settle),
          ...stackRefs.current.flatMap((card) =>
            card
              ? [
                  card.animate(
                    [
                      { opacity: 0.7, transform: getComputedStyle(card).transform },
                      { opacity: 0, transform: "none" },
                    ],
                    settle,
                  ),
                ]
              : [],
          ),
          ...(badgeRef.current
            ? [badgeRef.current.animate([{ opacity: 1 }, { opacity: 0 }], settle)]
            : []),
        ]
        const motions = box ? settleOnto(box) : vanish()

        // A cancelled motion rejects; landed or not, the pages come back.
        await Promise.race([
          Promise.all(motions.map((motion) => motion.finished)).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, LANDING_TIMEOUT_MS)),
        ])
      },
    }),
    // `grip` is fixed for the drag the ghost was mounted for.
    [],
  )

  useLayoutEffect(() => {
    const canvas = canvasRef.current
    const source = paper.canvas
    const context = canvas?.getContext("2d")

    // An unpainted preview holds a 1×1 placeholder; the paper stays white.
    if (canvas && context && source && source.width > 1 && source.height > 1) {
      canvas.width = Math.round(paper.width * devicePixelRatio)
      canvas.height = Math.round(paper.height * devicePixelRatio)
      context.drawImage(source, 0, 0, canvas.width, canvas.height)
    }

    if (prefersReducedMotion()) {
      return
    }

    const pickup = { duration: 150, easing: "ease-out" }

    liftRef.current?.animate([{ transform: "none" }, { transform: lifted }], pickup)
    stackRefs.current.forEach((card, index) => {
      card?.animate(
        [
          { opacity: 0, transform: "none" },
          { opacity: 0.7, transform: stackTransform(STACK_STEPS[index]!) },
        ],
        pickup,
      )
    })
    // Mounted once per drag: the paper it copies does not change under it.
  }, [])

  return createPortal(
    <div
      aria-hidden
      className="pointer-events-none fixed top-0 left-0 z-60"
      data-drag-ghost
      ref={frameRef}
      style={{ height: paper.height, transform: placeAt(point), width: paper.width }}
    >
      <div
        className="absolute inset-0"
        ref={liftRef}
        style={{ transform: lifted, transformOrigin: `${-grip.x}px ${-grip.y}px` }}
      >
        {/* The faint `drop-shadow-xs` on each tilted card smooths its edges:
            WebKitGTK, and Chromium rastering on the GPU, paint a tilted box
            stair-stepped, but draw a filtered one upright and then resample
            it. An identity filter is skipped, and a filter blur costs frames,
            so box-shadows still cast the visible shadow. */}
        {stacked
          ? STACK_STEPS.map((step, index) => (
              <div
                className="absolute inset-0 bg-white opacity-70 shadow-md ring-1 ring-black/10 drop-shadow-xs"
                key={step}
                ref={(card) => {
                  stackRefs.current[index] = card
                }}
                style={{ transform: stackTransform(step) }}
              />
            ))
          : null}
        {strip ? (
          <div className="absolute inset-0 flex items-center gap-2 rounded-md bg-background px-2 text-sm font-medium shadow-lg ring-1 ring-border">
            <FileText className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="truncate">{paper.label}</span>
          </div>
        ) : (
          <>
            {/* Apart from the lead card: inside its filter, this wide shadow's
                whole reach would be filtered again on every move. */}
            <div className="absolute inset-0 shadow-2xl" />
            <div className="absolute inset-0 overflow-hidden bg-white ring-1 ring-black/10 drop-shadow-xs">
              {paper.canvas ? (
                <canvas className="absolute inset-0 block size-full" ref={canvasRef} />
              ) : null}
            </div>
          </>
        )}
        {stacked ? (
          <span
            className="absolute -top-2 -right-2 grid min-w-5 place-items-center rounded-full bg-primary px-1 py-0.5 font-mono text-xs font-semibold text-primary-foreground tabular-nums shadow-md"
            ref={badgeRef}
          >
            {count}
          </span>
        ) : null}
      </div>
    </div>,
    document.body,
  )
}

/** Where the pages in hand will stand: the landing page's own paper, dashed,
    centred in the square every paper stands in. */
export function DragHole({ height, width }: { height: number; width: number }) {
  return (
    <span
      aria-hidden
      className="pointer-events-none absolute left-1/2 -translate-x-1/2 border-2 border-dashed border-primary/60 bg-primary/5"
      data-drag-hole
      style={{ height, top: (THUMBNAIL_WIDTH - height) / 2, width }}
    />
  )
}
