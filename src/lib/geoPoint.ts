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

export type GeoFileFormat = 'gpx' | 'google-takeout-json'

const GEO_POINT_HASH_VERSION = 'geo_point:v1'
const GPX_POINT_TAGS = new Set(['trkpt', 'rtept', 'wpt'])
const UNSUPPORTED_GEO_FILE_FORMAT =
  'The selected file is not a supported geo import format. Supported formats are GPX and Google Takeout Location History JSON.'
const GEO_IMPORT_DEBUG_PREFIX = '[geo-import]'

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

function valueKind(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

function sampleKeys(value: unknown, limit = 12): string[] {
  return isRecord(value) ? Object.keys(value).slice(0, limit) : []
}

function logGeoImportDebug(
  fileName: string,
  reason: string,
  details: Record<string, unknown>,
): void {
  console.log(GEO_IMPORT_DEBUG_PREFIX, {
    fileName,
    reason,
    ...details,
  })
}

function isGoogleTakeoutLocationJson(value: unknown): value is {
  locations: unknown[]
} {
  return isRecord(value) && Array.isArray(value.locations)
}

function isGoogleSemanticLocationJson(value: unknown): boolean {
  return isRecord(value) && Array.isArray(value.timelineObjects)
}

function isGeoJson(value: unknown): boolean {
  if (!isRecord(value) || typeof value.type !== 'string') return false
  return ['FeatureCollection', 'Feature', 'Point'].includes(value.type)
}

function jsonDebugDetails(parsed: unknown): Record<string, unknown> {
  const locations = isRecord(parsed) ? parsed.locations : undefined
  const timelineObjects = isRecord(parsed) ? parsed.timelineObjects : undefined
  const firstLocation = Array.isArray(locations) ? locations[0] : undefined
  const firstTimelineObject = Array.isArray(timelineObjects)
    ? timelineObjects[0]
    : undefined

  return {
    rootKind: valueKind(parsed),
    topLevelKeys: sampleKeys(parsed),
    locationsKind: valueKind(locations),
    locationsCount: Array.isArray(locations) ? locations.length : undefined,
    firstLocationKeys: sampleKeys(firstLocation),
    timelineObjectsKind: valueKind(timelineObjects),
    timelineObjectsCount: Array.isArray(timelineObjects)
      ? timelineObjects.length
      : undefined,
    firstTimelineObjectKeys: sampleKeys(firstTimelineObject),
  }
}

function parsedXmlDocument(xmlText: string): Document | undefined {
  const document = new DOMParser().parseFromString(xmlText, 'application/xml')
  const parserError = Array.from(document.getElementsByTagName('*')).find(
    (element) => localName(element) === 'parsererror',
  )
  return parserError ? undefined : document
}

function isGpxDocument(document: Document): boolean {
  return localName(document.documentElement) === 'gpx'
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
  const document = parsedXmlDocument(xmlText)
  if (!document) {
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
  if (!isGoogleTakeoutLocationJson(parsed)) {
    throw new Error(
      'The selected JSON file does not look like a Google Takeout location export.',
    )
  }

  const points: ParsedGeoPoint[] = []
  let skippedPoints = 0

  parsed.locations.forEach((entry, entryIndex) => {
    const index = entryIndex + 1
    const point = parseGoogleTakeoutLocationEntry(entry, index)
    if (point) {
      points.push(point)
    } else {
      skippedPoints += 1
    }
  })

  return { points, skippedPoints, mimeType: 'application/json' }
}

export function parseGoogleTakeoutLocationEntry(
  entry: unknown,
  index: number,
): ParsedGeoPoint | undefined {
  if (!isRecord(entry)) return undefined

  const latitudeE7 = numeric(entry.latitudeE7)
  const longitudeE7 = numeric(entry.longitudeE7)
  const latitude =
    latitudeE7 === undefined ? undefined : latitudeE7 / 10_000_000
  const longitude =
    longitudeE7 === undefined ? undefined : longitudeE7 / 10_000_000
  const capturedAt =
    timestampMillis(entry.timestamp) ??
    timestampMs(entry.timestampMs) ??
    timestampMs(entry.timestampMS)

  if (
    !validLatitude(latitude) ||
    !validLongitude(longitude) ||
    capturedAt === undefined
  ) {
    return undefined
  }

  return {
    index,
    latitude,
    longitude,
    capturedAt,
  }
}

export function detectGeoFileFormat(
  fileName: string,
  fileText: string,
): GeoFileFormat {
  const trimmed = fileText.trimStart()
  if (trimmed === '') {
    logGeoImportDebug(fileName, 'empty file', {})
    throw new Error(UNSUPPORTED_GEO_FILE_FORMAT)
  }

  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    let parsed: unknown
    try {
      parsed = JSON.parse(fileText) as unknown
    } catch (error) {
      logGeoImportDebug(
        fileName,
        'JSON parse failed',
        {
          message: error instanceof Error ? error.message : String(error),
          firstCharacters: trimmed.slice(0, 32),
        },
      )
      throw new Error(UNSUPPORTED_GEO_FILE_FORMAT, { cause: error })
    }

    if (isGoogleTakeoutLocationJson(parsed)) return 'google-takeout-json'
    if (isGoogleSemanticLocationJson(parsed)) {
      logGeoImportDebug(
        fileName,
        'Google Semantic Location History is not supported yet',
        jsonDebugDetails(parsed),
      )
      throw new Error(
        'This looks like Google Semantic Location History JSON. That is valid Google Takeout data, but this importer currently supports only the raw Records.json location export.',
      )
    }
    if (isGeoJson(parsed)) {
      logGeoImportDebug(
        fileName,
        'GeoJSON is not supported yet',
        jsonDebugDetails(parsed),
      )
      throw new Error(
        'GeoJSON files are not supported yet. Supported formats are GPX and Google Takeout Location History JSON.',
      )
    }
    logGeoImportDebug(
      fileName,
      'unsupported JSON geo format',
      jsonDebugDetails(parsed),
    )
    throw new Error(
      'The selected JSON file is not a supported geo import format. Supported JSON format is Google Takeout Location History JSON.',
    )
  }

  const document = parsedXmlDocument(fileText)
  if (document && isGpxDocument(document)) return 'gpx'

  logGeoImportDebug(fileName, 'unsupported non-JSON/non-GPX content', {
    firstCharacters: fileText.trimStart().slice(0, 32),
  })
  throw new Error(UNSUPPORTED_GEO_FILE_FORMAT)
}

export function parseGeoFilePoints(
  fileName: string,
  fileText: string,
): ParsedGeoFile {
  switch (detectGeoFileFormat(fileName, fileText)) {
    case 'google-takeout-json':
      return parseGoogleTakeoutLocationPoints(fileText)
    case 'gpx':
      return parseGpxPoints(fileText)
  }
}
