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
  maxDurationMs?: number
}

function completeJsonObject(
  buffer: string,
  startOffset: number,
): CompleteObject | undefined {
  if (buffer[startOffset] !== '{') return undefined

  let depth = 0
  let inString = false
  let escaped = false

  for (let index = startOffset; index < buffer.length; index += 1) {
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
          text: buffer.slice(startOffset, index + 1),
          endOffset: index + 1,
        }
      }
    }
  }

  return undefined
}

function skipLeadingJsonSeparators(buffer: string, offset: number): number {
  let index = offset
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
  private cursor = 0
  private skippedPoints = 0
  private totalEntries = 0

  private compactBuffer(force = false): void {
    if (this.cursor === 0) return
    if (!force && this.cursor < 64 * 1024 && this.cursor < this.buffer.length / 2) {
      return
    }
    this.buffer = this.buffer.slice(this.cursor)
    this.cursor = 0
  }

  feed(chunk: string, options: FeedOptions = {}): GoogleTakeoutStreamChunk {
    if (this.phase === 'done') {
      return { points: [], skippedPoints: 0, paused: false }
    }

    this.buffer += chunk
    const points: ParsedGeoPoint[] = []
    let skippedPoints = 0
    const maxEntries = Math.max(0, options.maxEntries ?? Infinity)
    const deadline =
      typeof options.maxDurationMs === 'number'
        ? performance.now() + Math.max(0, options.maxDurationMs)
        : Infinity
    let processedEntries = 0

    while (true) {
      if (
        processedEntries >= maxEntries ||
        (processedEntries > 0 && performance.now() >= deadline)
      ) {
        this.compactBuffer(true)
        return { points, skippedPoints, paused: true }
      }

      if (this.phase === 'beforeLocations') {
        const locationIndex = this.buffer.indexOf(
          LOCATIONS_PROPERTY,
          this.cursor,
        )
        if (locationIndex < 0) {
          this.cursor = Math.max(
            0,
            this.buffer.length - (LOCATIONS_PROPERTY.length - 1),
          )
          this.compactBuffer(true)
          break
        }
        this.cursor = locationIndex + LOCATIONS_PROPERTY.length
        this.phase = 'beforeArray'
      }

      if (this.phase === 'beforeArray') {
        const arrayStart = this.buffer.indexOf('[', this.cursor)
        if (arrayStart < 0) {
          this.compactBuffer(true)
          break
        }
        this.cursor = arrayStart + 1
        this.phase = 'inArray'
      }

      if (this.phase !== 'inArray') continue

      this.cursor = skipLeadingJsonSeparators(this.buffer, this.cursor)

      if (this.cursor >= this.buffer.length) {
        this.compactBuffer(true)
        break
      }
      if (this.buffer[this.cursor] === ']') {
        this.phase = 'done'
        this.buffer = ''
        this.cursor = 0
        break
      }
      if (this.buffer[this.cursor] !== '{') {
        throw new Error(
          'The selected JSON file does not look like raw Google Takeout Records.json data.',
        )
      }

      const completeObject = completeJsonObject(this.buffer, this.cursor)
      if (!completeObject) {
        this.compactBuffer(true)
        break
      }

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
      this.cursor = completeObject.endOffset
      this.compactBuffer()
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
