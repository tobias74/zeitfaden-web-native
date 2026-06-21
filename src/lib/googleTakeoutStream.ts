import {
  parseGoogleTakeoutLocationEntry,
  type ParsedGeoPoint,
} from './geoPoint'

type CompleteObject = {
  text: string
  endOffset: number
}

export type GoogleTakeoutStreamChunk = {
  points: ParsedGeoPoint[]
  skippedPoints: number
  paused: boolean
}

export type GoogleTakeoutStreamResult = {
  skippedPoints: number
  totalEntries: number
}

const LOCATIONS_PROPERTY = '"locations"'

type FeedOptions = {
  maxEntries?: number
}

function completeJsonObject(buffer: string): CompleteObject | undefined {
  if (!buffer.startsWith('{')) return undefined

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = 0; index < buffer.length; index += 1) {
    const character = buffer[index]

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (character === '\\') {
        escaped = true
      } else if (character === '"') {
        inString = false
      }
      continue
    }

    if (character === '"') {
      inString = true
    } else if (character === '{') {
      depth += 1
    } else if (character === '}') {
      depth -= 1
      if (depth === 0) {
        return {
          text: buffer.slice(0, index + 1),
          endOffset: index + 1,
        }
      }
    }
  }

  return undefined
}

function leadingJsonSeparatorLength(buffer: string): number {
  let index = 0
  while (index < buffer.length) {
    const character = buffer[index]
    if (
      character !== ',' &&
      character !== '\n' &&
      character !== '\r' &&
      character !== '\t' &&
      character !== ' '
    ) {
      break
    }
    index += 1
  }
  return index
}

export class GoogleTakeoutLocationStreamParser {
  private phase: 'beforeLocations' | 'beforeArray' | 'inArray' | 'done' =
    'beforeLocations'

  private buffer = ''
  private skippedPoints = 0
  private totalEntries = 0

  feed(chunk: string, options: FeedOptions = {}): GoogleTakeoutStreamChunk {
    if (this.phase === 'done') {
      return { points: [], skippedPoints: 0, paused: false }
    }

    this.buffer += chunk
    const points: ParsedGeoPoint[] = []
    let skippedPoints = 0
    const maxEntries = Math.max(0, options.maxEntries ?? Infinity)
    let processedEntries = 0

    while (true) {
      if (processedEntries >= maxEntries) {
        return { points, skippedPoints, paused: true }
      }

      if (this.phase === 'beforeLocations') {
        const locationIndex = this.buffer.indexOf(LOCATIONS_PROPERTY)
        if (locationIndex < 0) {
          this.buffer = this.buffer.slice(-(LOCATIONS_PROPERTY.length - 1))
          break
        }
        this.buffer = this.buffer.slice(locationIndex + LOCATIONS_PROPERTY.length)
        this.phase = 'beforeArray'
      }

      if (this.phase === 'beforeArray') {
        const arrayStart = this.buffer.indexOf('[')
        if (arrayStart < 0) break
        this.buffer = this.buffer.slice(arrayStart + 1)
        this.phase = 'inArray'
      }

      if (this.phase !== 'inArray') continue

      const separatorLength = leadingJsonSeparatorLength(this.buffer)
      if (separatorLength > 0) {
        this.buffer = this.buffer.slice(separatorLength)
      }

      if (this.buffer.length === 0) break
      if (this.buffer[0] === ']') {
        this.phase = 'done'
        this.buffer = ''
        break
      }
      if (this.buffer[0] !== '{') {
        throw new Error(
          'The selected JSON file does not look like raw Google Takeout Records.json data.',
        )
      }

      const completeObject = completeJsonObject(this.buffer)
      if (!completeObject) break

      processedEntries += 1
      this.totalEntries += 1
      const parsedEntry = JSON.parse(completeObject.text) as unknown
      const point = parseGoogleTakeoutLocationEntry(
        parsedEntry,
        this.totalEntries,
      )
      if (point) {
        points.push(point)
      } else {
        skippedPoints += 1
        this.skippedPoints += 1
      }
      this.buffer = this.buffer.slice(completeObject.endOffset)
    }

    return { points, skippedPoints, paused: false }
  }

  finish(): GoogleTakeoutStreamResult {
    this.feed('')
    if (this.phase === 'beforeLocations') {
      throw new Error(
        'The selected JSON file is not a supported geo import format. Expected raw Google Takeout Records.json with a locations array.',
      )
    }
    if (this.phase !== 'done') {
      throw new Error(
        'The selected Google Takeout JSON file ended before the locations array was complete.',
      )
    }

    return {
      skippedPoints: this.skippedPoints,
      totalEntries: this.totalEntries,
    }
  }
}
