import Feature from 'ol/Feature'
import Map from 'ol/Map'
import View from 'ol/View'
import Point from 'ol/geom/Point'
import ExtentInteraction from 'ol/interaction/Extent'
import TileLayer from 'ol/layer/Tile'
import VectorLayer from 'ol/layer/Vector'
import { fromLonLat, toLonLat } from 'ol/proj'
import OSM from 'ol/source/OSM'
import VectorSource from 'ol/source/Vector'
import { Circle as CircleStyle, Fill, Stroke, Style, Text } from 'ol/style'
import { useEffect, useRef } from 'react'
import type { GeoBounds, MapPoint } from '../types'
import type { FeatureLike } from 'ol/Feature'
import type { Extent } from 'ol/extent'
import type { Pixel } from 'ol/pixel'

type QueryPoint = {
  lat: number
  lon: number
}

type VisibleMapViewport = {
  bounds: GeoBounds
  zoom: number
  widthPx: number
  heightPx: number
}

type MapViewProps = {
  queryPoint?: QueryPoint
  geoItems: MapPoint[]
  renderBatchSize: number
  bubbleScale: number
  geoBounds?: GeoBounds
  boundsDrawing: boolean
  label: string
  onQueryPointChange: (point: QueryPoint) => void
  onGeoBoundsChange: (bounds: GeoBounds) => void
  onVisibleViewportChange: (viewport: VisibleMapViewport) => void
}

const baseStyle = new Style({
  image: new CircleStyle({
    radius: 4,
    fill: new Fill({ color: '#6f7887' }),
    stroke: new Stroke({ color: '#ffffff', width: 1.5 }),
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

const hiddenBoundsHandleStyle = new Style({})

const mapPointStyleCache = new globalThis.Map<string, Style>()
const AREA_CURSOR_TOLERANCE_PX = 10

function formatBubbleCount(count: number): string {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 10_000) return `${Math.round(count / 1_000)}k`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`
  return count.toLocaleString()
}

function featureBubbleCount(feature: FeatureLike): number {
  const count = Number(feature.get('count') ?? 1)
  return Number.isFinite(count) && count > 0 ? count : 1
}

function mapPointStyle(feature: FeatureLike, scale: number): Style {
  const count = featureBubbleCount(feature)
  if (count <= 1) {
    return baseStyle
  }

  const sizeBucket =
    count >= 1_000 ? 'huge' : count >= 100 ? 'large' : count >= 10 ? 'medium' : 'small'
  const label = formatBubbleCount(count)
  const key = `${scale}:${sizeBucket}:${label}`
  const cachedStyle = mapPointStyleCache.get(key)
  if (cachedStyle) return cachedStyle

  // Radii must stay in sync with bubbleRadiusForCount() in
  // platform/web/catalog.worker.ts, which uses them to merge overlapping bubbles.
  const baseRadius =
    sizeBucket === 'huge'
      ? 18
      : sizeBucket === 'large'
        ? 15
        : sizeBucket === 'medium'
          ? 12
          : 10
  const radius = baseRadius * scale
  const style = new Style({
    image: new CircleStyle({
      radius,
      fill: new Fill({ color: '#235d67' }),
      stroke: new Stroke({ color: '#ffffff', width: 2 }),
    }),
    text: new Text({
      text: label,
      fill: new Fill({ color: '#ffffff' }),
      stroke: new Stroke({ color: '#173b43', width: 2 }),
      font: '700 10px system-ui, sans-serif',
    }),
  })

  mapPointStyleCache.set(key, style)
  return style
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

function pointBoundsFromFeature(feature: FeatureLike): GeoBounds | undefined {
  const explicitBounds = feature.get('bounds') as GeoBounds | undefined
  if (explicitBounds) return explicitBounds

  const geometry = (feature as Feature).getGeometry?.()
  if (!(geometry instanceof Point)) return undefined

  const [lon, lat] = toLonLat(geometry.getCoordinates())
  const boundedLat = boundedLatitude(lat)
  const boundedLon = boundedLongitude(lon)
  return {
    minLat: boundedLat,
    maxLat: boundedLat,
    minLon: boundedLon,
    maxLon: boundedLon,
  }
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

function visibleViewportFromMap(map: Map): VisibleMapViewport | undefined {
  const size = map.getSize()
  if (!size || size[0] <= 0 || size[1] <= 0) return undefined

  return {
    bounds: boundsFromMapExtent(map.getView().calculateExtent(size)),
    zoom: map.getView().getZoom() ?? 0,
    widthPx: Math.round(size[0]),
    heightPx: Math.round(size[1]),
  }
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

function setExtentDragEnabled(
  interaction: ExtentInteraction,
  enabled: boolean,
): void {
  const draggableInteraction = interaction as unknown as { drag_: boolean }
  draggableInteraction.drag_ = enabled
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

  return 'grab'
}

function setMapCursor(target: HTMLElement, map: Map, cursor: string): void {
  target.style.cursor = cursor
  map.getViewport().style.cursor = cursor
}

function pointFeature(lon: number, lat: number): Feature {
  return new Feature({
    geometry: new Point(fromLonLat([lon, lat])),
  })
}

export function MapView({
  queryPoint,
  geoItems,
  renderBatchSize,
  bubbleScale,
  geoBounds,
  boundsDrawing,
  label,
  onQueryPointChange,
  onGeoBoundsChange,
  onVisibleViewportChange,
}: MapViewProps) {
  const targetRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Map | null>(null)
  // Read by the point-layer style closure; kept current so a bubble-size change
  // restyles features on the next render without re-creating the map.
  const bubbleScaleRef = useRef(bubbleScale)
  bubbleScaleRef.current = bubbleScale
  const extentInteractionRef = useRef<ExtentInteraction | null>(null)
  const boundsDrawingRef = useRef(boundsDrawing)
  const hasGeoBoundsRef = useRef(Boolean(geoBounds))
  const pendingBoundsExtentRef = useRef<Extent | undefined>(undefined)
  const syncingBoundsRef = useRef(false)
  const sourceRef = useRef(new VectorSource())
  const querySourceRef = useRef(new VectorSource())
  const renderJobRef = useRef(0)

  useEffect(() => {
    if (!targetRef.current || mapRef.current) return

    const target = targetRef.current
    const pointLayer = new VectorLayer({
      source: sourceRef.current,
      style: (feature) => mapPointStyle(feature, bubbleScaleRef.current),
    })
    const queryLayer = new VectorLayer({
      source: querySourceRef.current,
      style: queryStyle,
    })
    const extentInteraction = new ExtentInteraction({
      drag: false,
      boxStyle: boundsStyle,
      createCondition: () => !hasGeoBoundsRef.current,
      pointerStyle: hiddenBoundsHandleStyle,
      pixelTolerance: 10,
    })
    extentInteraction.setActive(boundsDrawingRef.current)

    const map = new Map({
      target,
      layers: [
        new TileLayer({
          source: new OSM(),
        }),
        pointLayer,
        queryLayer,
      ],
      view: new View({
        center: fromLonLat([8.5417, 47.3769]),
        zoom: 4,
      }),
    })
    map.addInteraction(extentInteraction)

    const reportVisibleBounds = () => {
      const viewport = visibleViewportFromMap(map)
      if (viewport) onVisibleViewportChange(viewport)
    }

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
      setExtentDragEnabled(extentInteraction, true)
      pendingBoundsExtentRef.current = extent
    })
    document.addEventListener('pointerup', commitPendingBounds)
    document.addEventListener('pointercancel', commitPendingBounds)
    map.on('moveend', reportVisibleBounds)

    map.on('singleclick', (event) => {
      if (boundsDrawingRef.current) return

      const clickedPoint = map.forEachFeatureAtPixel(
        event.pixel,
        (feature, layer) => (layer === pointLayer ? feature : undefined),
      )
      const clickedCount = clickedPoint ? featureBubbleCount(clickedPoint) : 1
      const clickedBounds = clickedPoint
        ? pointBoundsFromFeature(clickedPoint)
        : undefined
      if (clickedCount > 1 && clickedBounds) {
        onGeoBoundsChange(clickedBounds)
        return
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

      const hoveredPoint = map.forEachFeatureAtPixel(
        event.pixel,
        (feature, layer) => (layer === pointLayer ? feature : undefined),
      )
      const hoveredCount = hoveredPoint ? featureBubbleCount(hoveredPoint) : 1
      const hoveredBounds = hoveredPoint
        ? pointBoundsFromFeature(hoveredPoint)
        : undefined
      setMapCursor(
        target,
        map,
        hoveredCount > 1 && hoveredBounds ? 'pointer' : '',
      )
    })

    mapRef.current = map
    extentInteractionRef.current = extentInteraction
    const resizeObserver = new ResizeObserver(() => {
      map.updateSize()
      reportVisibleBounds()
    })
    resizeObserver.observe(target)
    const initialBoundsTimer = window.setTimeout(reportVisibleBounds, 0)

    return () => {
      window.clearTimeout(initialBoundsTimer)
      document.removeEventListener('pointerup', commitPendingBounds)
      document.removeEventListener('pointercancel', commitPendingBounds)
      map.un('moveend', reportVisibleBounds)
      resizeObserver.disconnect()
      map.removeInteraction(extentInteraction)
      map.setTarget(undefined)
      mapRef.current = null
      extentInteractionRef.current = null
    }
  }, [onGeoBoundsChange, onQueryPointChange, onVisibleViewportChange])

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
    const jobId = ++renderJobRef.current
    const batchSize = Math.max(1, Math.trunc(renderBatchSize))
    let itemIndex = 0
    let timer: number | undefined

    source.clear(true)

    function addNextBatch() {
      if (jobId !== renderJobRef.current) return

      const features: Feature[] = []
      const end = Math.min(itemIndex + batchSize, geoItems.length)
      for (; itemIndex < end; itemIndex += 1) {
        const item = geoItems[itemIndex]
        if (typeof item.lat !== 'number' || typeof item.lon !== 'number') {
          continue
        }
        const feature = pointFeature(item.lon, item.lat)
        feature.set('mediaId', item.mediaId ?? item.assetId, true)
        if (item.cellId) feature.set('cellId', item.cellId, true)
        feature.set('count', item.count ?? 1, true)
        if (item.bounds) feature.set('bounds', item.bounds, true)
        features.push(feature)
      }

      if (features.length > 0) source.addFeatures(features)
      if (itemIndex < geoItems.length) {
        timer = window.setTimeout(addNextBatch, 0)
      }
    }

    timer = window.setTimeout(addNextBatch, 0)

    return () => {
      if (renderJobRef.current === jobId) renderJobRef.current += 1
      if (timer !== undefined) window.clearTimeout(timer)
    }
  }, [geoItems, renderBatchSize])

  useEffect(() => {
    const querySource = querySourceRef.current
    querySource.clear(true)

    if (queryPoint) {
      const feature = pointFeature(queryPoint.lon, queryPoint.lat)
      querySource.addFeature(feature)
    }
  }, [queryPoint])

  useEffect(() => {
    hasGeoBoundsRef.current = Boolean(geoBounds)
    const extentInteraction = extentInteractionRef.current
    if (!extentInteraction) return

    syncingBoundsRef.current = true
    if (geoBounds) {
      extentInteraction.setExtent(mapExtentFromBounds(geoBounds))
      setExtentDragEnabled(extentInteraction, true)
    } else {
      setExtentDragEnabled(extentInteraction, false)
      clearExtentInteraction(extentInteraction)
    }
    syncingBoundsRef.current = false
  }, [geoBounds])

  return <div ref={targetRef} className="map-view" aria-label={label} />
}
