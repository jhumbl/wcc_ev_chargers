// Site settings. Everything you might need to change lives here
// (the MapLibre version is pinned in index.html).

// CARTO Positron (vector, no key). Fallback if CARTO ever requires a key:
// 'https://tiles.openfreemap.org/styles/positron'
export const BASEMAP_STYLE = 'https://basemaps.cartocdn.com/gl/positron-gl-style/style.json';

// openrouteservice key, used for address search and travel-time areas.
// Leave empty to hide those features (street and postcode search still work).
export const ORS_KEY = 'eyJvcmciOiI1YjNjZTM1OTc4NTExMTAwMDFjZjYyNDgiLCJpZCI6IjhiYzZjMWMxZTYxYTQyZTFhM2UwM2NjODhjNzgzNGNlIiwiaCI6Im11cm11cjY0In0=';

export const DATA = {
  chargers: 'data/chargers.geojson',
  wards: 'data/wards.geojson',
  boundary: 'data/boundary.geojson',
};

// Rough Westminster extent, used to keep searches local
export const BBOX = { minLon: -0.2200, minLat: 51.4820, maxLon: -0.1080, maxLat: 51.5420 };

export const SPEEDS = [
  { id: 'lccp',  label: 'Lamp column', detail: '5.5kW', color: '#16a37a' },
  { id: 'fast',  label: 'Fast',        detail: '7–22kW', color: '#2f6fe0' },
  { id: 'rapid', label: 'Rapid',       detail: '50kW+', color: '#c2368f' },
];

export const TRAVEL_MODES = [
  { id: 'foot-walking',    label: 'Walk' },
  { id: 'cycling-regular', label: 'Cycle' },
  { id: 'driving-car',     label: 'Drive' },
  { id: 'wheelchair',      label: 'Wheelchair' },
];

// Minutes. 'rings' draws all of them at once.
export const TRAVEL_TIMES = [5, 10, 15];
