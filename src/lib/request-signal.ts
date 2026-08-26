// Some mobile browsers support fetch cancellation but not AbortSignal.any/timeout.
export function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted) throw signal.reason ?? new DOMException('请求已取消', 'AbortError')
}

export function createRequestSignal(sources: AbortSignal[], timeoutMs: number) {
  const controller = new AbortController()
  const listeners: Array<() => void> = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let timeoutReached = false
  const dispose = () => {
    clearTimeout(timer)
    for (const remove of listeners.splice(0)) remove()
  }
  const abortFrom = (source: AbortSignal) => {
    controller.abort(source.reason)
    dispose()
  }
  for (const source of new Set(sources)) {
    if (source.aborted) { abortFrom(source); break }
    const onAbort = () => abortFrom(source)
    source.addEventListener('abort', onAbort, { once: true })
    listeners.push(() => source.removeEventListener('abort', onAbort))
  }
  if (!controller.signal.aborted) {
    timer = setTimeout(() => {
      timeoutReached = true
      controller.abort(new DOMException('请求超时', 'TimeoutError'))
      dispose()
    }, timeoutMs)
  }
  return { signal: controller.signal, timedOut: () => timeoutReached, dispose }
}
