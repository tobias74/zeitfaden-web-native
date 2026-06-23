#!/usr/bin/env node
import { createWriteStream } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, extname, join, resolve } from 'node:path'
import { once } from 'node:events'
import { finished } from 'node:stream/promises'

const DEFAULT_CENTER = [48.137154, 11.576124]
const DEFAULT_RADIUS_KM = 10
const DEFAULT_START = '2026-01-01T00:00:00.000Z'
const DEFAULT_INTERVAL_MS = 60_000
const DEFAULT_SEED = 1

const usage = `Generate large geo test files with random points.

Usage:
  npm run generate:geo -- --format both --points 100000 --out tmp/geo-fixtures
  node scripts/generate-geo-fixtures.mjs --format gpx --points 1000 --out tmp/geo-fixtures/track.gpx
  node scripts/generate-geo-fixtures.mjs --format takeout --points 1000 --out tmp/geo-fixtures/Records.json

Options:
  --format <gpx|takeout|both>       Output format. Default: both
  --points, -n <count>              Number of points to generate. Default: 1000
  --out, -o <path>                  Output file, or output directory for --format both.
                                    Default: tmp/geo-fixtures
  --seed <integer>                  Deterministic random seed. Default: 1
  --center <lat,lon>                Center for generated points. Default: Munich
  --radius-km <number>              Radius around --center. Default: 10
  --bounds <minLat,minLon,maxLat,maxLon>
                                    Generate points inside an explicit bounding box.
                                    Overrides --center and --radius-km.
  --start <iso-date>                First point timestamp. Default: ${DEFAULT_START}
  --interval-ms <milliseconds>      Time between points. Default: ${DEFAULT_INTERVAL_MS}
  --gpx-point <trkpt|rtept|wpt>     GPX point tag. Default: trkpt
  --takeout-timestamp <timestampMs|timestamp>
                                    Takeout timestamp field. Default: timestampMs
  --pretty                         Pretty-print Google Takeout JSON.
  --help, -h                       Show this help.
`

function fail(message) {
  console.error(message)
  console.error('')
  console.error(usage)
  process.exit(1)
}

function readOption(args, name, shorthand) {
  const longPrefix = `${name}=`
  const index = args.findIndex((arg) => arg === name || arg.startsWith(longPrefix))
  if (index >= 0) {
    const arg = args[index]
    return arg.startsWith(longPrefix) ? arg.slice(longPrefix.length) : args[index + 1]
  }

  if (shorthand) {
    const shortIndex = args.findIndex((arg) => arg === shorthand)
    if (shortIndex >= 0) return args[shortIndex + 1]
  }

  return undefined
}

function hasFlag(args, name, shorthand) {
  return args.includes(name) || (shorthand ? args.includes(shorthand) : false)
}

function parseInteger(value, label, defaultValue) {
  if (value === undefined) return defaultValue
  if (!/^\d+$/.test(value)) fail(`${label} must be a non-negative integer.`)
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed)) fail(`${label} is too large.`)
  return parsed
}

function parseNumber(value, label, defaultValue) {
  if (value === undefined) return defaultValue
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) fail(`${label} must be a finite number.`)
  return parsed
}

function parsePair(value, label) {
  const parts = value?.split(',').map(Number)
  if (!parts || parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) {
    fail(`${label} must use the form lat,lon.`)
  }
  return parts
}

function parseBounds(value) {
  if (value === undefined) return undefined
  const parts = value.split(',').map(Number)
  if (parts.length !== 4 || parts.some((part) => !Number.isFinite(part))) {
    fail('--bounds must use the form minLat,minLon,maxLat,maxLon.')
  }

  const [minLat, minLon, maxLat, maxLon] = parts
  if (minLat > maxLat || minLon > maxLon) {
    fail('--bounds minimum values must be less than or equal to maximum values.')
  }
  validateLatitude(minLat, '--bounds minLat')
  validateLatitude(maxLat, '--bounds maxLat')
  validateLongitude(minLon, '--bounds minLon')
  validateLongitude(maxLon, '--bounds maxLon')

  return { minLat, minLon, maxLat, maxLon }
}

function validateLatitude(value, label) {
  if (value < -90 || value > 90) fail(`${label} must be between -90 and 90.`)
}

function validateLongitude(value, label) {
  if (value < -180 || value > 180) fail(`${label} must be between -180 and 180.`)
}

function boundsAroundCenter(center, radiusKm) {
  const [latitude, longitude] = center
  validateLatitude(latitude, '--center latitude')
  validateLongitude(longitude, '--center longitude')
  if (radiusKm < 0) fail('--radius-km must be greater than or equal to 0.')

  const latDelta = radiusKm / 111.32
  const lonScale = Math.max(Math.cos((latitude * Math.PI) / 180), 0.01)
  const lonDelta = radiusKm / (111.32 * lonScale)

  return {
    minLat: Math.max(-90, latitude - latDelta),
    minLon: Math.max(-180, longitude - lonDelta),
    maxLat: Math.min(90, latitude + latDelta),
    maxLon: Math.min(180, longitude + lonDelta),
  }
}

function makeRandom(seed) {
  let state = seed >>> 0
  return () => {
    state += 0x6d2b79f5
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296
  }
}

function randomBetween(random, min, max) {
  return min + random() * (max - min)
}

function coordinateE7(value) {
  return Math.round(value * 10_000_000)
}

function isoTimestamp(timestampMs) {
  return new Date(timestampMs).toISOString()
}

function pointAt(index, options, random) {
  const latitude = randomBetween(random, options.bounds.minLat, options.bounds.maxLat)
  const longitude = randomBetween(random, options.bounds.minLon, options.bounds.maxLon)
  return {
    latitude,
    longitude,
    timestamp: options.startTime + index * options.intervalMs,
    accuracy: Math.floor(randomBetween(random, 5, 80)),
  }
}

function gpxPoint(point, pointTag) {
  return `      <${pointTag} lat="${point.latitude.toFixed(7)}" lon="${point.longitude.toFixed(7)}"><time>${isoTimestamp(point.timestamp)}</time></${pointTag}>\n`
}

function takeoutPoint(point, timestampField, pretty) {
  const entry = {
    latitudeE7: coordinateE7(point.latitude),
    longitudeE7: coordinateE7(point.longitude),
    accuracy: point.accuracy,
    source: 'GPS',
  }

  if (timestampField === 'timestamp') {
    entry.timestamp = isoTimestamp(point.timestamp)
  } else {
    entry.timestampMs = String(point.timestamp)
  }

  return pretty
    ? JSON.stringify(entry, null, 2).replaceAll('\n', '\n    ')
    : JSON.stringify(entry)
}

async function write(stream, chunk) {
  if (!stream.write(chunk)) await once(stream, 'drain')
}

async function writeGpx(path, options) {
  await mkdir(dirname(path), { recursive: true })
  const stream = createWriteStream(path, { encoding: 'utf8' })
  const random = makeRandom(options.seed)

  try {
    await write(stream, '<?xml version="1.0" encoding="UTF-8"?>\n')
    await write(
      stream,
      '<gpx version="1.1" creator="ding fixture generator" xmlns="http://www.topografix.com/GPX/1/1">\n',
    )

    if (options.gpxPoint === 'trkpt') {
      await write(stream, '  <trk><name>Generated Test Track</name><trkseg>\n')
    } else if (options.gpxPoint === 'rtept') {
      await write(stream, '  <rte><name>Generated Test Route</name>\n')
    }

    for (let index = 0; index < options.points; index += 1) {
      const point = pointAt(index, options, random)
      await write(stream, gpxPoint(point, options.gpxPoint))
    }

    if (options.gpxPoint === 'trkpt') {
      await write(stream, '  </trkseg></trk>\n')
    } else if (options.gpxPoint === 'rtept') {
      await write(stream, '  </rte>\n')
    }

    await write(stream, '</gpx>\n')
  } finally {
    stream.end()
    await finished(stream)
  }
}

async function writeTakeout(path, options) {
  await mkdir(dirname(path), { recursive: true })
  const stream = createWriteStream(path, { encoding: 'utf8' })
  const random = makeRandom(options.seed)
  const newline = options.pretty ? '\n' : ''
  const indent = options.pretty ? '  ' : ''

  try {
    await write(stream, `{"locations":[${newline}`)
    for (let index = 0; index < options.points; index += 1) {
      const point = pointAt(index, options, random)
      const separator = index === options.points - 1 ? '' : ','
      await write(
        stream,
        `${indent}${takeoutPoint(point, options.takeoutTimestamp, options.pretty)}${separator}${newline}`,
      )
    }
    await write(stream, ']}')
    if (options.pretty) await write(stream, '\n')
  } finally {
    stream.end()
    await finished(stream)
  }
}

function outputPaths(format, out) {
  if (format === 'both') {
    return {
      gpx: join(out, 'generated-track.gpx'),
      takeout: join(out, 'Records.json'),
    }
  }

  const extension = extname(out)
  if (extension) return { [format]: out }

  return {
    [format]: join(out, format === 'gpx' ? 'generated-track.gpx' : 'Records.json'),
  }
}

function parseOptions(args) {
  if (hasFlag(args, '--help', '-h')) {
    console.log(usage)
    process.exit(0)
  }

  const format = readOption(args, '--format') ?? 'both'
  if (!['gpx', 'takeout', 'both'].includes(format)) {
    fail('--format must be one of gpx, takeout, or both.')
  }

  const gpxPoint = readOption(args, '--gpx-point') ?? 'trkpt'
  if (!['trkpt', 'rtept', 'wpt'].includes(gpxPoint)) {
    fail('--gpx-point must be one of trkpt, rtept, or wpt.')
  }

  const takeoutTimestamp = readOption(args, '--takeout-timestamp') ?? 'timestampMs'
  if (!['timestampMs', 'timestamp'].includes(takeoutTimestamp)) {
    fail('--takeout-timestamp must be timestampMs or timestamp.')
  }

  const points = parseInteger(readOption(args, '--points', '-n'), '--points', 1_000)
  const seed = parseInteger(readOption(args, '--seed'), '--seed', DEFAULT_SEED)
  const center = parsePair(
    readOption(args, '--center') ?? DEFAULT_CENTER.join(','),
    '--center',
  )
  const radiusKm = parseNumber(
    readOption(args, '--radius-km'),
    '--radius-km',
    DEFAULT_RADIUS_KM,
  )
  const startInput = readOption(args, '--start') ?? DEFAULT_START
  const startTime = Date.parse(startInput)
  if (!Number.isFinite(startTime)) fail('--start must be a valid date.')

  const intervalMs = parseInteger(
    readOption(args, '--interval-ms'),
    '--interval-ms',
    DEFAULT_INTERVAL_MS,
  )
  const out = resolve(readOption(args, '--out', '-o') ?? 'tmp/geo-fixtures')
  const explicitBounds = parseBounds(readOption(args, '--bounds'))

  return {
    bounds: explicitBounds ?? boundsAroundCenter(center, radiusKm),
    format,
    gpxPoint,
    intervalMs,
    out,
    paths: outputPaths(format, out),
    points,
    pretty: hasFlag(args, '--pretty'),
    seed,
    startTime,
    takeoutTimestamp,
  }
}

async function main() {
  const options = parseOptions(process.argv.slice(2))
  const outputs = []

  if (options.paths.gpx) {
    await writeGpx(options.paths.gpx, options)
    outputs.push(options.paths.gpx)
  }

  if (options.paths.takeout) {
    await writeTakeout(options.paths.takeout, options)
    outputs.push(options.paths.takeout)
  }

  console.log(`Generated ${options.points.toLocaleString('en-US')} points per file.`)
  for (const output of outputs) console.log(output)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
