import { useState } from "react"

import { odometerColumns } from "@/lib/odometer"
import { cn } from "@/lib/utils"

type PageOdometerProps = {
  className?: string
  value: number
}

/**
 * A number that turns to its new value the way an odometer does: the digits
 * that changed roll up when the number counts up and down when it counts down,
 * while the digits that did not change stay where they are.
 *
 * Decorative, and `aria-hidden` for it: the page status around this already
 * names the page in its own label and in a live region, which is where a reader
 * who cannot see the roll hears the same thing.
 */
export function PageOdometer({ className, value }: PageOdometerProps) {
  // The value being rolled to, the one it left, a counter of turns, and whether
  // the roll is over. Updated during render rather than from an effect, because
  // both digits have to be laid out in the same commit as the new value — an
  // effect would land the number first and animate it a frame later.
  const [roll, setRoll] = useState({
    from: value,
    settled: true,
    to: value,
    turn: 0,
  })

  if (roll.to !== value) {
    setRoll((turned) => ({
      from: turned.to,
      settled: false,
      to: value,
      turn: turned.turn + 1,
    }))
  }

  const rising = roll.to > roll.from
  // Once the roll is over the number stands alone: the digits it replaced are
  // out of the DOM rather than parked out of sight, so what this reads is the
  // page and nothing else. Reduced motion runs no animation and so ends none —
  // there the digits left behind are the ones `motion-reduce:hidden` drops.
  const columns = odometerColumns(roll.settled ? roll.to : roll.from, roll.to)

  return (
    <span
      aria-hidden
      className={cn("inline-flex items-center text-sm", className)}
      data-slot="page-odometer"
      onAnimationEnd={() =>
        setRoll((turned) =>
          turned.settled ? turned : { ...turned, settled: true },
        )
      }
    >
      {columns.map((column) => (
        // One line box tall and one digit wide, which is what clips a rolling
        // digit to its own place. Both digits sit on top of each other in it;
        // only their animation tells them apart.
        //
        // A place the number is about to reach for the first time, or has just
        // left, opens or closes over the same beat. Closing it matters: a place
        // held open by nothing would leave 99 standing where 100 was, half a
        // digit off centre, until the number next moved.
        <span
          className={cn(
            "relative block h-5 w-[1ch] overflow-hidden leading-5",
            column.from === "" &&
              "animate-digit-open motion-reduce:animate-none",
            column.to === "" &&
              "animate-digit-close motion-reduce:animate-none motion-reduce:w-0",
          )}
          key={column.place}
        >
          {/* Keyed by the turn, so a change remounts the pair and starts the
              roll again from the top. The digit leaving holds where it ended
              up — out of sight past the edge of the box — because an animation
              that fell back to its resting place would drop it back over the
              digit that replaced it. */}
          {column.rolls ? (
            <span
              className={cn(
                "absolute inset-0 motion-reduce:hidden",
                rising ? "animate-digit-leave-up" : "animate-digit-leave-down",
              )}
              key={`leave-${roll.turn}`}
            >
              {column.from}
            </span>
          ) : null}
          <span
            className={cn(
              "absolute inset-0",
              column.rolls &&
                (rising
                  ? "animate-digit-enter-up motion-reduce:animate-none"
                  : "animate-digit-enter-down motion-reduce:animate-none"),
            )}
            key={`enter-${roll.turn}`}
          >
            {column.to}
          </span>
        </span>
      ))}
    </span>
  )
}
