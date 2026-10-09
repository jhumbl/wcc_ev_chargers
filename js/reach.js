// Travel-time areas from openrouteservice isochrones

import { ORS_KEY, TRAVEL_MODES, TRAVEL_TIMES } from './config.js';
import { esc, fmt, plural, inGeometry, flatten, track, toast } from './util.js';

const $ = (id) => document.getElementById(id);
const EMPTY = { type: 'FeatureCollection', features: [] };

export function initReach({ map, beforeId, visibleChargers, fitTo }) {
  if (!ORS_KEY) return { available: false, picking: false, runFrom() {}, refresh() {} };

  const root = $('reach');
  const toggle = $('reach-toggle');
  const card = $('reach-card');
  const hint = $('reach-hint');
  const resultsEl = $('reach-results');
  const clearButton = $('reach-clear');
  root.hidden = false;

  let mode = TRAVEL_MODES[0].id;
  let time = 10;           // minutes, or 'all'
  let origin = null;
  let areas = null;        // ORS features, smallest first
  let controller = null;

  const api = { available: true, picking: false, runFrom, refresh };

  // Map layers

  map.addSource('reach', { type: 'geojson', data: EMPTY });
  map.addSource('reach-origin', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'reach-fill', type: 'fill', source: 'reach', paint: { 'fill-color': '#27313b', 'fill-opacity': 0.09 } }, beforeId);
  map.addLayer({ id: 'reach-line', type: 'line', source: 'reach', paint: { 'line-color': '#27313b', 'line-width': 1.5, 'line-opacity': 0.7 } }, beforeId);
  map.addLayer({
    id: 'reach-origin', type: 'circle', source: 'reach-origin',
    paint: { 'circle-radius': 6, 'circle-color': '#1d2329', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2 },
  });

  // Controls

  const modeEl = $('reach-mode');
  modeEl.innerHTML = TRAVEL_MODES.map((m) => `<button data-value="${m.id}" aria-pressed="${m.id === mode}">${esc(m.label)}</button>`).join('');
  const timeEl = $('reach-time');
  timeEl.innerHTML = [...TRAVEL_TIMES.map((t) => [t, `${t} min`]), ['all', 'All']]
    .map(([v, label]) => `<button data-value="${v}" aria-pressed="${v === time}">${label}</button>`).join('');

  const segmented = (el, onPick) => el.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    el.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    onPick(b.dataset.value);
    if (origin) runFrom(origin);
  });
  segmented(modeEl, (v) => { mode = v; });
  segmented(timeEl, (v) => { time = v === 'all' ? 'all' : Number(v); });

  const setOpen = (open) => {
    card.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    api.picking = open;
    map.getCanvas().style.cursor = open ? 'crosshair' : '';
  };
  toggle.addEventListener('click', () => setOpen(card.hidden));

  $('reach-locate').addEventListener('click', () => {
    if (!navigator.geolocation) return toast('Location isn’t available in this browser.');
    hint.textContent = 'Finding your location…';
    navigator.geolocation.getCurrentPosition(
      (pos) => runFrom([pos.coords.longitude, pos.coords.latitude]),
      () => { hint.textContent = 'Couldn’t get your location. Click the map instead.'; },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  });

  clearButton.addEventListener('click', clear);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !card.hidden) setOpen(false); });

  function clear() {
    controller?.abort();
    origin = null;
    areas = null;
    map.getSource('reach').setData(EMPTY);
    map.getSource('reach-origin').setData(EMPTY);
    resultsEl.innerHTML = '';
    clearButton.hidden = true;
    hint.textContent = 'Click the map to choose a starting point.';
  }

  // Requests

  async function runFrom(lngLat) {
    setOpen(true);
    origin = lngLat;
    map.getSource('reach-origin').setData({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: lngLat } });
    hint.textContent = 'Calculating…';
    resultsEl.innerHTML = '';

    controller?.abort();
    controller = new AbortController();
    const minutes = time === 'all' ? TRAVEL_TIMES : [time];

    try {
      const res = await fetch(`https://api.openrouteservice.org/v2/isochrones/${mode}`, {
        method: 'POST',
        signal: controller.signal,
        headers: { Authorization: ORS_KEY, 'Content-Type': 'application/json', Accept: 'application/geo+json' },
        body: JSON.stringify({
          locations: [lngLat],
          range: minutes.map((m) => m * 60),
          range_type: 'time',
          attributes: ['total_pop'],
        }),
      });
      if (!res.ok) throw new Error(errorMessage(res.status, await res.json().catch(() => null)));
      const data = await res.json();

      areas = data.features.sort((a, b) => a.properties.value - b.properties.value);
      // Largest first so the smaller areas draw on top
      map.getSource('reach').setData({ type: 'FeatureCollection', features: [...areas].reverse() });
      fitTo(flatten(areas.at(-1).geometry.coordinates), { maxZoom: 17 });
      hint.textContent = 'Click the map to move the starting point.';
      clearButton.hidden = false;
      refresh();
      track(`reach/${mode}-${time}`);
    } catch (err) {
      if (err.name === 'AbortError') return;
      console.error(err);
      hint.textContent = err.message || 'Sorry, travel times couldn’t be calculated.';
    }
  }

  function errorMessage(status, body) {
    if (status === 429) return 'Too many requests right now. Please try again in a minute.';
    if (status === 401 || status === 403) return 'Travel times are unavailable (service key problem).';
    return body?.error?.message ? `Couldn’t calculate travel times: ${body.error.message}` : 'Sorry, travel times couldn’t be calculated.';
  }

  // Counts chargers in each area (re-run when filters change)

  function refresh() {
    if (!areas) return;
    const chargers = visibleChargers();
    const modeLabel = TRAVEL_MODES.find((m) => m.id === mode).label.toLowerCase();
    resultsEl.innerHTML = areas.map((a) => {
      const inside = chargers.filter((f) => inGeometry(f.geometry.coordinates, a.geometry));
      const bays = inside.reduce((sum, f) => sum + f.properties.bays, 0);
      const pop = a.properties.total_pop;
      return `<li>
        <strong>${a.properties.value / 60} min ${esc(modeLabel)}</strong>
        <span>${plural(inside.length, 'charge point site')} · ${plural(bays, 'bay')}</span>
        ${pop ? `<span class="muted">~${fmt(Math.round(pop / 100) * 100)} residents</span>` : ''}
      </li>`;
    }).join('');
  }

  return api;
}
