export type DecodeRequest = { bytes: ArrayBuffer; id: number; type: string }

export type DecodeReply =
  | { bitmap: ImageBitmap; id: number }
  | { error: string; id: number }
  | { ready: true }

// The app's lib is DOM, whose `self` is a Window with another postMessage.
const scope = self as unknown as {
  onmessage: ((event: MessageEvent<DecodeRequest>) => void) | null
  postMessage(message: DecodeReply, transfer?: Transferable[]): void
}

scope.onmessage = ({ data }) => {
  createImageBitmap(new Blob([data.bytes], { type: data.type })).then(
    (bitmap) => scope.postMessage({ bitmap, id: data.id }, [bitmap]),
    (error: unknown) => scope.postMessage({ error: String(error), id: data.id }),
  )
}

// Requests wait for this, so a worker that never loads strands none of them.
scope.postMessage({ ready: true })
