import Feature from 'ol/Feature'
import Map from 'ol/Map'
import View from 'ol/View'
import { boundingExtent } from 'ol/extent'
import Point from 'ol/geom/Point'
import ExtentInteraction from 'ol/interaction/Extent'
import TileLayer from 'ol/layer/Tile'
import VectorLayer from 'ol/layer/Vector'
import { fromLonLat, toLonLat } from 'ol/proj'
import Cluster from 'ol/source/Cluster'
import OSM from 'ol/source/OSM'
import VectorSource from 'ol/source/Vector'
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style'
import { useEffect, useRef } from 'react'
import type { EnrichedSearchResult, GeoBounds, MediaItem } from '../types'
import type { FeatureLike } from 'ol/Feature'
import type { Coordinate } from 'ol/coordinate'
import type { Extent } from 'ol/extent'
import type { Pixel } from 'ol/pixel'

type QueryPoint = {
  lat: number
  lon: number
}

type MapViewProps = {
  queryPoint?: QueryPoint
  geoItems: MediaItem[]
  results: EnrichedSearchResult[]
  geoBounds?: GeoBounds
  boundsDrawing: boolean
  label: string
  onQueryPointChange: (point: QueryPoint) => void
  onGeoBoundsChange: (bounds: GeoBounds) => void
}

const baseStyle = new Style({
  image: new CircleStyle({
    radius: 4,
    fill: new Fill({ color: '#6f7887' }),
    stroke: new Stroke({ color: '#ffffff', width: 1.5 }),
  }),
})

const resultStyle = new Style({
  image: new CircleStyle({
    radius: 6,
    fill: new Fill({ color: '#008a72' }),
    stroke: new Stroke({ color: '#ffffff', width: 2 }),
  }),
})

const queryStyle = new Style({
  image: new CircleStyle({
    radius: 8,
    fill: new Fill({ color: '#d84d2a' }),
    stroke: new Stroke({ color: '#ffffff', width: 2.5 }),
  }),
})

const boundsStyle = new Style({
  fill: new Fill({ color: 'rgba(216, 77, 42, 0.12)' }),
  stroke: new Stroke({ color: '#d84d2a', width: 2 }),
})

const boundsHandleStyle = new Style({
  image: new CircleStyle({
    radius: 5,
    fill: new Fill({ color: '#ffffff' }),
    stroke: new Stroke({ color: '#d84d2a', width: 2 }),
  }),
})

const clusterStyleCache = new globalThis.Map<string, Style>()
const CLUSTER_BOUNDS_PADDING_RATIO = 0.12
const MIN_CLUSTER_BOUNDS_PADDING_METERS = 250
const AREA_CURSOR_TOLERANCE_PX = 10

function clusterStyle(feature: FeatureLike): Style {
  const clusteredFeatures = (feature.get('features') ?? []) as Feature[]
  const size = clusteredFeatures.length
  const hasResult = clusteredFeatures.some(
    (clusteredFeature) => clusteredFeature.get('isResult') === true,
  )

  if (size <= 1) {
    return hasResult ? resultStyle : baseStyle
  }

  const bucket = size >= 100 ? 'large' : size >= 10 ? 'medium' : 'small'
  const key = `${hasResult ? 'result' : 'base'}:${bucket}:${size}`
  const cachedStyle = clusterStyleCache.get(key)
  if (cachedStyle) return cachedStyle

  const radius = bucket === 'large' ? 22 : bucket === 'medium' ? 18 : 15
  const style = new Style({
    image: new CircleStyle({
      radius,
      fill: new Fill({ color: hasResult ? '#008a72' : '#4f5b69' }),
      stroke: new Stroke({ color: '#ffffff', width: 2.5 }),
    }),
    text: new Text({
      text: size.toLocaleString(),
      fill: new Fill({ color: '#ffffff' }),
      stroke: new Stroke({ color: hasResult ? '#005446' : '#303846', width: 2 }),
      font: '700 12px system-ui, sans-serif',
    }),
  })

  clusterStyleCache.set(key, style)
  return style
}

function coordinatesForCluster(feature: FeatureLike): Coordinate[] {
  const clusteredFeatures = (feature.get('features') ?? []) as Feature[]
  return clusteredFeatures.flatMap((clusteredFeature) => {
    const geometry = clusteredFeature.getGeometry()
    return geometry instanceof Point ? [geometry.getCoordinates()] : []
  })
}

function boundedLatitude(value: number): number {
  return Math.min(90, Math.max(-90, value))
}

function boundedLongitude(value: number): number {
  return Math.min(180, Math.max(-180, value))
}

function boundsFromMapExtent(extent: Extent): GeoBounds {
  const [leftLon, bottomLat] = toLonLat([extent[0], extent[1]])
  const [rightLon, topLat] = toLonLat([extent[2], extent[3]])

  return {
    minLat: boundedLatitude(Math.min(bottomLat, topLat)),
    maxLat: boundedLatitude(Math.max(bottomLat, topLat)),
    minLon: boundedLongitude(Math.min(leftLon, rightLon)),
    maxLon: boundedLongitude(Math.max(leftLon, rightLon)),
  }
}

function boundsFromClusterCoordinates(
  coordinates: Coordinate[],
): GeoBounds | undefined {
  if (coordinates.length === 0) return undefined

  const extent = boundingExtent(coordinates) as [number, number, number, number]
  const width = extent[2] - extent[0]
  const height = extent[3] - extent[1]
  const paddingX = Math.max(
    width * CLUSTER_BOUNDS_PADDING_RATIO,
    MIN_CLUSTER_BOUNDS_PADDING_METERS,
  )
  const paddingY = Math.max(
    height * CLUSTER_BOUNDS_PADDING_RATIO,
    MIN_CLUSTER_BOUNDS_PADDING_METERS,
  )

  return boundsFromMapExtent([
    extent[0] - paddingX,
    extent[1] - paddingY,
    extent[2] + paddingX,
    extent[3] + paddingY,
  ])
}

function mapExtentFromBounds(bounds: GeoBounds): Extent {
  const [minX, minY] = fromLonLat([bounds.minLon, bounds.minLat])
  const [maxX, maxY] = fromLonLat([bounds.maxLon, bounds.maxLat])

  return [
    Math.min(minX, maxX),
    Math.min(minY, maxY),
    Math.max(minX, maxX),
    Math.max(minY, maxY),
  ]
}

function clearExtentInteraction(interaction: ExtentInteraction): void {
  const clearableInteraction = interaction as {
    setExtent(extent: Extent | null): void
  }
  clearableInteraction.setExtent(null)
}

function currentExtent(interaction: ExtentInteraction): Extent | undefined {
  return (
    interaction as {
      getExtent(): Extent | null
    }
  ).getExtent() ?? undefined
}

function isPixelBetween(value: number, min: number, max: number): boolean {
  return (
    value >= min - AREA_CURSOR_TOLERANCE_PX &&
    value <= max + AREA_CURSOR_TOLERANCE_PX
  )
}

function areaCursorForPixel(map: Map, extent: Extent, pixel: Pixel): string {
  const topLeft = map.getPixelFromCoordinate([extent[0], extent[3]])
  const bottomRight = map.getPixelFromCoordinate([extent[2], extent[1]])
  const left = Math.min(topLeft[0], bottomRight[0])
  const right = Math.max(topLeft[0], bottomRight[0])
  const top = Math.min(topLeft[1], bottomRight[1])
  const bottom = Math.max(topLeft[1], bottomRight[1])
  const [x, y] = pixel

  const nearLeft =
    Math.abs(x - left) <= AREA_CURSOR_TOLERANCE_PX && isPixelBetween(y, top, bottom)
  const nearRight =
    Math.abs(x - right) <= AREA_CURSOR_TOLERANCE_PX && isPixelBetween(y, top, bottom)
  const nearTop =
    Math.abs(y - top) <= AREA_CURSOR_TOLERANCE_PX && isPixelBetween(x, left, right)
  const nearBottom =
    Math.abs(y - bottom) <= AREA_CURSOR_TOLERANCE_PX && isPixelBetween(x, left, right)

  if ((nearLeft && nearTop) || (nearRight && nearBottom)) {
    return 'nwse-resize'
  }
  if ((nearRight && nearTop) || (nearLeft && nearBottom)) {
    return 'nesw-resize'
  }
  if (nearLeft || nearRight) return 'ew-resize'
  if (nearTop || nearBottom) return 'ns-resize'

  if (
    x > left + AREA_CURSOR_TOLERANCE_PX &&
    x < right - AREA_CURSOR_TOLERANCE_PX &&
    y > top + AREA_CURSOR_TOLERANCE_PX &&
    y < bottom - AREA_CURSOR_TOLERANCE_PX
  ) {
    return 'move'
  }

  return 'crosshair'
}

function setMapCursor(target: HTMLElement, map: Map, cursor: string): void {
  target.style.cursor = cursor
  map.getViewport().style.cursor = cursor
}

export function MapView({
  queryPoint,
  geoItems,
  results,
  geoBounds,
  boundsDrawing,
  label,
  onQueryPointChange,
  onGeoBoundsChange,
}: MapViewProps) {
  const targetRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Map | null>(null)
  const extentInteractionRef = useRef<ExtentInteraction | null>(null)
  const boundsDrawingRef = useRef(boundsDrawing)
  const hasGeoBoundsRef = useRef(Boolean(geoBounds))
  const pendingBoundsExtentRef = useRef<Extent | undefined>(undefined)
  const syncingBoundsRef = useRef(false)
  const sourceRef = useRef(new VectorSource())
  const querySourceRef = useRef(new VectorSource())

  useEffect(() => {
    if (!targetRef.current || mapRef.current) return

    const target = targetRef.current
    const clusterSource = new Cluster({
      distance: 42,
      minDistance: 16,
      source: sourceRef.current,
    })
    const clusterLayer = new VectorLayer({
      source: clusterSource,
      style: clusterStyle,
    })
    const queryLayer = new VectorLayer({
      source: querySourceRef.current,
      style: queryStyle,
    })
    const extentInteraction = new ExtentInteraction({
      drag: true,
      boxStyle: boundsStyle,
      pointerStyle: boundsHandleStyle,
      pixelTolerance: 10,
    })
    extentInteraction.setActive(boundsDrawingRef.current)

    const map = new Map({
      target,
      layers: [
        new TileLayer({
          source: new OSM(),
        }),
        clusterLayer,
        queryLayer,
      ],
      view: new View({
        center: fromLonLat([8.5417, 47.3769]),
        zoom: 4,
      }),
    })
    map.addInteraction(extentInteraction)

    const commitPendingBounds = () => {
      const extent = pendingBoundsExtentRef.current
      pendingBoundsExtentRef.current = undefined
      if (!boundsDrawingRef.current || !extent) return
      if (extent[0] === extent[2] || extent[1] === extent[3]) return
      onGeoBoundsChange(boundsFromMapExtent(extent))
    }

    extentInteraction.on('extentchanged', (event) => {
      if (syncingBoundsRef.current || !event.extent) return
      const extent = event.extent.slice() as Extent
      if (extent[0] === extent[2] || extent[1] === extent[3]) return
      pendingBoundsExtentRef.current = extent
    })
    document.addEventListener('pointerup', commitPendingBounds)
    document.addEventListener('pointercancel', commitPendingBounds)

    map.on('singleclick', (event) => {
      if (boundsDrawingRef.current) return

      const clickedCluster = map.forEachFeatureAtPixel(
        event.pixel,
        (feature, layer) => (layer === clusterLayer ? feature : undefined),
      )
      if (clickedCluster) {
        const coordinates = coordinatesForCluster(clickedCluster)
        if (coordinates.length > 1) {
          const bounds = boundsFromClusterCoordinates(coordinates)
          if (bounds) onGeoBoundsChange(bounds)
          return
        }
      }

      const [lon, lat] = toLonLat(event.coordinate)
      onQueryPointChange({ lat, lon })
    })

    map.on('pointermove', (event) => {
      if (boundsDrawingRef.current) {
        const extent = currentExtent(extentInteraction)
        setMapCursor(
          target,
          map,
          hasGeoBoundsRef.current && extent
            ? areaCursorForPixel(map, extent, event.pixel)
            : 'crosshair',
        )
        return
      }

      if (event.dragging) {
        setMapCursor(target, map, '')
        return
      }

      const hoveredCluster = map.forEachFeatureAtPixel(
        event.pixel,
        (feature, layer) => (layer === clusterLayer ? feature : undefined),
      )
      setMapCursor(
        target,
        map,
        hoveredCluster && coordinatesForCluster(hoveredCluster).length > 1
          ? 'pointer'
          : '',
      )
    })

    mapRef.current = map
    extentInteractionRef.current = extentInteraction
    const resizeObserver = new ResizeObserver(() => map.updateSize())
    resizeObserver.observe(target)

    return () => {
      document.removeEventListener('pointerup', commitPendingBounds)
      document.removeEventListener('pointercancel', commitPendingBounds)
      resizeObserver.disconnect()
      map.removeInteraction(extentInteraction)
      map.setTarget(undefined)
      mapRef.current = null
      extentInteractionRef.current = null
    }
  }, [onGeoBoundsChange, onQueryPointChange])

  useEffect(() => {
    boundsDrawingRef.current = boundsDrawing
    if (!boundsDrawing) pendingBoundsExtentRef.current = undefined
    extentInteractionRef.current?.setActive(boundsDrawing)
    if (!boundsDrawing && targetRef.current && mapRef.current) {
      setMapCursor(targetRef.current, mapRef.current, '')
    }
  }, [boundsDrawing])

  useEffect(() => {
    const source = sourceRef.current
    const querySource = querySourceRef.current
    source.clear()
    querySource.clear()

    const resultIds = new Set(results.map((result) => result.mediaId))

    for (const item of geoItems) {
      if (typeof item.latitude !== 'number' || typeof item.longitude !== 'number') {
        continue
      }
      const feature = new Feature({
        geometry: new Point(fromLonLat([item.longitude, item.latitude])),
      })
      feature.set('mediaId', item.id)
      feature.set('isResult', resultIds.has(item.id))
      source.addFeature(feature)
    }

    if (queryPoint) {
      const feature = new Feature({
        geometry: new Point(fromLonLat([queryPoint.lon, queryPoint.lat])),
      })
      querySource.addFeature(feature)
    }
  }, [geoItems, queryPoint, results])

  useEffect(() => {
    hasGeoBoundsRef.current = Boolean(geoBounds)
    const extentInteraction = extentInteractionRef.current
    if (!extentInteraction) return

    syncingBoundsRef.current = true
    if (geoBounds) {
      extentInteraction.setExtent(mapExtentFromBounds(geoBounds))
    } else {
      clearExtentInteraction(extentInteraction)
    }
    syncingBoundsRef.current = false
  }, [geoBounds])

  return <div ref={targetRef} className="map-view" aria-label={label} />
}
