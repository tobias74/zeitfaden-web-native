import type { TranslationKey, TranslationValues } from '../i18n'
import type { MediaItem, MediaLocation } from '../types'

type Translator = (key: TranslationKey, values?: TranslationValues) => string

export type MediaFact = {
  label: string
  value: string
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : undefined
}

function metadataRecord(item: MediaItem): Record<string, unknown> {
  return item.metadata && typeof item.metadata === 'object' && !Array.isArray(item.metadata)
    ? item.metadata
    : {}
}

export function itemGroupId(item: MediaItem): string | undefined {
  return item.groupId ?? item.locations.find((location) => location.groupId)?.groupId
}

export function itemSequence(item: MediaItem): number | undefined {
  return item.sequence ?? item.locations.find((location) => location.sequence !== undefined)?.sequence
}

export function formatTimelineGroupId(groupId: string, t: Translator): string {
  const [, , segmentNumber] = groupId.split(':')
  if (groupId.startsWith('google_timeline_segment:v1:') && segmentNumber) {
    return t('timelineSegment', { number: segmentNumber })
  }
  return groupId
}

export function formatMeters(value: number, locale: string): string {
  if (Math.abs(value) >= 1_000) {
    return `${(value / 1_000).toLocaleString(locale, {
      maximumFractionDigits: 1,
    })} km`
  }
  return `${value.toLocaleString(locale, {
    maximumFractionDigits: value < 10 ? 1 : 0,
  })} m`
}

function formatSpeedMetersPerSecond(value: number, locale: string): string {
  return `${(value * 3.6).toLocaleString(locale, {
    maximumFractionDigits: 1,
  })} km/h`
}

function formatDegrees(value: number, locale: string): string {
  return `${value.toLocaleString(locale, { maximumFractionDigits: 0 })}°`
}

function formatProbability(value: number, locale: string): string {
  return `${(value * 100).toLocaleString(locale, {
    maximumFractionDigits: 0,
  })}%`
}

function pushFact(
  facts: MediaFact[],
  label: string,
  value: string | number | undefined,
) {
  if (value === undefined || value === '') return
  facts.push({ label, value: String(value) })
}

export function importedMediaFacts(
  item: MediaItem,
  locale: string,
  t: Translator,
): MediaFact[] {
  const metadata = metadataRecord(item)
  const facts: MediaFact[] = []
  const groupId = itemGroupId(item)
  const sequence = itemSequence(item)
  const distanceMeters = numberValue(metadata.distanceMeters)
  const probability = numberValue(metadata.probability)
    ?? numberValue(metadata.topCandidateProbability)
  const endLatitude = numberValue(metadata.endLatitude)
  const endLongitude = numberValue(metadata.endLongitude)

  pushFact(facts, t('sourceDataset'), item.sourceDataset)
  pushFact(facts, t('sourceType'), item.sourceType)
  if (typeof item.accuracyMeters === 'number') {
    pushFact(facts, t('accuracy'), formatMeters(item.accuracyMeters, locale))
  }
  if (typeof item.altitudeMeters === 'number') {
    pushFact(facts, t('altitude'), formatMeters(item.altitudeMeters, locale))
  }
  if (typeof item.verticalAccuracyMeters === 'number') {
    pushFact(
      facts,
      t('verticalAccuracy'),
      formatMeters(item.verticalAccuracyMeters, locale),
    )
  }
  if (typeof item.velocityMetersPerSecond === 'number') {
    pushFact(
      facts,
      t('velocity'),
      formatSpeedMetersPerSecond(item.velocityMetersPerSecond, locale),
    )
  }
  if (typeof item.headingDegrees === 'number') {
    pushFact(facts, t('heading'), formatDegrees(item.headingDegrees, locale))
  }
  if (groupId) {
    pushFact(facts, t('timelineGroup'), formatTimelineGroupId(groupId, t))
  }
  if (typeof sequence === 'number') {
    pushFact(facts, t('sequence'), (sequence + 1).toLocaleString(locale))
  }
  pushFact(facts, t('activityType'), stringValue(metadata.activityType))
  pushFact(facts, t('semanticType'), stringValue(metadata.semanticType))
  pushFact(facts, t('placeId'), stringValue(metadata.placeId))
  pushFact(facts, t('placeLabel'), stringValue(metadata.label))
  if (typeof distanceMeters === 'number') {
    pushFact(facts, t('timelineDistance'), formatMeters(distanceMeters, locale))
  }
  if (typeof probability === 'number') {
    pushFact(facts, t('probability'), formatProbability(probability, locale))
  }
  if (typeof endLatitude === 'number' && typeof endLongitude === 'number') {
    pushFact(
      facts,
      t('endLocation'),
      `${endLatitude.toFixed(5)}, ${endLongitude.toFixed(5)}`,
    )
  }
  return facts
}

export function locationTimelineFacts(
  location: MediaLocation | undefined,
  locale: string,
  t: Translator,
): MediaFact[] {
  if (!location) return []
  const facts: MediaFact[] = []
  if (location.sourceDataset) {
    pushFact(facts, t('sourceDataset'), location.sourceDataset)
  }
  if (location.sourceType) {
    pushFact(facts, t('sourceType'), location.sourceType)
  }
  if (location.groupId) {
    pushFact(facts, t('timelineGroup'), formatTimelineGroupId(location.groupId, t))
  }
  if (typeof location.sequence === 'number') {
    pushFact(facts, t('sequence'), (location.sequence + 1).toLocaleString(locale))
  }
  return facts
}
