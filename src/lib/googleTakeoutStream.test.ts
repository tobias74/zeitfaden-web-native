import { describe, expect, it } from 'vitest'
import { GoogleTakeoutLocationStreamParser } from './googleTakeoutStream'

function parseChunks(chunks: string[]) {
  const parser = new GoogleTakeoutLocationStreamParser()
  const points = []
  let skippedPoints = 0

  for (const chunk of chunks) {
    const result = parser.feed(chunk)
    points.push(...result.points)
    skippedPoints += result.skippedPoints
  }

  const final = parser.finish()
  return {
    points,
    skippedPoints,
    totalEntries: final.totalEntries,
    finalSkippedPoints: final.skippedPoints,
  }
}

describe('GoogleTakeoutLocationStreamParser', () => {
  it('parses raw Records.json locations across chunk boundaries', () => {
    const result = parseChunks([
      '{"locations',
      '": [{"latitudeE7":481370673,"longitudeE7":115775995,',
      '"timestamp":"2012-10-28T14:21:22.010Z"},{"latitudeE7":"481374628",',
      '"longitudeE7":"115781587","timestampMS":"1351434206077"}]}',
    ])

    expect(result.skippedPoints).toBe(0)
    expect(result.finalSkippedPoints).toBe(0)
    expect(result.totalEntries).toBe(2)
    expect(result.points).toEqual([
      {
        index: 1,
        latitude: 48.1370673,
        longitude: 11.5775995,
        capturedAt: Date.parse('2012-10-28T14:21:22.010Z'),
      },
      {
        index: 2,
        latitude: 48.1374628,
        longitude: 11.5781587,
        capturedAt: 1_351_434_206_077,
      },
    ])
  })

  it('skips invalid location entries while preserving stable indexes', () => {
    const result = parseChunks([
      '{"locations": [',
      '{"latitudeE7":481370673,"longitudeE7":115775995},',
      '{"latitudeE7":481370674,"longitudeE7":115775996,',
      '"timestampMs":"1351434206077"}',
      ']}',
    ])

    expect(result.skippedPoints).toBe(1)
    expect(result.finalSkippedPoints).toBe(1)
    expect(result.totalEntries).toBe(2)
    expect(result.points).toEqual([
      {
        index: 2,
        latitude: 48.1370674,
        longitude: 11.5775996,
        capturedAt: 1_351_434_206_077,
      },
    ])
  })

  it('can pause parsing after a bounded number of entries', () => {
    const parser = new GoogleTakeoutLocationStreamParser()
    const document = `{"locations":[${Array.from(
      { length: 5 },
      (_, index) =>
        `{"latitudeE7":48137067${index},"longitudeE7":11577599${index},"timestampMs":"13514342060${index}"}`,
    ).join(',')}]}`

    const first = parser.feed(document, { maxEntries: 2 })
    const second = parser.feed('', { maxEntries: 2 })
    const third = parser.feed('', { maxEntries: 2 })
    const final = parser.finish()

    expect(first.paused).toBe(true)
    expect(second.paused).toBe(true)
    expect(third.paused).toBe(false)
    expect(
      [...first.points, ...second.points, ...third.points].map(
        (point) => point.index,
      ),
    ).toEqual([1, 2, 3, 4, 5])
    expect(final.totalEntries).toBe(5)
  })

  it('rejects JSON without a locations array', () => {
    const parser = new GoogleTakeoutLocationStreamParser()
    parser.feed('{"items": []}')

    expect(() => parser.finish()).toThrow('Expected raw Google Takeout')
  })
})
