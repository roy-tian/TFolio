/** Sentinel error returned by Rust when this window already has a native file
    dialog open, kept distinct from user cancellation (`null`). */
export const FILE_DIALOG_BUSY = "file-dialog-busy"

export function isFileDialogBusyError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error)
  return message.includes(FILE_DIALOG_BUSY)
}

export type SingleFlightGate = {
  /** Acquires the gate, returning an idempotent release function owned by this
      call's token, or null if already held. An outer `finally` calling a prior
      release function cannot drop a newer holder's lock (e.g. a follow-up Save
      As started by `saveForClose`). */
  acquire: () => (() => void) | null
  isActive: () => boolean
}

export function createSingleFlightGate(): SingleFlightGate {
  let activeToken: symbol | null = null

  return {
    acquire: () => {
      if (activeToken !== null) {
        return null
      }

      const token = Symbol("single-flight")
      activeToken = token

      return () => {
        if (activeToken === token) {
          activeToken = null
        }
      }
    },
    isActive: () => activeToken !== null,
  }
}
