import Feature from 'ol/Feature'
import Map from 'ol/Map'
import View from 'ol/View'
import Point from 'ol/geom/Point'
import VectorLayer from 'ol/layer/Vector'
import { fromLonLat, toLonLat } from 'ol/proj'
import VectorSource from 'ol/source/Vector'
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style'
import { useEffect, useRef } from 'react'
import type { EnrichedSearchResult, MediaItem } from '../types'

type QueryPoint = {
  lat: number
  lon: number
}

type MapViewProps = {
  queryPoint?: QueryPoint
  geoItems: MediaItem[]
  results: EnrichedSearchResult[]
  onQueryPointChange: (point: QueryPoint) => void
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

export function MapView({
  queryPoint,
  geoItems,
  results,
  onQueryPointChange,
}: MapViewProps) {
  const targetRef = useRef<HTMLDivElement | null>(null)
  const mapRef = useRef<Map | null>(null)
  const sourceRef = useRef(new VectorSource())

  useEffect(() => {
    if (!targetRef.current || mapRef.current) return

    const target = targetRef.current
    const vectorLayer = new VectorLayer({
      source: sourceRef.current,
    })

    const map = new Map({
      target,
      layers: [vectorLayer],
      view: new View({
        center: fromLonLat([8.5417, 47.3769]),
        zoom: 4,
      }),
    })

    map.on('singleclick', (event) => {
      const [lon, lat] = toLonLat(event.coordinate)
      onQueryPointChange({ lat, lon })
    })

    mapRef.current = map
    const resizeObserver = new ResizeObserver(() => map.updateSize())
    resizeObserver.observe(target)

    return () => {
      resizeObserver.disconnect()
      map.setTarget(undefined)
      mapRef.current = null
    }
  }, [onQueryPointChange])

  useEffect(() => {
    const source = sourceRef.current
    source.clear()

    const resultIds = new Set(results.map((result) => result.mediaId))

    for (const item of geoItems) {
      if (typeof item.latitude !== 'number' || typeof item.longitude !== 'number') {
        continue
      }
      const feature = new Feature({
        geometry: new Point(fromLonLat([item.longitude, item.latitude])),
      })
      feature.setStyle(resultIds.has(item.id) ? resultStyle : baseStyle)
      source.addFeature(feature)
    }

    if (queryPoint) {
      const feature = new Feature({
        geometry: new Point(fromLonLat([queryPoint.lon, queryPoint.lat])),
      })
      feature.setStyle(queryStyle)
      source.addFeature(feature)
    }
  }, [geoItems, queryPoint, results])

  return <div ref={targetRef} className="map-view" aria-label="Search map" />
}
