import { useState } from "react"

import { odometerColumns } from "@/lib/odometer"
import { cn } from "@/lib/utils"

type PageOdometerProps = {
  className?: string
  value: number
}

/** Digits roll odometer-style. Decorative, and `aria-hidden` for it: the page
    status around this already names the page in a live region. */
export function PageOdometer({ className, value }: PageOdometerProps) {
  // Set during render rather than from an effect: both digits must be laid out
  // in the same commit as the new value — an effect would animate a frame late.
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
  // Settled drops the replaced digits from the DOM; reduced motion ends no
  // animation, so there `motion-reduce:hidden` is what takes them away.
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
        // The digit-sized box clips each roll; the open/close animations close
        // a place nothing holds, else 99 would sit off-centre where 100 was.
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
          {/* Keyed by the turn, so a change remounts the pair and restarts the
              roll; the leaving digit must hold past the edge, not fall back. */}
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
