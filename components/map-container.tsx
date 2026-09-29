'use client';

import React, { useEffect, useRef, useState } from 'react';
import * as mapboxgl from 'mapbox-gl/esm';
import 'mapbox-gl/dist/mapbox-gl.css';

type RouteGeometry = {
  type: 'LineString';
  coordinates: [number, number][];
};

type BusRoute = {
  id: string;
  name: string;
  properties: Record<string, unknown>;
  geometry: RouteGeometry;
};

type RouteCollection = {
  count: number;
  routes: BusRoute[];
};

type Coordinate = {
  lat: number;
  lng: number;
};

type BusMatch = {
  routeId?: string;
  route: string;
  walkToBoardKm: number;
  walkFromDropKm: number;
  rideDistanceKm: number;
  geometry: RouteGeometry;
  boardPoint?: [number, number];
  dropPoint?: [number, number];
};

const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:3001';
const ROUTE_COLORS = ['#e63946', '#2563eb', '#16a34a', '#9333ea', '#ea580c', '#0891b2'];

const emptyFeatureCollection = {
  type: 'FeatureCollection' as const,
  features: [],
};

const MapContainer = () => {
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const startMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const destinationMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const [availableRoutes, setAvailableRoutes] = useState<BusRoute[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [displayedRoutes, setDisplayedRoutes] = useState<BusRoute[]>([]);
  const [mapReady, setMapReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [startLat, setStartLat] = useState('');
  const [startLng, setStartLng] = useState('');
  const [destination, setDestination] = useState<Coordinate | null>(null);
  const [locationStatus, setLocationStatus] = useState('');
  const [searchLoading, setSearchLoading] = useState(false);
  const [matches, setMatches] = useState<BusMatch[]>([]);

  useEffect(() => {
    let cancelled = false;

    fetch(`${API_BASE_URL}/api/routes`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Route list failed (${response.status})`);
        return (await response.json()) as RouteCollection;
      })
      .then((data) => {
        if (cancelled) return;
        setAvailableRoutes(data.routes);
        setSelectedIds(data.routes.map((route) => route.id));
        setLoading(false);
      })
      .catch((fetchError: Error) => {
        if (cancelled) return;
        setError(fetchError.message);
        setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    mapboxgl.setAccessToken('pk.eyJ1IjoiY29kZXJhcmsiLCJhIjoiY211bWs1Y3YwMDBweTJ3czl2cjFpd3g1aSJ9.630xcDNl9Xk1-bYLqTfQFA');

    if (!mapContainerRef.current) return;

    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: 'mapbox://styles/mapbox/streets-v12',
      center: [67.05, 24.86],
      zoom: 12,
    });

    mapRef.current = map;
    map.on('load', () => {
      setMapReady(true);
      map.on('click', (event) => {
        setDestination({ lat: event.lngLat.lat, lng: event.lngLat.lng });
        setLocationStatus('Destination pin placed.');
      });
    });

    return () => {
      setMapReady(false);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!mapReady || !mapRef.current || selectedIds.length === 0) {
      setDisplayedRoutes([]);
      if (mapRef.current?.getSource('bus-routes')) {
        (mapRef.current.getSource('bus-routes') as mapboxgl.GeoJSONSource).setData(emptyFeatureCollection);
      }
      return;
    }

    let cancelled = false;
    const ids = encodeURIComponent(selectedIds.join(','));

    fetch(`${API_BASE_URL}/api/routes/compare?ids=${ids}`)
      .then(async (response) => {
        if (!response.ok) throw new Error(`Route comparison failed (${response.status})`);
        return (await response.json()) as RouteCollection;
      })
      .then((data) => {
        if (cancelled || !mapRef.current) return;

        setDisplayedRoutes(data.routes);

        const featureCollection = {
          type: 'FeatureCollection' as const,
          features: data.routes.map((route) => ({
            type: 'Feature' as const,
            properties: { id: route.id, name: route.name },
            geometry: route.geometry,
          })),
        };

        const source = mapRef.current.getSource('bus-routes') as mapboxgl.GeoJSONSource | undefined;
        if (source) {
          source.setData(featureCollection);
        } else {
          mapRef.current.addSource('bus-routes', { type: 'geojson', data: featureCollection });

          const colorExpression: unknown[] = ['match', ['get', 'id']];
          data.routes.forEach((route, index) => {
            colorExpression.push(route.id, ROUTE_COLORS[index % ROUTE_COLORS.length]);
          });
          colorExpression.push('#334155');

          mapRef.current.addLayer({
            id: 'bus-routes-line',
            type: 'line',
            source: 'bus-routes',
            layout: { 'line-join': 'round', 'line-cap': 'round' },
            paint: {
              'line-color': colorExpression as never,
              'line-width': 5,
              'line-opacity': 0.88,
            },
          });

          mapRef.current.on('click', 'bus-routes-line', (event) => {
            const feature = event.features?.[0];
            const properties = (feature as { properties?: { name?: string } } | undefined)?.properties;
            const name = properties?.name ?? 'Bus route';
            new mapboxgl.Popup().setLngLat(event.lngLat).setHTML(`<strong>${name}</strong>`).addTo(mapRef.current!);
          });

          mapRef.current.on('mouseenter', 'bus-routes-line', () => {
            mapRef.current!.getCanvas().style.cursor = 'pointer';
          });
          mapRef.current.on('mouseleave', 'bus-routes-line', () => {
            mapRef.current!.getCanvas().style.cursor = '';
          });
        }

        if (data.routes.length > 0) {
          const bounds = new mapboxgl.LngLatBounds();
          data.routes.forEach((route) => route.geometry.coordinates.forEach((coordinate) => bounds.extend(coordinate)));
          mapRef.current.fitBounds(bounds, { padding: 80, maxZoom: 14, duration: 600 });
        }
      })
      .catch((fetchError: Error) => {
        if (!cancelled) setError(fetchError.message);
      });

    return () => {
      cancelled = true;
    };
  }, [mapReady, selectedIds]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    const map = mapRef.current;
    const sourceData = {
      type: 'FeatureCollection' as const,
      features: matches.map((match, index) => ({
        type: 'Feature' as const,
        properties: { id: match.routeId ?? match.route, name: match.route, rank: index },
        geometry: match.geometry,
      })),
    };

    const source = map.getSource('recommended-routes') as mapboxgl.GeoJSONSource | undefined;
    if (source) {
      source.setData(sourceData);
      return;
    }

    map.addSource('recommended-routes', { type: 'geojson', data: sourceData });
    map.addLayer({
      id: 'recommended-routes-line',
      type: 'line',
      source: 'recommended-routes',
      layout: { 'line-join': 'round', 'line-cap': 'round' },
      paint: {
        'line-color': ['case', ['==', ['get', 'rank'], 0], '#16a34a', '#f59e0b'] as never,
        'line-width': ['case', ['==', ['get', 'rank'], 0], 8, 6] as never,
        'line-opacity': 0.95,
      },
    });
  }, [mapReady, matches]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    const map = mapRef.current;
    destinationMarkerRef.current?.remove();
    destinationMarkerRef.current = null;

    if (destination) {
      destinationMarkerRef.current = new mapboxgl.Marker({ color: '#111827' })
        .setLngLat([destination.lng, destination.lat])
        .addTo(map);
    }
  }, [destination, mapReady]);

  useEffect(() => {
    if (!mapReady || !mapRef.current) return;

    startMarkerRef.current?.remove();
    startMarkerRef.current = null;

    const lat = Number(startLat);
    const lng = Number(startLng);
    if (Number.isFinite(lat) && Number.isFinite(lng)) {
      startMarkerRef.current = new mapboxgl.Marker({ color: '#2563eb' })
        .setLngLat([lng, lat])
        .addTo(mapRef.current);
    }
  }, [startLat, startLng, mapReady]);

  const toggleRoute = (id: string) => {
    setSelectedIds((current) => current.includes(id) ? current.filter((routeId) => routeId !== id) : [...current, id]);
  };

  const useCurrentLocation = () => {
    if (!navigator.geolocation) {
      setError('This browser does not support location access.');
      return;
    }

    setLocationStatus('Requesting your current location…');
    navigator.geolocation.getCurrentPosition(
      (position) => {
        const { latitude, longitude } = position.coords;
        setStartLat(latitude.toFixed(6));
        setStartLng(longitude.toFixed(6));
        setLocationStatus('Current location loaded.');
        mapRef.current?.flyTo({ center: [longitude, latitude], zoom: 14 });
      },
      (locationError) => {
        setLocationStatus('Location permission was not granted.');
        setError(locationError.message);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 30000 }
    );
  };

  const findSuitableRoutes = async () => {
    const lat = Number(startLat);
    const lng = Number(startLng);

    if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
      setError('Enter a valid starting latitude and longitude, or use your current location.');
      return;
    }

    if (!destination) {
      setError('Click the map to place your destination pin first.');
      return;
    }

    setError(null);
    setSearchLoading(true);

    try {
      const params = new URLSearchParams({
        lat: String(lat),
        lng: String(lng),
        destLat: String(destination.lat),
        destLng: String(destination.lng),
      });
      const response = await fetch(`${API_BASE_URL}/find-bus?${params}`);
      if (!response.ok) throw new Error(`Route search failed (${response.status})`);

      const data = (await response.json()) as { count: number; matches: BusMatch[] };
      setMatches(data.matches);
      setSelectedIds(data.matches.map((match) => match.routeId ?? match.route));

      if (data.matches.length === 0) {
        setLocationStatus('No route is within the current matching threshold.');
      } else {
        setLocationStatus(`Best route: ${data.matches[0].route}`);
      }
    } catch (searchError) {
      setError(searchError instanceof Error ? searchError.message : 'Route search failed.');
    } finally {
      setSearchLoading(false);
    }
  };

  return (
    <div className="relative h-screen w-screen overflow-hidden">
      <div id="map-container" className="h-full w-full" ref={mapContainerRef} />
      <aside className="absolute left-4 top-4 z-10 w-80 rounded-2xl bg-white/95 p-4 shadow-xl backdrop-blur">
        <div className="mb-4">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">Bus finder</p>
          <h1 className="text-xl font-semibold text-slate-950">Compare routes</h1>
          <p className="mt-1 text-sm text-slate-600">Select routes to draw their stored GeoJSON paths.</p>
        </div>
        {loading && <p className="text-sm text-slate-500">Loading routes…</p>}
        {error && <p className="rounded-lg bg-red-50 p-2 text-sm text-red-700">{error}</p>}

        <div className="mb-5 border-b border-slate-200 pb-5">
          <p className="mb-2 text-sm font-semibold text-slate-900">Find a suitable bus</p>
          <div className="grid grid-cols-2 gap-2">
            <input value={startLat} onChange={(event) => setStartLat(event.target.value)} placeholder="Start lat" className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
            <input value={startLng} onChange={(event) => setStartLng(event.target.value)} placeholder="Start lng" className="rounded-lg border border-slate-300 px-2 py-2 text-sm" />
          </div>
          <button type="button" onClick={useCurrentLocation} className="mt-2 w-full rounded-lg border border-slate-300 px-3 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">
            Use current location
          </button>
          <p className="mt-2 text-xs text-slate-500">Click anywhere on the map to drop your destination pin.</p>
          {destination && <p className="mt-1 text-xs text-slate-600">Destination: {destination.lat.toFixed(5)}, {destination.lng.toFixed(5)}</p>}
          {locationStatus && <p className="mt-1 text-xs text-slate-600">{locationStatus}</p>}
          <button type="button" onClick={findSuitableRoutes} disabled={searchLoading} className="mt-3 w-full rounded-lg bg-slate-950 px-3 py-2 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60">
            {searchLoading ? 'Finding routes…' : 'Find suitable routes'}
          </button>
        </div>

        {matches.length > 0 && (
          <div className="mb-5 border-b border-slate-200 pb-5">
            <p className="mb-2 text-sm font-semibold text-slate-900">Recommended routes</p>
            <div className="space-y-2">
              {matches.map((match, index) => (
                <div key={`${match.route}-${index}`} className="rounded-lg bg-slate-50 p-2 text-xs text-slate-700">
                  <div className="flex items-center justify-between font-semibold">
                    <span>{index === 0 ? 'Best match · ' : ''}{match.route}</span>
                    <span>{match.walkToBoardKm} km walk</span>
                  </div>
                  <p className="mt-1">Destination walk: {match.walkFromDropKm} km · Ride: {match.rideDistanceKm} km</p>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="space-y-2">
          {availableRoutes.map((route, index) => (
            <label key={route.id} className="flex cursor-pointer items-center gap-3 rounded-lg border border-slate-200 p-3 hover:bg-slate-50">
              <input type="checkbox" checked={selectedIds.includes(route.id)} onChange={() => toggleRoute(route.id)} className="h-4 w-4" />
              <span className="h-3 w-3 rounded-full" style={{ backgroundColor: ROUTE_COLORS[index % ROUTE_COLORS.length] }} />
              <span className="text-sm font-medium text-slate-800">{route.name}</span>
            </label>
          ))}
        </div>
        <p className="mt-4 text-xs text-slate-500">Showing {displayedRoutes.length} of {availableRoutes.length} routes</p>
      </aside>
    </div>
  );
};

export default MapContainer
