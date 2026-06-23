const STARTUP_TRACE_STORAGE_KEY = 'geo-media-index-lab:startup-trace'

function startupTraceEnabled(): boolean {
  try {
    return (
      typeof localStorage !== 'undefined' &&
      localStorage.getItem(STARTUP_TRACE_STORAGE_KEY) === '1'
    )
  } catch {
    return false
  }
}

export function traceStartup(
  channel: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  if (!startupTraceEnabled()) return
  console.log(channel, {
    at: new Date().toISOString(),
    performanceMs:
      typeof performance === 'undefined' ? undefined : performance.now(),
    message,
    ...details,
  })
}
