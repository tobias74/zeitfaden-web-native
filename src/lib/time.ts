import type { TimeRange } from '../types'

export function matchesTimeRange(
  timestamp: number | undefined,
  range: TimeRange,
): boolean {
  const hasStart = typeof range.startTime === 'number'
  const hasEnd = typeof range.endTime === 'number'

  if (!hasStart && !hasEnd) return true
  if (typeof timestamp !== 'number') return false
  if (hasStart && timestamp < range.startTime!) return false
  if (hasEnd && timestamp > range.endTime!) return false
  return true
}

export function overlapsTimeRange(
  mintimestamp: number | undefined,
  maxtimestamp: number | undefined,
  range: TimeRange,
): boolean {
  const hasStart = typeof range.startTime === 'number'
  const hasEnd = typeof range.endTime === 'number'

  if (!hasStart && !hasEnd) return true
  if (
    typeof mintimestamp !== 'number' ||
    typeof maxtimestamp !== 'number'
  ) {
    return false
  }
  if (hasStart && maxtimestamp < range.startTime!) return false
  if (hasEnd && mintimestamp > range.endTime!) return false
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

export function formatDateTime(
  millis: number | undefined,
  locale?: string,
  fallback = 'No timestamp',
): string {
  if (typeof millis !== 'number') return fallback
  return new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(millis))
}
