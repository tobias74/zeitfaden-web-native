export type ParsedGeoPoint = {
  index: number
  latitude: number
  longitude: number
  capturedAt: number
}

export type ParsedGeoFile = {
  points: ParsedGeoPoint[]
  skippedPoints: number
  mimeType: string
}

const GEO_POINT_HASH_VERSION = 'geo_point:v1'
const GPX_POINT_TAGS = new Set(['trkpt', 'rtept', 'wpt'])

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('')
}

function localName(element: Element): string {
  return element.localName || element.tagName
}

function finiteCoordinate(value: string | null): number | undefined {
  if (value === null || value.trim() === '') return undefined
  const number = Number(value)
  return Number.isFinite(number) ? number : undefined
}

function validLatitude(value: number | undefined): value is number {
  return typeof value === 'number' && value >= -90 && value <= 90
}

function validLongitude(value: number | undefined): value is number {
  return typeof value === 'number' && value >= -180 && value <= 180
}

function pointTime(element: Element): number | undefined {
  for (const child of Array.from(element.children)) {
    if (localName(child) !== 'time') continue
    const parsed = Date.parse(child.textContent?.trim() ?? '')
    return Number.isFinite(parsed) ? parsed : undefined
  }

  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function numeric(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function timestampMillis(value: unknown): number | undefined {
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? parsed : undefined
  }
  return undefined
}

function timestampMs(value: unknown): number | undefined {
  const parsed = numeric(value)
  return parsed === undefined ? undefined : Math.trunc(parsed)
}

async function sha256String(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(value),
  )
  return bytesToHex(new Uint8Array(digest))
}

export function geoPointIdentityInput(
  latitude: number,
  longitude: number,
  capturedAt: number,
): string {
  return [
    GEO_POINT_HASH_VERSION,
    latitude.toFixed(9),
    longitude.toFixed(9),
    String(capturedAt),
  ].join('\n')
}

export function geoPointContentHash(
  latitude: number,
  longitude: number,
  capturedAt: number,
): Promise<string> {
  return sha256String(geoPointIdentityInput(latitude, longitude, capturedAt))
}

export function parseGpxPoints(xmlText: string): ParsedGeoFile {
  const document = new DOMParser().parseFromString(xmlText, 'application/xml')
  const parserError = Array.from(document.getElementsByTagName('*')).find(
    (element) => localName(element) === 'parsererror',
  )
  if (parserError) {
    throw new Error('The selected GPX file could not be parsed as XML.')
  }

  const points: ParsedGeoPoint[] = []
  let skippedPoints = 0
  let index = 0

  for (const element of Array.from(document.getElementsByTagName('*'))) {
    if (!GPX_POINT_TAGS.has(localName(element))) continue

    index += 1
    const latitude = finiteCoordinate(element.getAttribute('lat'))
    const longitude = finiteCoordinate(element.getAttribute('lon'))
    const capturedAt = pointTime(element)

    if (
      !validLatitude(latitude) ||
      !validLongitude(longitude) ||
      capturedAt === undefined
    ) {
      skippedPoints += 1
      continue
    }

    points.push({
      index,
      latitude,
      longitude,
      capturedAt,
    })
  }

  return { points, skippedPoints, mimeType: 'application/gpx+xml' }
}

export function parseGoogleTakeoutLocationPoints(
  jsonText: string,
): ParsedGeoFile {
  const parsed = JSON.parse(jsonText) as unknown
  if (!isRecord(parsed) || !Array.isArray(parsed.locations)) {
    throw new Error(
      'The selected JSON file does not look like a Google Takeout location export.',
    )
  }

  const points: ParsedGeoPoint[] = []
  let skippedPoints = 0

  parsed.locations.forEach((entry, entryIndex) => {
    const index = entryIndex + 1
    if (!isRecord(entry)) {
      skippedPoints += 1
      return
    }

    const latitudeE7 = numeric(entry.latitudeE7)
    const longitudeE7 = numeric(entry.longitudeE7)
    const latitude =
      latitudeE7 === undefined ? undefined : latitudeE7 / 10_000_000
    const longitude =
      longitudeE7 === undefined ? undefined : longitudeE7 / 10_000_000
    const capturedAt =
      timestampMillis(entry.timestamp) ?? timestampMs(entry.timestampMs)

    if (
      !validLatitude(latitude) ||
      !validLongitude(longitude) ||
      capturedAt === undefined
    ) {
      skippedPoints += 1
      return
    }

    points.push({
      index,
      latitude,
      longitude,
      capturedAt,
    })
  })

  return { points, skippedPoints, mimeType: 'application/json' }
}

export function parseGeoFilePoints(
  fileName: string,
  fileText: string,
): ParsedGeoFile {
  if (fileName.toLowerCase().endsWith('.json')) {
    return parseGoogleTakeoutLocationPoints(fileText)
  }

  return parseGpxPoints(fileText)
}
