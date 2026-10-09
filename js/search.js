import { ORS_KEY, BBOX } from './config.js';
import { esc, plural, debounce } from './util.js';

const POSTCODE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;
const normalise = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

export function initSearch({ chargers, onStreet, onPlace }) {
  const input = document.getElementById('search-input');
  const list = document.getElementById('search-results');
  if (ORS_KEY) input.placeholder = 'Search address, street or postcode';

  // Streets that have chargers, searched locally
  const streets = new Map();
  for (const f of chargers.features) {
    const name = f.properties.site;
    if (!streets.has(name)) streets.set(name, { name, key: normalise(name), features: [] });
    streets.get(name).features.push(f);
  }

  let results = [];
  let active = -1;
  let requestId = 0;

  const close = () => {
    list.hidden = true;
    input.setAttribute('aria-expanded', 'false');
    active = -1;
  };

  function render() {
    if (!results.length) {
      list.innerHTML = input.value.trim().length >= 2 ? '<li class="search-empty">No matches</li>' : '';
      list.hidden = !list.innerHTML;
      input.setAttribute('aria-expanded', String(!list.hidden));
      return;
    }
    let lastGroup = null;
    list.innerHTML = results.map((r, i) => {
      const heading = r.group !== lastGroup ? `<li class="search-group" role="presentation">${esc(r.group)}</li>` : '';
      lastGroup = r.group;
      return `${heading}<li role="option" id="search-opt-${i}" data-index="${i}" aria-selected="${i === active}">
        ${esc(r.label)}${r.detail ? `<span class="muted">${esc(r.detail)}</span>` : ''}</li>`;
    }).join('');
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-activedescendant', active >= 0 ? `search-opt-${active}` : '');
  }

  function choose(r) {
    if (!r) return;
    input.value = r.label;
    close();
    input.blur();
    if (r.type === 'street') onStreet(r.label, r.features);
    else onPlace({ name: r.label, lngLat: r.lngLat });
  }

  const localResults = (q) => {
    const key = normalise(q);
    if (key.length < 2) return [];
    return [...streets.values()]
      .filter((s) => s.key.includes(key))
      .sort((a, b) => a.key.startsWith(key) === b.key.startsWith(key) ? a.key.localeCompare(b.key) : a.key.startsWith(key) ? -1 : 1)
      .slice(0, 5)
      .map((s) => ({ type: 'street', group: 'Streets with chargers', label: s.name, detail: plural(s.features.length, 'site'), features: s.features }));
  };

  async function postcodeResult(q) {
    if (!POSTCODE.test(q.trim())) return [];
    const res = await fetch(`https://api.postcodes.io/postcodes/${encodeURIComponent(q.trim())}`);
    if (!res.ok) return [];
    const { result } = await res.json();
    return result ? [{ type: 'place', group: 'Postcode', label: result.postcode, lngLat: [result.longitude, result.latitude] }] : [];
  }

  async function addressResults(q) {
    if (!ORS_KEY || q.trim().length < 3) return [];
    const params = new URLSearchParams({
      api_key: ORS_KEY,
      text: q,
      size: '5',
      layers: 'venue,address,street',
      'boundary.country': 'GB',
      'boundary.rect.min_lon': BBOX.minLon - 0.01,
      'boundary.rect.min_lat': BBOX.minLat - 0.01,
      'boundary.rect.max_lon': BBOX.maxLon + 0.01,
      'boundary.rect.max_lat': BBOX.maxLat + 0.01,
    });
    const res = await fetch(`https://api.openrouteservice.org/geocode/autocomplete?${params}`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.features ?? []).map((f) => ({
      type: 'place',
      group: 'Addresses',
      label: f.properties.name,
      detail: [f.properties.street && f.properties.name !== f.properties.street ? f.properties.street : null, f.properties.postalcode]
        .filter(Boolean).join(', '),
      lngLat: f.geometry.coordinates,
    }));
  }

  const remoteSearch = debounce(async (q, id) => {
    const extra = (await Promise.all([postcodeResult(q), addressResults(q)].map((p) => p.catch(() => [])))).flat();
    if (id !== requestId || !extra.length) return;
    results = [...results, ...extra];
    render();
  }, 300);

  input.addEventListener('input', () => {
    const q = input.value;
    requestId += 1;
    active = -1;
    results = localResults(q);
    render();
    if (q.trim().length >= 3) remoteSearch(q, requestId);
  });

  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      if (!results.length) return;
      e.preventDefault();
      active = (active + (e.key === 'ArrowDown' ? 1 : -1) + results.length) % results.length;
      render();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      choose(results[active >= 0 ? active : 0]);
    } else if (e.key === 'Escape') {
      close();
    }
  });

  list.addEventListener('mousedown', (e) => {
    const item = e.target.closest('[data-index]');
    if (!item) return;
    e.preventDefault();
    choose(results[Number(item.dataset.index)]);
  });

  input.addEventListener('focus', () => { if (results.length) render(); });
  input.addEventListener('blur', close);
}
