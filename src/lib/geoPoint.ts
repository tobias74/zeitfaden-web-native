import type { MediaKind } from '../types'

export type ParsedGeoPoint = {
  index: number
  kind?: MediaKind
  latitude: number
  longitude: number
  timestamp: number
  endTimestamp?: number
  sourceDataset?: string
  sourceType?: string
  accuracyMeters?: number
  altitudeMeters?: number
  verticalAccuracyMeters?: number
  velocityMetersPerSecond?: number
  headingDegrees?: number
  groupId?: string
  sequence?: number
  metadata?: Record<string, unknown>
}

export type ParsedGeoItem = {
  index: number
  kind: MediaKind
  latitude?: number
  longitude?: number
  timestamp?: number
  endTimestamp?: number
  sourceDataset?: string
  sourceType?: string
  accuracyMeters?: number
  altitudeMeters?: number
  verticalAccuracyMeters?: number
  velocityMetersPerSecond?: number
  headingDegrees?: number
  groupId?: string
  sequence?: number
  contentHash?: string
  displayName?: string
  metadata?: Record<string, unknown>
}

export type ParsedGeoFile = {
  points: ParsedGeoPoint[]
  items?: ParsedGeoItem[]
  skippedPoints: number
  mimeType: string
}

export type GeoFileFormat =
  | 'gpx'
  | 'google-takeout-json'
  | 'google-timeline-json'

const GEO_POINT_IDENTITY_VERSION = 'geo_point:v1'
const SEMANTIC_IDENTITY_VERSION = 'timeline:v1'
const GPX_POINT_TAGS = new Set(['trkpt', 'rtept', 'wpt'])
const XML_PREFIX = String.raw`(?:[A-Za-z_][\w.-]*:)?`
const GPX_POINT_TAG_NAME = String.raw`${XML_PREFIX}(?:trkpt|rtept|wpt)`
const UNSUPPORTED_GEO_FILE_FORMAT =
  'The selected file is not a supported geo import format. Supported formats are GPX and Google Takeout Location History JSON.'
const GEO_IMPORT_DEBUG_PREFIX = '[geo-import]'
const GEO_IMPORT_DEBUG_STORAGE_KEY = 'geo-media-index-lab:geo-import-debug'

function xmlLocalName(name: string): string {
  return (name.split(':').pop() ?? name).toLowerCase()
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

function xmlAttribute(attributes: string, name: 'lat' | 'lon'): string | null {
  const match = new RegExp(
    String.raw`\b${name}\s*=\s*(?:"([^"]*)"|'([^']*)')`,
    'i',
  ).exec(attributes)
  return match?.[1] ?? match?.[2] ?? null
}

function pointTime(pointBody: string): number | undefined {
  const match = new RegExp(
    String.raw`<\s*${XML_PREFIX}time\b[^>]*>([\s\S]*?)<\s*/\s*${XML_PREFIX}time\s*>`,
    'i',
  ).exec(pointBody)
  const parsed = Date.parse(match?.[1]?.trim() ?? '')
  return Number.isFinite(parsed) ? parsed : undefined
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

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined
}

function booleanValue(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`
  if (!isRecord(value)) return JSON.stringify(value)
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`
}

function compactRecord(record: Record<string, unknown>): Record<string, unknown> | undefined {
  const entries = Object.entries(record).filter(([, value]) => value !== undefined)
  return entries.length > 0 ? Object.fromEntries(entries) : undefined
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
  try {
    if (
      typeof localStorage === 'undefined' ||
      localStorage.getItem(GEO_IMPORT_DEBUG_STORAGE_KEY) !== '1'
    ) {
      return
    }
  } catch {
    return
  }
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
  return isRecord(value) && (
    Array.isArray(value.semanticSegments) ||
    Array.isArray(value.rawSignals) ||
    isRecord(value.userLocationProfile)
  )
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

function isGpxText(xmlText: string): boolean {
  return new RegExp(String.raw`<\s*${XML_PREFIX}gpx(?:\s|>)`, 'i').test(
    xmlText,
  )
}

export function geoPointIdentityInput(
  latitude: number,
  longitude: number,
  timestamp: number,
): string {
  return [
    GEO_POINT_IDENTITY_VERSION,
    latitude.toFixed(9),
    longitude.toFixed(9),
    String(timestamp),
  ].join(':')
}

export function geoPointContentHash(
  latitude: number,
  longitude: number,
  timestamp: number,
): string {
  return geoPointIdentityInput(latitude, longitude, timestamp)
}

export function semanticContentHash(
  kind: MediaKind,
  identityParts: Array<string | number | undefined>,
): string {
  return [
    SEMANTIC_IDENTITY_VERSION,
    kind,
    ...identityParts.map((part) => String(part ?? '')),
  ].join(':')
}

function parsedPointItem(point: ParsedGeoPoint): ParsedGeoItem {
  return {
    ...point,
    kind: point.kind ?? 'geo_point',
  }
}

export function parseGpxPoints(xmlText: string): ParsedGeoFile {
  if (!isGpxText(xmlText)) {
    throw new Error('The selected GPX file could not be parsed as XML.')
  }

  const points: ParsedGeoPoint[] = []
  let skippedPoints = 0
  let index = 0
  const pointTagPattern = new RegExp(
    String.raw`<\s*(${GPX_POINT_TAG_NAME})\b([^>]*?)(?:/\s*>|>([\s\S]*?)<\s*/\s*\1\s*>)`,
    'gi',
  )
  let match: RegExpExecArray | null

  while ((match = pointTagPattern.exec(xmlText))) {
    const [, tagName, attributes = '', body = ''] = match
    if (!GPX_POINT_TAGS.has(xmlLocalName(tagName))) continue

    index += 1
    const latitude = finiteCoordinate(xmlAttribute(attributes, 'lat'))
    const longitude = finiteCoordinate(xmlAttribute(attributes, 'lon'))
    const timestamp = pointTime(body)

    if (
      !validLatitude(latitude) ||
      !validLongitude(longitude) ||
      timestamp === undefined
    ) {
      skippedPoints += 1
      continue
    }

    points.push({
      index,
      latitude,
      longitude,
      timestamp,
    })
  }

  return {
    points,
    items: points.map(parsedPointItem),
    skippedPoints,
    mimeType: 'application/gpx+xml',
  }
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

  return {
    points,
    items: points.map(parsedPointItem),
    skippedPoints,
    mimeType: 'application/json',
  }
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
  const timestamp =
    timestampMillis(entry.timestamp) ??
    timestampMs(entry.timestampMs) ??
    timestampMs(entry.timestampMS)

  if (
    !validLatitude(latitude) ||
    !validLongitude(longitude) ||
    timestamp === undefined
  ) {
    return undefined
  }

  return {
    index,
    kind: 'geo_point',
    latitude,
    longitude,
    timestamp,
    sourceDataset: 'google_records',
    sourceType: stringValue(entry.source),
    accuracyMeters: numeric(entry.accuracy),
    altitudeMeters: numeric(entry.altitude),
    verticalAccuracyMeters: numeric(entry.verticalAccuracy),
    velocityMetersPerSecond: numeric(entry.velocity),
    headingDegrees: numeric(entry.heading),
    metadata: compactRecord({
      deviceTag: numeric(entry.deviceTag),
      platformType: stringValue(entry.platformType),
      formFactor: stringValue(entry.formFactor),
      osLevel: numeric(entry.osLevel),
      serverTimestamp: timestampMillis(entry.serverTimestamp),
      deviceTimestamp: timestampMillis(entry.deviceTimestamp),
      batteryCharging: booleanValue(entry.batteryCharging),
      activity: entry.activity,
    }),
  }
}

function coordinatesFromLatLngString(value: unknown): {
  latitude: number
  longitude: number
} | undefined {
  const text = stringValue(value)
  if (!text || !text.includes(',')) return undefined
  const [latText, lonText] = text.split(',', 2)
  const clean = (part: string) => part.replace(/[^0-9.-]/g, '')
  const latitude = numeric(clean(latText))
  const longitude = numeric(clean(lonText))
  if (!validLatitude(latitude) || !validLongitude(longitude)) return undefined
  return { latitude, longitude }
}

function coordinatesFromLocationRecord(value: unknown): {
  latitude: number
  longitude: number
} | undefined {
  if (!isRecord(value)) return undefined
  const fromString =
    coordinatesFromLatLngString(value.LatLng) ??
    coordinatesFromLatLngString(value.latLng)
  if (fromString) return fromString
  const latitudeE7 = numeric(value.latitudeE7)
  const longitudeE7 = numeric(value.longitudeE7)
  const latitude =
    latitudeE7 === undefined ? undefined : latitudeE7 / 10_000_000
  const longitude =
    longitudeE7 === undefined ? undefined : longitudeE7 / 10_000_000
  if (!validLatitude(latitude) || !validLongitude(longitude)) return undefined
  return { latitude, longitude }
}

function fixedCoordinate(value: number | undefined): string | undefined {
  return typeof value === 'number' ? value.toFixed(9) : undefined
}

function durationMs(start: number | undefined, end: number | undefined): number | undefined {
  return start !== undefined && end !== undefined && end >= start
    ? end - start
    : undefined
}

function timelineSegmentGroupId(
  segmentIndex: number,
  startTime: number | undefined,
  endTime: number | undefined,
): string {
  return [
    'google_timeline_segment:v1',
    String(segmentIndex + 1),
    String(startTime ?? ''),
    String(endTime ?? ''),
  ].join(':')
}

function timelinePathItem(
  segmentIndex: number,
  pointIndex: number,
  segment: Record<string, unknown>,
  point: unknown,
): ParsedGeoItem | undefined {
  if (!isRecord(point)) return undefined
  const coordinates = coordinatesFromLatLngString(point.point)
  const timestamp = timestampMillis(point.time)
  if (!coordinates || timestamp === undefined) return undefined
  const startTime = timestampMillis(segment.startTime)
  const endTime = timestampMillis(segment.endTime)
  return {
    index: pointIndex + 1,
    kind: 'geo_point',
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    timestamp,
    sourceDataset: 'google_timeline',
    sourceType: 'timeline_path',
    groupId: timelineSegmentGroupId(segmentIndex, startTime, endTime),
    sequence: pointIndex,
    metadata: {
      segmentStartTime: startTime,
      segmentEndTime: endTime,
    },
  }
}

function rawSignalPositionItem(index: number, signal: unknown): ParsedGeoItem | undefined {
  if (!isRecord(signal) || !isRecord(signal.position)) return undefined
  const position = signal.position
  const coordinates = coordinatesFromLocationRecord(position)
  const timestamp = timestampMillis(position.timestamp)
  if (!coordinates || timestamp === undefined) return undefined
  return {
    index,
    kind: 'geo_point',
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    timestamp,
    sourceDataset: 'google_timeline_raw_signals',
    sourceType: stringValue(position.source),
    accuracyMeters: numeric(position.accuracyMeters) ?? numeric(position.accuracy),
    altitudeMeters: numeric(position.altitudeMeters) ?? numeric(position.altitude),
    verticalAccuracyMeters:
      numeric(position.verticalAccuracyMeters) ?? numeric(position.verticalAccuracy),
    velocityMetersPerSecond:
      numeric(position.speedMetersPerSecond) ?? numeric(position.velocity),
    headingDegrees: numeric(position.headingDegrees) ?? numeric(position.heading),
    metadata: compactRecord({
      deviceTag: numeric(position.deviceTag),
      platformType: stringValue(position.platformType),
      formFactor: stringValue(position.formFactor),
      osLevel: numeric(position.osLevel),
      serverTimestamp: timestampMillis(position.serverTimestamp),
      deviceTimestamp: timestampMillis(position.deviceTimestamp),
      batteryCharging: booleanValue(position.batteryCharging),
    }),
  }
}

function timelineVisitItem(
  segmentIndex: number,
  segment: Record<string, unknown>,
): ParsedGeoItem | undefined {
  const visit = isRecord(segment.visit) ? segment.visit : undefined
  const topCandidate = isRecord(visit?.topCandidate) ? visit.topCandidate : undefined
  const placeLocation = isRecord(topCandidate?.placeLocation)
    ? topCandidate.placeLocation
    : undefined
  const coordinates = coordinatesFromLocationRecord(placeLocation)
  const startTime = timestampMillis(segment.startTime)
  const endTime = timestampMillis(segment.endTime)
  if (!coordinates || startTime === undefined) return undefined
  const placeId = stringValue(topCandidate?.placeId)
  const semanticType = stringValue(topCandidate?.semanticType)
  const contentHash = semanticContentHash('timeline_visit', [
    startTime,
    endTime,
    fixedCoordinate(coordinates.latitude),
    fixedCoordinate(coordinates.longitude),
    placeId,
    semanticType,
  ])
  return {
    index: segmentIndex + 1,
    kind: 'timeline_visit',
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    timestamp: startTime,
    endTimestamp: endTime,
    sourceDataset: 'google_timeline',
    sourceType: 'visit',
    groupId: timelineSegmentGroupId(segmentIndex, startTime, endTime),
    contentHash,
    displayName: `Visit ${segmentIndex + 1}`,
    metadata: {
      durationMs: durationMs(startTime, endTime),
      hierarchyLevel: numeric(visit?.hierarchyLevel),
      probability: numeric(visit?.probability),
      placeId,
      semanticType,
      topCandidateProbability: numeric(topCandidate?.probability),
    },
  }
}

function timelineActivityItem(
  segmentIndex: number,
  segment: Record<string, unknown>,
): ParsedGeoItem | undefined {
  const activity = isRecord(segment.activity) ? segment.activity : undefined
  const start = isRecord(activity?.start) ? activity.start : undefined
  const end = isRecord(activity?.end) ? activity.end : undefined
  const startCoordinates = coordinatesFromLocationRecord(start)
  const endCoordinates = coordinatesFromLocationRecord(end)
  const startTime = timestampMillis(segment.startTime)
  const endTime = timestampMillis(segment.endTime)
  const topCandidate = isRecord(activity?.topCandidate)
    ? activity.topCandidate
    : undefined
  const activityType = stringValue(topCandidate?.type)
  if (!startCoordinates || startTime === undefined) return undefined
  const contentHash = semanticContentHash('timeline_activity', [
    startTime,
    endTime,
    fixedCoordinate(startCoordinates.latitude),
    fixedCoordinate(startCoordinates.longitude),
    fixedCoordinate(endCoordinates?.latitude),
    fixedCoordinate(endCoordinates?.longitude),
    activityType,
  ])
  return {
    index: segmentIndex + 1,
    kind: 'timeline_activity',
    latitude: startCoordinates.latitude,
    longitude: startCoordinates.longitude,
    timestamp: startTime,
    endTimestamp: endTime,
    sourceDataset: 'google_timeline',
    sourceType: 'activity',
    groupId: timelineSegmentGroupId(segmentIndex, startTime, endTime),
    contentHash,
    displayName: `Activity ${segmentIndex + 1}`,
    metadata: {
      durationMs: durationMs(startTime, endTime),
      endLatitude: endCoordinates?.latitude,
      endLongitude: endCoordinates?.longitude,
      distanceMeters: numeric(activity?.distanceMeters),
      activityType,
      probability: numeric(topCandidate?.probability) ?? numeric(activity?.probability),
      parking: activity?.parking,
    },
  }
}

function activitySampleItem(index: number, signal: unknown): ParsedGeoItem | undefined {
  if (!isRecord(signal) || !isRecord(signal.activityRecord)) return undefined
  const record = signal.activityRecord
  const timestamp = timestampMillis(record.timestamp)
  if (timestamp === undefined) return undefined
  const probableActivities = Array.isArray(record.probableActivities)
    ? record.probableActivities
    : []
  return {
    index,
    kind: 'activity_sample',
    timestamp,
    sourceDataset: 'google_timeline_raw_signals',
    sourceType: 'activity_record',
    contentHash: semanticContentHash('activity_sample', [
      timestamp,
      stableJson(probableActivities),
    ]),
    displayName: `Activity sample ${index}`,
    metadata: {
      probableActivities,
    },
  }
}

function frequentPlaceItem(index: number, place: unknown): ParsedGeoItem | undefined {
  if (!isRecord(place)) return undefined
  const coordinates = coordinatesFromLocationRecord(place.placeLocation)
  if (!coordinates) return undefined
  const placeId = stringValue(place.placeId)
  const label = stringValue(place.label)
  return {
    index,
    kind: 'frequent_place',
    latitude: coordinates.latitude,
    longitude: coordinates.longitude,
    sourceDataset: 'google_timeline',
    sourceType: 'frequent_place',
    contentHash: semanticContentHash('frequent_place', [
      placeId,
      label,
      fixedCoordinate(coordinates.latitude),
      fixedCoordinate(coordinates.longitude),
    ]),
    displayName: label ? `Frequent place: ${label}` : `Frequent place ${index}`,
    metadata: {
      placeId,
      label,
    },
  }
}

export function parseGoogleTimelineLocationItems(jsonText: string): ParsedGeoFile {
  const parsed = JSON.parse(jsonText) as unknown
  if (!isGoogleSemanticLocationJson(parsed) || !isRecord(parsed)) {
    throw new Error(
      'The selected JSON file does not look like a Google Timeline export.',
    )
  }

  const items: ParsedGeoItem[] = []
  let skippedPoints = 0

  const rawSignals = Array.isArray(parsed.rawSignals) ? parsed.rawSignals : []
  rawSignals.forEach((signal, signalIndex) => {
    if (isRecord(signal) && isRecord(signal.wifiScan)) return
    const position = rawSignalPositionItem(signalIndex + 1, signal)
    if (position) {
      items.push(position)
      return
    }
    const activity = activitySampleItem(signalIndex + 1, signal)
    if (activity) items.push(activity)
    else skippedPoints += 1
  })

  const semanticSegments = Array.isArray(parsed.semanticSegments)
    ? parsed.semanticSegments
    : []
  semanticSegments.forEach((segment, segmentIndex) => {
    if (!isRecord(segment)) {
      skippedPoints += 1
      return
    }
    if (Array.isArray(segment.timelinePath)) {
      segment.timelinePath.forEach((point, pointIndex) => {
        const item = timelinePathItem(segmentIndex, pointIndex, segment, point)
        if (item) items.push(item)
        else skippedPoints += 1
      })
    }
    const visit = timelineVisitItem(segmentIndex, segment)
    if (visit) items.push(visit)
    const activity = timelineActivityItem(segmentIndex, segment)
    if (activity) items.push(activity)
  })

  const frequentPlaces = isRecord(parsed.userLocationProfile) &&
    Array.isArray(parsed.userLocationProfile.frequentPlaces)
      ? parsed.userLocationProfile.frequentPlaces
      : []
  frequentPlaces.forEach((place, placeIndex) => {
    const item = frequentPlaceItem(placeIndex + 1, place)
    if (item) items.push(item)
    else skippedPoints += 1
  })

  const points: ParsedGeoPoint[] = items.flatMap((item) => {
    if (
      item.kind !== 'geo_point' ||
      item.latitude === undefined ||
      item.longitude === undefined ||
      item.timestamp === undefined
    ) {
      return []
    }
    return [
      {
        index: item.index,
        kind: 'geo_point',
        latitude: item.latitude,
        longitude: item.longitude,
        timestamp: item.timestamp,
        sourceDataset: item.sourceDataset,
        sourceType: item.sourceType,
        accuracyMeters: item.accuracyMeters,
        altitudeMeters: item.altitudeMeters,
        verticalAccuracyMeters: item.verticalAccuracyMeters,
        velocityMetersPerSecond: item.velocityMetersPerSecond,
        headingDegrees: item.headingDegrees,
        groupId: item.groupId,
        sequence: item.sequence,
        metadata: item.metadata,
      },
    ]
  })

  return {
    points,
    items,
    skippedPoints,
    mimeType: 'application/json',
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
      return 'google-timeline-json'
    }
    if (isRecord(parsed) && Array.isArray(parsed.timelineObjects)) {
      logGeoImportDebug(
        fileName,
        'Google Semantic Location History is not supported yet',
        parsed,
      )
      throw new Error(
        'This looks like Google Semantic Location History JSON. That is valid Google Takeout data, but this importer currently supports only raw Records.json and the newer Timeline JSON export.',
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

  if (isGpxText(fileText)) return 'gpx'

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
    case 'google-timeline-json':
      return parseGoogleTimelineLocationItems(fileText)
    case 'gpx':
      return parseGpxPoints(fileText)
  }
}
