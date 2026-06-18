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

export function dateInputToMillis(value: string): number | undefined {
  if (!value) return undefined
  const millis = new Date(`${value}T00:00:00`).getTime()
  return Number.isFinite(millis) ? millis : undefined
}

export function dateInputEndToMillis(value: string): number | undefined {
  if (!value) return undefined
  const millis = new Date(`${value}T23:59:59.999`).getTime()
  return Number.isFinite(millis) ? millis : undefined
}

export function formatDateTime(millis: number | undefined): string {
  if (typeof millis !== 'number') return 'No timestamp'
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(millis))
}

