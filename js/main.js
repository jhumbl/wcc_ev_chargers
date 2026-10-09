import * as maplibregl from 'maplibre-gl';
import { BASEMAP_STYLE, DATA, SPEEDS } from './config.js';
import { esc, bboxOf, flatten, distance, track } from './util.js';
import { initPanel } from './panel.js';
import { initSearch } from './search.js';
import { initReach } from './reach.js';

const SPEED_BY_ID = Object.fromEntries(SPEEDS.map((s) => [s.id, s]));
let homeBounds = [[-0.2165, 51.4840], [-0.1110, 51.5400]];  // replaced by the boundary's extent once loaded
let homePoints = [];
const mobile = window.matchMedia('(max-width: 720px)');

// Shop-style filters: an empty set means "everything", picking values narrows to just those
const FACETS = {
  speed: (p) => p.speed_class,
  status: (p) => p.status,
  operator: (p) => p.operator,
  bay: (p) => (p.dedicated ? 'dedicated' : 'shared'),
};

const state = {
  ward: null,                               // ward Feature, or null for all of Westminster
  filters: Object.fromEntries(Object.keys(FACETS).map((k) => [k, new Set()])),
};

let map;
let chargers;
let wards;
let panel;
let reach;
let popup;
let placeMarker;
let hoveredId = null;

// Data + map

const loadJSON = (url) => fetch(url).then((r) => {
  if (!r.ok) throw new Error(`${url} (${r.status})`);
  return r.json();
});

function fatal(message) {
  document.getElementById('map').innerHTML = `<p class="fatal">${esc(message)}</p>`;
}

// Leaves room for the panel when fitting the map to an area
function padding() {
  const panelEl = document.getElementById('panel');
  if (mobile.matches) return { top: 72, right: 24, left: 24, bottom: panelEl.offsetHeight + 24 };
  return { top: 40, right: 40, bottom: 40, left: panelEl.offsetWidth + 56 };
}

const basePadding = () => (mobile.matches ? { top: 72, right: 24, bottom: 24, left: 24 } : { top: 40, right: 40, bottom: 40, left: 40 });

// Web Mercator world pixels (MapLibre uses 512px tiles)
function worldPx([lon, lat], zoom) {
  const scale = 512 * 2 ** zoom;
  const s = Math.sin((lat * Math.PI) / 180);
  return [((lon + 180) / 360) * scale, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * scale];
}

// Only make room for the panel if fitting to the whole map would put part of the area underneath it
function paddingFor(points, maxZoom = map.getMaxZoom()) {
  const base = basePadding();
  const camera = map.cameraForBounds(bboxOf(points), { padding: base, maxZoom });
  if (!camera) return padding();
  const zoom = Math.min(camera.zoom, maxZoom);
  const [cx, cy] = worldPx(maplibregl.LngLat.convert(camera.center).toArray(), zoom);
  const box = map.getContainer().getBoundingClientRect();
  const panel = document.getElementById('panel').getBoundingClientRect();
  const margin = 12;
  const covered = points.some((point) => {
    const [x, y] = worldPx(point, zoom);
    const sx = x - cx + box.width / 2 + box.left;
    const sy = y - cy + box.height / 2 + box.top;
    return sx > panel.left - margin && sx < panel.right + margin && sy > panel.top - margin && sy < panel.bottom + margin;
  });
  return covered ? padding() : base;
}

function fitTo(points, { maxZoom = map.getMaxZoom(), animate = true } = {}) {
  map.fitBounds(bboxOf(points), { padding: paddingFor(points, maxZoom), maxZoom, animate });
}

async function start() {
  try {
    map = new maplibregl.Map({
      container: 'map',
      style: BASEMAP_STYLE,
      bounds: homeBounds,
      fitBoundsOptions: { padding: padding() },
      minZoom: 10,
      maxZoom: 19,
      maxBounds: [[-0.55, 51.30], [0.30, 51.70]],
      attributionControl: { compact: true },
      dragRotate: false,
      pitchWithRotate: false,
      touchPitch: false,
    });
  } catch (err) {
    console.error(err);
    fatal('Sorry, your browser can’t display this map. Try an up-to-date version of Chrome, Edge, Firefox or Safari.');
    return;
  }
  map.touchZoomRotate.disableRotation();
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
  map.addControl(new maplibregl.GeolocateControl({ positionOptions: { enableHighAccuracy: true } }), 'bottom-right');
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-left');

  const mapLoaded = new Promise((resolve) => map.on('load', resolve));

  let boundary;
  try {
    [chargers, wards, boundary] = await Promise.all([DATA.chargers, DATA.wards, DATA.boundary].map(loadJSON));
  } catch (err) {
    console.error(err);
    fatal('Sorry, the charge point data couldn’t be loaded. Please try again later.');
    return;
  }

  const operators = [...new Set(chargers.features.map((f) => f.properties.operator))]
    .sort((a, b) => (a === 'To be confirmed') - (b === 'To be confirmed') || a.localeCompare(b));
  panel = initPanel({
    speeds: SPEEDS,
    operators,
    wards: wards.features.map((f) => f.properties),
    updated: chargers.updated,
    onFilter: (facet, values) => { state.filters[facet] = values; applyFilters(); },
    onWard: (slug) => setWard(slug),
    onNearbyPick: (id) => focusCharger(id),
    onNearbyClose: () => clearPlace(),
    onReachFrom: (lngLat) => reach?.runFrom(lngLat),
    collapsed: mobile.matches,
  });

  initSearch({
    chargers,
    onStreet: (name, features) => {
      clearPlace();
      setWard(null, { fit: false });
      fitTo(features.map((f) => f.geometry.coordinates), { maxZoom: 17 });
      track('search/street');
    },
    onPlace: (place) => {
      setWard(null, { fit: false });
      showPlace(place);
      track('search/place');
    },
  });

  homePoints = boundary.features.flatMap((f) => flatten(f.geometry.coordinates));
  homeBounds = bboxOf(homePoints);
  applyFilters();  // fill in the counts now; the map may still be loading (or paused in a background tab)

  await mapLoaded;
  addLayers(boundary);

  reach = initReach({
    map,
    beforeId: 'chargers',
    visibleChargers: () => chargers.features.filter((f) => matches(f.properties)),
    fitTo,
  });
  panel.setReachAvailable(reach.available);

  bindMapEvents();
  fitTo(homePoints, { animate: false });
  setWard(wardFromHash(), { animate: false });
  applyFilters();
  window.addEventListener('hashchange', () => setWard(wardFromHash()));
}

function addLayers(boundary) {
  // Draw our polygons under the basemap labels, chargers on top of everything
  // (Positron puts a waterway label early on, so use the first label after the last road/fill layer)
  const layers = map.getStyle().layers;
  const lastShape = layers.findLastIndex((l) => l.type !== 'symbol');
  const firstLabel = layers.slice(lastShape + 1).find((l) => l.type === 'symbol')?.id;
  const empty = { type: 'FeatureCollection', features: [] };

  map.addSource('wards', { type: 'geojson', data: wards });
  map.addSource('boundary', { type: 'geojson', data: boundary });
  map.addSource('mask', { type: 'geojson', data: empty });
  map.addSource('ward-focus', { type: 'geojson', data: empty });
  map.addSource('chargers', { type: 'geojson', data: chargers });

  map.addLayer({
    id: 'mask', type: 'fill', source: 'mask',
    paint: { 'fill-color': '#f4f4f2', 'fill-opacity': 0.72 },
  }, firstLabel);
  map.addLayer({
    id: 'wards-line', type: 'line', source: 'wards',
    paint: {
      'line-color': '#8a939c',
      'line-width': 0.8,
      'line-dasharray': [3, 2],
      'line-opacity': ['interpolate', ['linear'], ['zoom'], 11, 0.25, 14, 0.6],
    },
  }, firstLabel);
  // Borders go above the basemap labels so place names never cut through them
  map.addLayer({
    id: 'boundary-line', type: 'line', source: 'boundary',
    paint: { 'line-color': '#3b4550', 'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 16, 2] },
  });
  map.addLayer({
    id: 'ward-focus-line', type: 'line', source: 'ward-focus',
    paint: { 'line-color': '#1d2329', 'line-width': ['interpolate', ['linear'], ['zoom'], 12, 1.5, 16, 3] },
  });

  const speedColor = ['match', ['get', 'speed_class'], ...SPEEDS.flatMap((s) => [s.id, s.color]), '#888888'];
  const bySpeed = (lccp, fast, rapid) => ['match', ['get', 'speed_class'], 'rapid', rapid, 'fast', fast, lccp];
  const planned = ['==', ['get', 'status'], 'planned'];
  const hovered = ['boolean', ['feature-state', 'hover'], false];

  map.addLayer({
    id: 'chargers', type: 'circle', source: 'chargers',
    layout: { 'circle-sort-key': bySpeed(1, 2, 3) },
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        11, bySpeed(1.5, 2.2, 2.6),
        14, bySpeed(3.2, 4.5, 5.5),
        17, bySpeed(6.5, 9, 11),
        19, bySpeed(10, 13, 16)],
      'circle-color': ['case', planned, '#ffffff', speedColor],
      'circle-stroke-color': ['case', hovered, '#111111', planned, speedColor, '#ffffff'],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'],
        11, ['case', hovered, 2, planned, 1, 0.25],
        15, ['case', hovered, 2.5, planned, 2, 0.75]],
      'circle-opacity': 1,
      'circle-stroke-opacity': 1,
    },
  });
}

// Filters + stats

function matches(p, skip = null) {
  return Object.entries(state.filters).every(([facet, values]) => facet === skip || !values.size || values.has(FACETS[facet](p)));
}

function filterExpression() {
  const get = {
    speed: ['get', 'speed_class'],
    status: ['get', 'status'],
    operator: ['get', 'operator'],
    bay: ['case', ['get', 'dedicated'], 'dedicated', 'shared'],
  };
  const f = Object.entries(state.filters)
    .filter(([, values]) => values.size)
    .map(([facet, values]) => ['in', get[facet], ['literal', [...values]]]);
  return f.length ? ['all', ...f] : null;
}

function applyFilters() {
  if (map.getLayer('chargers')) map.setFilter('chargers', filterExpression());

  // Each option's count is what you'd see if you picked it, given the other filters
  const wardName = state.ward?.properties.ward;
  const counts = Object.fromEntries(Object.keys(FACETS).map((k) => [k, {}]));
  const totals = { installed: 0, planned: 0 };
  for (const { properties: p } of chargers.features) {
    if (wardName && p.ward !== wardName) continue;
    for (const facet of Object.keys(FACETS)) {
      if (!matches(p, facet)) continue;
      const value = FACETS[facet](p);
      counts[facet][value] = (counts[facet][value] ?? 0) + p.bays;
    }
    if (matches(p)) totals[p.status] += p.bays;
  }
  panel.renderStats({ counts, totals, wardName, filtered: Object.values(state.filters).some((v) => v.size) });
  reach?.refresh();
}

// Wards

const wardFromHash = () => new URLSearchParams(location.hash.slice(1)).get('ward');

function setWard(slug, { animate = true, fit = true } = {}) {
  const ward = wards.features.find((f) => f.properties.slug === slug) ?? null;
  if (ward === state.ward) return;
  state.ward = ward;
  panel.setWard(ward?.properties.slug ?? '');

  const hash = ward ? `#ward=${ward.properties.slug}` : '';
  if (location.hash !== hash) history.replaceState(null, '', hash || location.pathname + location.search);

  const empty = { type: 'FeatureCollection', features: [] };
  map.getSource('ward-focus').setData(ward ? { type: 'FeatureCollection', features: [ward] } : empty);
  map.getSource('mask').setData(ward ? maskFor(ward.geometry) : empty);

  const opacity = ward ? ['case', ['==', ['get', 'ward'], ward.properties.ward], 1, 0.3] : 1;
  map.setPaintProperty('chargers', 'circle-opacity', opacity);
  map.setPaintProperty('chargers', 'circle-stroke-opacity', opacity);

  if (fit) fitTo(ward ? flatten(ward.geometry.coordinates) : homePoints, { animate });
  if (ward) track(`ward/${ward.properties.slug}`);
  applyFilters();
}

// A world-sized polygon with the ward cut out of it
function maskFor(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const world = [[-180, -85], [180, -85], [180, 85], [-180, 85], [-180, -85]];
  return {
    type: 'Feature',
    properties: {},
    geometry: { type: 'Polygon', coordinates: [world, ...polygons.map((p) => p[0])] },
  };
}

// Interaction

function chargerAt(point) {
  const r = mobile.matches ? 14 : 8;
  const hits = map.queryRenderedFeatures([[point.x - r, point.y - r], [point.x + r, point.y + r]], { layers: ['chargers'] });
  if (!hits.length) return null;
  const d = (f) => {
    const p = map.project(f.geometry.coordinates);
    return (p.x - point.x) ** 2 + (p.y - point.y) ** 2;
  };
  return hits.reduce((best, f) => (d(f) < d(best) ? f : best));
}

function bindMapEvents() {
  map.on('mousemove', (e) => {
    const f = reach.picking ? null : chargerAt(e.point);
    const id = f?.id ?? null;
    if (id === hoveredId) return;
    if (hoveredId !== null) map.setFeatureState({ source: 'chargers', id: hoveredId }, { hover: false });
    if (id !== null) map.setFeatureState({ source: 'chargers', id }, { hover: true });
    hoveredId = id;
    map.getCanvas().style.cursor = reach.picking ? 'crosshair' : f ? 'pointer' : '';
  });

  map.on('click', (e) => {
    if (reach.picking) {
      reach.runFrom(e.lngLat.toArray());
      return;
    }
    const f = chargerAt(e.point);
    if (f) openPopup(chargers.features.find((c) => c.id === f.id));
  });
}

function popupHtml(p) {
  const speed = SPEED_BY_ID[p.speed_class];
  const rows = [
    ['Operator', p.operator],
    ['Speed', p.speeds],
    ['Bays', p.bays],
    ['Bay type', p.bay_types],
    ['Lamp column', p.lamp_column],
    ['Ward', p.ward],
  ].filter(([, v]) => v !== null && v !== undefined && v !== '');
  return `
    <div class="pop">
      <div class="badges">
        <span class="badge" style="--c:${speed.color}">${esc(speed.label)}</span>
        ${p.status === 'planned' ? '<span class="badge badge-planned">Planned</span>' : ''}
      </div>
      <h2>${esc(p.site)}</h2>
      ${p.location ? `<p class="muted">${esc(p.location)}</p>` : ''}
      <dl>${rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>
      ${p.status === 'planned' ? '<p class="muted small">Subject to site survey.</p>' : ''}
    </div>`;
}

function openPopup(feature) {
  popup?.remove();
  popup = new maplibregl.Popup({ maxWidth: '300px', offset: 10, focusAfterOpen: false })
    .setLngLat(feature.geometry.coordinates)
    .setHTML(popupHtml(feature.properties))
    .addTo(map);
}

function focusCharger(id) {
  const feature = chargers.features.find((f) => f.id === id);
  if (!feature) return;
  const zoom = Math.max(map.getZoom(), 17);
  map.flyTo({ center: feature.geometry.coordinates, zoom, padding: paddingFor([feature.geometry.coordinates], zoom) });
  openPopup(feature);
}

// Searched places: marker + nearest chargers

function showPlace({ name, lngLat }) {
  placeMarker?.remove();
  placeMarker = new maplibregl.Marker({ color: '#1d2329' }).setLngLat(lngLat).addTo(map);

  const nearest = chargers.features
    .filter((f) => matches(f.properties))
    .map((f) => ({ f, d: distance(lngLat, f.geometry.coordinates) }))
    .sort((a, b) => a.d - b.d)
    .slice(0, 5)
    .map(({ f, d }) => ({ id: f.id, distance: d, ...f.properties, color: SPEED_BY_ID[f.properties.speed_class].color }));

  panel.renderNearby({ name, lngLat, nearest });

  // Fit after the panel has grown, so the padding is right on mobile
  const around = [lngLat, ...nearest.map((c) => chargers.features.find((f) => f.id === c.id).geometry.coordinates)];
  fitTo(around, { maxZoom: 17 });
}

function clearPlace() {
  placeMarker?.remove();
  placeMarker = null;
  panel.renderNearby(null);
}

mobile.addEventListener('change', () => map?.resize());

start();
