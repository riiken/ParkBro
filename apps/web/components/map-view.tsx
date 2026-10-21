'use client';

import 'maplibre-gl/dist/maplibre-gl.css';
import { useEffect, useRef, useState } from 'react';

/**
 * Map (D-174): MapLibre with OpenStreetMap tiles from OpenFreeMap. No key, no tracking. Three uses:
 * - `points`: search results as price pins (public, ~110 m-rounded points; links to the listing);
 * - `area`: a listing's approximate area as a circle (exact spot only after booking);
 * - `picker`: a draggable pin for hosts placing their property (the exact pin stays with us, encrypted).
 * Loaded lazily; if WebGL or the network is unavailable the map quietly disappears and the page still works.
 */
export interface MapPoint {
  id: string;
  latitude: number;
  longitude: number;
  label: string;
  href?: string;
}

interface Props {
  center: { latitude: number; longitude: number };
  zoom?: number;
  points?: MapPoint[];
  area?: { radiusM: number };
  picker?: { onChange: (point: { latitude: number; longitude: number }) => void };
  label: string;
  className?: string;
}

const STYLE_LIGHT = 'https://tiles.openfreemap.org/styles/liberty';
const STYLE_DARK = 'https://tiles.openfreemap.org/styles/dark';
const WORKER_URL = '/vendor/maplibre/maplibre-gl-worker.mjs';

/** A circle polygon (GeoJSON) around a point; good enough for the small radii we show. */
function circle(lat: number, lng: number, radiusM: number, steps = 64) {
  const coords: [number, number][] = [];
  const dLat = radiusM / 111_320;
  const dLng = radiusM / (111_320 * Math.cos((lat * Math.PI) / 180));
  for (let i = 0; i <= steps; i += 1) {
    const t = (i / steps) * 2 * Math.PI;
    coords.push([lng + dLng * Math.cos(t), lat + dLat * Math.sin(t)]);
  }
  return {
    type: 'Feature' as const,
    properties: {},
    geometry: { type: 'Polygon' as const, coordinates: [coords] },
  };
}

export function MapView({ center, zoom = 14, points, area, picker, label, className }: Props) {
  const container = useRef<HTMLDivElement>(null);
  const onChange = useRef(picker?.onChange);
  onChange.current = picker?.onChange;
  const [failed, setFailed] = useState(false);
  const pointsKey = JSON.stringify(points ?? []);

  useEffect(() => {
    let disposed = false;
    let cleanup = () => {};
    (async () => {
      try {
        const maplibre = await import('maplibre-gl');
        if (disposed || !container.current) return;
        maplibre.setWorkerUrl(WORKER_URL);
        const dark = window.matchMedia?.('(prefers-color-scheme: dark)').matches;
        const map = new maplibre.Map({
          container: container.current,
          style: dark ? STYLE_DARK : STYLE_LIGHT,
          center: [center.longitude, center.latitude],
          zoom,
          attributionControl: { compact: true },
          cooperativeGestures: !picker, // one-finger scroll moves the page, not the map (phones)
        });
        map.addControl(new maplibre.NavigationControl({ showCompass: false }), 'top-right');
        map.on('error', () => undefined); // tile hiccups shouldn't surface; the map retries on its own
        cleanup = () => map.remove();

        for (const p of points ?? []) {
          const el = document.createElement(p.href ? 'a' : 'span');
          el.className = 'map-pin';
          el.textContent = p.label;
          if (p.href && el instanceof HTMLAnchorElement) el.href = p.href;
          new maplibre.Marker({ element: el, anchor: 'bottom' })
            .setLngLat([p.longitude, p.latitude])
            .addTo(map);
        }
        if (points && points.length > 1) {
          const bounds = new maplibre.LngLatBounds();
          points.forEach((p) => bounds.extend([p.longitude, p.latitude]));
          bounds.extend([center.longitude, center.latitude]);
          map.fitBounds(bounds, { padding: 56, maxZoom: 15, duration: 0 });
        }

        if (area) {
          map.on('load', () => {
            map.addSource('area', {
              type: 'geojson',
              data: circle(center.latitude, center.longitude, area.radiusM),
            });
            map.addLayer({
              id: 'area-fill',
              type: 'fill',
              source: 'area',
              paint: { 'fill-color': '#4f46e5', 'fill-opacity': 0.14 },
            });
            map.addLayer({
              id: 'area-line',
              type: 'line',
              source: 'area',
              paint: { 'line-color': '#4f46e5', 'line-width': 2 },
            });
          });
        } else if (!picker && !points?.length) {
          new maplibre.Marker({ color: '#4f46e5' }).setLngLat([center.longitude, center.latitude]).addTo(map);
        }

        if (picker) {
          const pin = new maplibre.Marker({ color: '#4f46e5', draggable: true })
            .setLngLat([center.longitude, center.latitude])
            .addTo(map);
          const report = () => {
            const { lat, lng } = pin.getLngLat();
            onChange.current?.({ latitude: lat, longitude: lng });
          };
          pin.on('dragend', report);
          map.on('click', (e) => {
            pin.setLngLat(e.lngLat);
            report();
          });
        }
      } catch {
        if (!disposed) setFailed(true);
      }
    })();
    return () => {
      disposed = true;
      cleanup();
    };
    // Re-create when what we show changes; the picker keeps its own pin while the host drags.
  }, [center.latitude, center.longitude, zoom, pointsKey, area?.radiusM, Boolean(picker)]);

  if (failed) return null;
  return <div ref={container} className={`map ${className ?? ''}`} role="region" aria-label={label} />;
}
