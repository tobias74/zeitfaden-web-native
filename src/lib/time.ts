import type { TimeRange } from '../types'

export function matchesTimeRange(
  capturedAt: number | undefined,
  range: TimeRange,
): boolean {
  const hasStart = typeof range.startTime === 'number'
  const hasEnd = typeof range.endTime === 'number'

  if (!hasStart && !hasEnd) return true
  if (typeof capturedAt !== 'number') return false
  if (hasStart && capturedAt < range.startTime!) return false
  if (hasEnd && capturedAt > range.endTime!) return false
  return true
}

export function overlapsTimeRange(
  minCapturedAt: number | undefined,
  maxCapturedAt: number | undefined,
  range: TimeRange,
): boolean {
  const hasStart = typeof range.startTime === 'number'
  const hasEnd = typeof range.endTime === 'number'

  if (!hasStart && !hasEnd) return true
  if (
    typeof minCapturedAt !== 'number' ||
    typeof maxCapturedAt !== 'number'
  ) {
    return false
  }
  if (hasStart && maxCapturedAt < range.startTime!) return false
  if (hasEnd && minCapturedAt > range.endTime!) return false
  return true
}

function localInputToMillis(
  value: string,
  dateOnlyFallbackTime: string,
): number | undefined {
  if (!value) return undefined
  const timestamp = value.includes('T')
    ? value
    : `${value}T${dateOnlyFallbackTime}`
  const millis = new Date(timestamp).getTime()
  return Number.isFinite(millis) ? millis : undefined
}

export function dateInputToMillis(value: string): number | undefined {
  return localInputToMillis(value, '00:00:00')
}

export function dateInputEndToMillis(value: string): number | undefined {
  if (value.includes('T')) {
    const millis = new Date(value).getTime()
    return Number.isFinite(millis) ? millis : undefined
  }
  const millis = localInputToMillis(value, '23:59:59.999')
  return Number.isFinite(millis) ? millis : undefined
}

export function formatDateTime(millis: number | undefined): string {
  if (typeof millis !== 'number') return 'No timestamp'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(millis))
}
