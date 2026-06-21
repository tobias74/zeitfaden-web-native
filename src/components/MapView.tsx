import Feature from 'ol/Feature'
import Map from 'ol/Map'
import View from 'ol/View'
import { boundingExtent } from 'ol/extent'
import Point from 'ol/geom/Point'
import { fromExtent } from 'ol/geom/Polygon'
import DragBox from 'ol/interaction/DragBox'
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

const clusterStyleCache = new globalThis.Map<string, Style>()

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

function boundsFromMapExtent(extent: [number, number, number, number]): GeoBounds {
  const [leftLon, bottomLat] = toLonLat([extent[0], extent[1]])
  const [rightLon, topLat] = toLonLat([extent[2], extent[3]])

  return {
    minLat: boundedLatitude(Math.min(bottomLat, topLat)),
    maxLat: boundedLatitude(Math.max(bottomLat, topLat)),
    minLon: boundedLongitude(Math.min(leftLon, rightLon)),
    maxLon: boundedLongitude(Math.max(leftLon, rightLon)),
  }
}

function mapExtentFromBounds(bounds: GeoBounds): [number, number, number, number] {
  const [minX, minY] = fromLonLat([bounds.minLon, bounds.minLat])
  const [maxX, maxY] = fromLonLat([bounds.maxLon, bounds.maxLat])

  return [
    Math.min(minX, maxX),
    Math.min(minY, maxY),
    Math.max(minX, maxX),
    Math.max(minY, maxY),
  ]
}

export function MapView({
  queryPoint,
  geoItems,
  results,
  geoBounds,
  boundsDrawing,
  onQueryPointChange,
  onGeoBoundsChange,
}: MapViewProps) {
  const targetRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Map | null>(null)
  const dragBoxRef = useRef<DragBox | null>(null)
  const boundsDrawingRef = useRef(boundsDrawing)
  const sourceRef = useRef(new VectorSource())
  const querySourceRef = useRef(new VectorSource())
  const boundsSourceRef = useRef(new VectorSource())

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
    const boundsLayer = new VectorLayer({
      source: boundsSourceRef.current,
      style: boundsStyle,
    })
    const dragBox = new DragBox({
      className: 'map-draw-box',
      minArea: 64,
    })
    dragBox.setActive(boundsDrawingRef.current)

    const map = new Map({
      target,
      layers: [
        new TileLayer({
          source: new OSM(),
        }),
        boundsLayer,
        clusterLayer,
        queryLayer,
      ],
      view: new View({
        center: fromLonLat([8.5417, 47.3769]),
        zoom: 4,
      }),
    })
    map.addInteraction(dragBox)

    dragBox.on('boxend', () => {
      const extent = dragBox.getGeometry().getExtent() as [
        number,
        number,
        number,
        number,
      ]
      onGeoBoundsChange(boundsFromMapExtent(extent))
    })

    map.on('singleclick', (event) => {
      if (boundsDrawingRef.current) return

      const clickedCluster = map.forEachFeatureAtPixel(
        event.pixel,
        (feature, layer) => (layer === clusterLayer ? feature : undefined),
      )
      if (clickedCluster) {
        const coordinates = coordinatesForCluster(clickedCluster)
        if (coordinates.length > 1) {
          map.getView().fit(boundingExtent(coordinates), {
            duration: 180,
            maxZoom: 15,
            padding: [72, 72, 72, 72],
          })
          return
        }
      }

      const [lon, lat] = toLonLat(event.coordinate)
      onQueryPointChange({ lat, lon })
    })

    mapRef.current = map
    dragBoxRef.current = dragBox
    const resizeObserver = new ResizeObserver(() => map.updateSize())
    resizeObserver.observe(target)

    return () => {
      resizeObserver.disconnect()
      map.removeInteraction(dragBox)
      map.setTarget(undefined)
      mapRef.current = null
      dragBoxRef.current = null
    }
  }, [onGeoBoundsChange, onQueryPointChange])

  useEffect(() => {
    boundsDrawingRef.current = boundsDrawing
    dragBoxRef.current?.setActive(boundsDrawing)
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
    const boundsSource = boundsSourceRef.current
    boundsSource.clear()
    if (!geoBounds) return

    boundsSource.addFeature(
      new Feature({
        geometry: fromExtent(mapExtentFromBounds(geoBounds)),
      }),
    )
  }, [geoBounds])

  return <div ref={targetRef} className="map-view" aria-label="Search map" />
}
