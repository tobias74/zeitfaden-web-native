export function traceStartup(
  channel: string,
  message: string,
  details?: Record<string, unknown>,
): void {
  console.log(channel, {
    at: new Date().toISOString(),
    performanceMs:
      typeof performance === 'undefined' ? undefined : performance.now(),
    message,
    ...details,
  })
}

traceStartup('[startup]', 'startup trace module evaluated')
