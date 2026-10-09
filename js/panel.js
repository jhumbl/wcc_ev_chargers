import { esc, fmt, plural, formatDistance } from './util.js';

const $ = (id) => document.getElementById(id);

export function initPanel({ speeds, operators, wards, updated, onFilter, onWard, onNearbyPick, onNearbyClose, onReachFrom, collapsed }) {
  let reachAvailable = false;

  // Header + mobile collapse

  if (updated) {
    const date = new Date(updated).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
    $('updated').textContent = `Data updated ${date}`;
  }

  const panelEl = $('panel');
  const handle = $('panel-handle');
  const setCollapsed = (value) => {
    panelEl.dataset.collapsed = value;
    handle.setAttribute('aria-expanded', String(!value));
  };
  setCollapsed(collapsed);
  handle.addEventListener('click', () => setCollapsed(panelEl.dataset.collapsed !== 'true'));
  panelEl.querySelector('.panel-head').addEventListener('click', () => {
    if (panelEl.dataset.collapsed === 'true') setCollapsed(false);
  });

  // Area

  const select = $('ward-select');
  for (const w of wards) select.add(new Option(w.ward, w.slug));
  const clearWard = $('ward-clear');
  clearWard.addEventListener('click', () => {
    select.value = '';
    onWard(null);
    select.focus();
  });
  select.addEventListener('change', () => {
    // On phones, get the sheet out of the way so the ward is visible
    if (window.matchMedia('(max-width: 720px)').matches) setCollapsed(true);
    onWard(select.value || null);
  });

  // Filters. Shop-style: nothing picked = everything; picking options narrows to just those

  const options = {
    speed: speeds.map((s) => ({ value: s.id, label: s.label, detail: s.detail, color: s.color })),
    status: [{ value: 'installed', label: 'Installed' }, { value: 'planned', label: 'Planned' }],
    operator: operators.map((o) => ({ value: o, label: o })),
    bay: [{ value: 'dedicated', label: 'Dedicated EV bay' }, { value: 'shared', label: 'Shared kerbside' }],
  };
  const selected = Object.fromEntries(Object.keys(options).map((k) => [k, new Set()]));
  const groups = Object.fromEntries(Object.keys(options).map((k) => [k, document.querySelector(`[data-facet="${k}"]`)]));

  groups.speed.innerHTML = options.speed.map((o) => `
    <li><button class="legend-row" data-value="${o.value}" aria-pressed="false">
      <span class="dot" style="--c:${o.color}"></span>
      <span class="legend-name">${esc(o.label)} <span class="muted">${esc(o.detail)}</span></span>
      <span class="legend-count" data-count>–</span>
    </button></li>`).join('');

  for (const facet of ['status', 'operator', 'bay']) {
    groups[facet].innerHTML = options[facet].map((o) => `
      <button class="chip" data-value="${esc(o.value)}" aria-pressed="false">
        ${facet === 'status' ? `<span class="dot dot-small${o.value === 'planned' ? ' dot-planned' : ''}"></span>` : ''}
        ${esc(o.label)} <span class="chip-count" data-count></span>
      </button>`).join('');
  }

  const sync = (facet) => {
    groups[facet].dataset.active = String(selected[facet].size > 0);
    groups[facet].querySelectorAll('[data-value]').forEach((b) => b.setAttribute('aria-pressed', String(selected[facet].has(b.dataset.value))));
    $('clear-filters').hidden = !Object.values(selected).some((v) => v.size);
  };

  for (const [facet, el] of Object.entries(groups)) {
    el.addEventListener('click', (e) => {
      const button = e.target.closest('[data-value]');
      if (!button) return;
      const value = button.dataset.value;
      selected[facet][selected[facet].has(value) ? 'delete' : 'add'](value);
      // Picking every option is the same as picking none
      if (selected[facet].size === options[facet].length) selected[facet].clear();
      sync(facet);
      onFilter(facet, new Set(selected[facet]));
    });
  }

  $('clear-filters').addEventListener('click', () => {
    for (const facet of Object.keys(selected)) {
      selected[facet].clear();
      sync(facet);
      onFilter(facet, new Set());
    }
  });

  // Nearby chargers for a searched place

  const nearby = $('nearby');
  nearby.addEventListener('click', (e) => {
    const item = e.target.closest('[data-id]');
    if (item) onNearbyPick(Number(item.dataset.id));
    if (e.target.closest('[data-close]')) onNearbyClose();
    const reachButton = e.target.closest('[data-reach]');
    if (reachButton) onReachFrom(JSON.parse(reachButton.dataset.reach));
  });

  return {
    renderStats({ counts, totals, wardName, filtered }) {
      for (const [facet, el] of Object.entries(groups)) {
        el.querySelectorAll('[data-value]').forEach((b) => {
          const n = counts[facet][b.dataset.value] ?? 0;
          b.querySelector('[data-count]').textContent = fmt(n);
          b.classList.toggle('is-empty', n === 0);
        });
      }
      const total = totals.installed + totals.planned;
      const where = wardName ? `in ${wardName}` : 'across Westminster';
      $('total').textContent = fmt(total);
      const caption = `${filtered ? 'matching' : 'charging'} ${total === 1 ? 'bay' : 'bays'} ${where}`;
      $('total-caption').textContent = caption;
      $('total-caption').title = caption;
      $('total-split').textContent = `${fmt(totals.installed)} installed · ${fmt(totals.planned)} planned`;
      $('head-summary').textContent = `${fmt(total)} bays${wardName ? ` in ${wardName}` : ''} · tap for filters`;
    },

    setWard(slug) {
      select.value = slug;
      clearWard.hidden = !slug;
    },

    setReachAvailable(value) {
      reachAvailable = value;
    },

    renderNearby(data) {
      if (!data) {
        nearby.hidden = true;
        nearby.innerHTML = '';
        return;
      }
      const { name, lngLat, nearest } = data;
      nearby.innerHTML = `
        <div class="nearby-head">
          <h2>Nearest to ${esc(name)}</h2>
          <button class="icon-button" data-close aria-label="Clear search">×</button>
        </div>
        ${nearest.length ? `<ol class="nearby-list">${nearest.map((c) => `
          <li><button data-id="${c.id}">
            <span class="dot${c.status === 'planned' ? ' dot-planned' : ''}" style="--c:${c.color}"></span>
            <span class="nearby-name">${esc(c.site)}<span class="muted">${esc(c.operator)} · ${esc(c.speeds)}${c.status === 'planned' ? ' · planned' : ''} · ${plural(c.bays, 'bay')}</span></span>
            <span class="nearby-distance">${formatDistance(c.distance)}</span>
          </button></li>`).join('')}</ol>` : '<p class="muted">No chargers match the current filters.</p>'}
        ${reachAvailable ? `<button class="link" data-reach="${esc(JSON.stringify(lngLat))}">Show travel time from here</button>` : ''}`;
      nearby.hidden = false;
      setCollapsed(false);
    },
  };
}
