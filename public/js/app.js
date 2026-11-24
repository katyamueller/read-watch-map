/* global d3 */
import { load, save, emptyCache, normName } from './store.js';
import { readFile, syncGoodreads, syncLetterboxd, dedupe } from './importers.js';
import { enrich } from './enrich.js';
import { WorldMap, colorScale } from './map.js';

const TOPOLOGY_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-50m.json';

const state = {
  items: load('items', []),
  cache: { ...emptyCache(), ...load('cache', {}) },
  overrides: load('overrides', {}),
  prefs: { source: 'both', lens: 'origin', theme: 'auto', ...load('prefs', {}) },
  selected: null,
  busy: false,
  rerun: false,
};

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

let worldMap;
let valid = new Set();
let countryNames = new Map();

const LENS_HINT = {
  origin: 'Books: where the author is from · Films: production country',
  setting: 'Where the story takes place (books & films)',
};

function noun(n, source) {
  const word = source === 'book' ? 'book' : source === 'film' ? 'film' : 'title';
  return `${n.toLocaleString()} ${word}${n === 1 ? '' : 's'}`;
}

// ---------- data view ----------

function countriesFor(item, lens) {
  const override = state.overrides[`${item.key}|${lens}`];
  if (override) return override;
  if (item.type === 'book') {
    return lens === 'origin' ? state.cache.authors[normName(item.creator)] : state.cache.books[item.key]?.setting;
  }
  return state.cache.films[item.key]?.[lens];
}

function view() {
  const { source, lens } = state.prefs;
  const items = state.items.filter((i) => source === 'both' || i.type === source);
  const byCountry = new Map();
  const unmatched = [];
  let pending = 0;
  let located = 0;
  for (const item of items) {
    const codes = countriesFor(item, lens);
    if (codes === undefined) pending++;
    else if (!codes.length) unmatched.push(item);
    else {
      located++;
      for (const c of codes) {
        if (!byCountry.has(c)) byCountry.set(c, []);
        byCountry.get(c).push(item);
      }
    }
  }
  const counts = new Map([...byCountry].map(([c, list]) => [c, list.length]));
  return { items, byCountry, counts, unmatched, pending, located };
}

// ---------- rendering ----------

function render() {
  const { source, lens } = state.prefs;
  const v = view();
  const unit = source === 'both' ? 'both' : source;

  document.querySelectorAll('[data-source]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.source === source));
  document.querySelectorAll('[data-lens]').forEach((b) => b.setAttribute('aria-pressed', b.dataset.lens === lens));
  $('#lens-hint').textContent = LENS_HINT[lens];

  $('#stat-located').textContent = v.located.toLocaleString();
  $('#stat-located-label').textContent = `${unit === 'both' ? 'titles' : unit + 's'} on the map`;
  $('#stat-countries').textContent = v.counts.size.toLocaleString();
  $('#stat-unmatched').textContent = v.unmatched.length.toLocaleString();
  $('#stat-pending').textContent = v.pending ? `${v.pending.toLocaleString()} still being looked up` : '';

  $('#empty-state').hidden = state.items.length > 0;

  const max = worldMap.update(v.counts, state.selected);
  renderLegend(max, v.counts.size);
  renderSide(v, unit);
  renderUnmatched(v, unit);
}

function renderLegend(max, n) {
  const legend = $('#legend');
  if (!n) {
    legend.hidden = true;
    return;
  }
  legend.hidden = false;
  const color = colorScale(max);
  const stops = d3.range(0, 1.0001, 0.1).map((t) => {
    const val = Math.exp(Math.log(Math.max(max, 2)) * t);
    return `${color(val)} ${Math.round(t * 100)}%`;
  });
  $('#legend-bar').style.background = `linear-gradient(to right, ${stops.join(',')})`;
  $('#legend-max').textContent = max.toLocaleString();
}

function itemRow(item, lens, { showOverride = true } = {}) {
  const manual = state.overrides[`${item.key}|${lens}`];
  const meta = [item.type === 'book' ? item.creator : 'Film', item.year].filter(Boolean).join(' · ');
  const title = item.url ? `<a href="${esc(item.url)}" target="_blank" rel="noopener">${esc(item.title)}</a>` : esc(item.title);
  return `<li class="item">
    <span class="item-icon" aria-hidden="true">${item.type === 'book' ? '📖' : '🎬'}</span>
    <span class="item-main"><span class="item-title">${title}</span><span class="item-meta">${esc(meta)}</span></span>
    ${manual && showOverride ? `<button class="link-btn" data-reset="${esc(item.key)}" title="Remove manual country">manual ×</button>` : ''}
  </li>`;
}

function renderSide(v, unit) {
  const side = $('#side-content');
  const lens = state.prefs.lens;
  if (state.selected) {
    const list = v.byCountry.get(state.selected) || [];
    $('#side-title').textContent = countryNames.get(state.selected) || 'Country';
    $('#side-back').hidden = false;
    side.innerHTML = list.length
      ? `<p class="muted">${noun(list.length, unit)}</p><ul class="items">${list
          .slice()
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((i) => itemRow(i, lens))
          .join('')}</ul>`
      : `<p class="muted">Nothing here yet for this filter.</p>`;
    return;
  }
  $('#side-title').textContent = 'Countries';
  $('#side-back').hidden = true;
  const ranked = [...v.counts].sort((a, b) => b[1] - a[1] || countryNames.get(a[0]).localeCompare(countryNames.get(b[0])));
  if (!ranked.length) {
    side.innerHTML = `<p class="muted">${state.items.length ? 'No countries yet for this filter.' : 'Import your data to get started.'}</p>`;
    return;
  }
  const max = ranked[0][1];
  side.innerHTML = `<ol class="ranking">${ranked
    .map(
      ([code, n]) => `<li><button class="rank-row" data-country="${code}">
        <span class="rank-name">${esc(countryNames.get(code))}</span>
        <span class="rank-bar"><span style="width:${Math.max(4, (n / max) * 100)}%"></span></span>
        <span class="rank-n">${n.toLocaleString()}</span>
      </button></li>`,
    )
    .join('')}</ol>`;
}

let countryOptions = '';

function renderUnmatched(v, unit) {
  $('#unmatched-count').textContent = v.unmatched.length.toLocaleString();
  const shown = v.unmatched.slice(0, 300);
  $('#unmatched-list').innerHTML = shown.length
    ? shown
        .map(
          (i) => `<li class="item">
            <span class="item-icon" aria-hidden="true">${i.type === 'book' ? '📖' : '🎬'}</span>
            <span class="item-main"><span class="item-title">${esc(i.title)}</span><span class="item-meta">${esc([i.creator, i.year].filter(Boolean).join(' · '))}</span></span>
            <select data-assign="${esc(i.key)}" aria-label="Assign a country to ${esc(i.title)}">
              <option value="">Assign country…</option>${countryOptions}
            </select>
          </li>`,
        )
        .join('') + (v.unmatched.length > 300 ? `<li class="muted">…and ${v.unmatched.length - 300} more</li>` : '')
    : `<li class="muted">Everything${unit === 'both' ? '' : ` (${unit}s)`} has a country. 🎉</li>`;
}

// ---------- tooltip ----------

function showTooltip(code, event) {
  const tip = $('#tooltip');
  if (!code) {
    tip.hidden = true;
    return;
  }
  const v = view();
  const list = v.byCountry.get(code) || [];
  const unit = state.prefs.source === 'both' ? 'both' : state.prefs.source;
  tip.innerHTML = `<strong>${esc(countryNames.get(code))}</strong>
    <span class="tip-count">${list.length ? noun(list.length, unit) : 'None yet'}</span>
    ${list.length ? `<ul>${list.slice(0, 3).map((i) => `<li>${esc(i.title)}</li>`).join('')}${list.length > 3 ? `<li class="muted">+${list.length - 3} more · click to see all</li>` : ''}</ul>` : ''}`;
  tip.hidden = false;
  const box = $('#map').getBoundingClientRect();
  const x = event.clientX - box.left;
  const y = event.clientY - box.top;
  const flip = x > box.width - 240;
  tip.style.left = `${flip ? x - tip.offsetWidth - 14 : x + 14}px`;
  tip.style.top = `${Math.max(4, y - 10)}px`;
}

// ---------- status & lookups ----------

function setStatus(msg, kind = 'info') {
  const el = $('#status');
  el.textContent = msg;
  el.dataset.kind = kind;
  el.hidden = !msg;
}

async function runEnrich() {
  if (state.busy) {
    state.rerun = true;
    return;
  }
  state.busy = true;
  document.body.classList.add('busy');
  try {
    await enrich(state.items, state.cache, valid, {
      onProgress: (m) => setStatus(m, 'progress'),
      onUpdate: () => {
        save('cache', state.cache);
        render();
      },
    });
    const v = view();
    setStatus(
      state.items.length
        ? `Done. ${v.located.toLocaleString()} titles placed in ${v.counts.size} countries${v.unmatched.length ? `; ${v.unmatched.length} couldn’t be located (you can assign them below)` : ''}.`
        : '',
      'ok',
    );
  } catch (err) {
    console.error(err);
    setStatus(`Lookup stopped: ${err.message}. Already-found results are kept. Try “Retry lookups” in a minute.`, 'error');
  } finally {
    state.busy = false;
    document.body.classList.remove('busy');
    render();
    if (state.rerun) {
      state.rerun = false;
      runEnrich();
    }
  }
}

function importItems(newItems, label) {
  if (!newItems.length) {
    setStatus(`No ${label} found in that import.`, 'error');
    return;
  }
  state.items = dedupe([...state.items, ...newItems]);
  save('items', state.items);
  $('#import-panel').hidden = true;
  $('#open-import').setAttribute('aria-expanded', 'false');
  setStatus(`Imported ${newItems.length.toLocaleString()} ${label}. Looking up countries…`, 'progress');
  render();
  runEnrich();
}

async function handleFiles(files) {
  for (const file of files) {
    try {
      const items = await readFile(file);
      importItems(items, items[0]?.type === 'film' ? 'films' : 'books');
    } catch (err) {
      setStatus(`${file.name}: ${err.message}`, 'error');
    }
  }
}

async function handleSync(kind, form) {
  const input = form.querySelector('input');
  const user = input.value.trim();
  if (!user) return input.focus();
  const btn = form.querySelector('button');
  btn.disabled = true;
  setStatus(`Fetching ${kind === 'goodreads' ? 'Goodreads shelf' : 'Letterboxd diary'}…`, 'progress');
  try {
    const items = kind === 'goodreads' ? await syncGoodreads(user) : await syncLetterboxd(user);
    state.prefs[`${kind}User`] = user;
    save('prefs', state.prefs);
    importItems(items, kind === 'goodreads' ? 'books' : 'films');
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

// ---------- theme ----------

function applyTheme() {
  const t = state.prefs.theme;
  if (t === 'auto') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  $('#theme-toggle').textContent = { auto: '◐ Auto', light: '☀ Light', dark: '☾ Dark' }[t];
}

// ---------- wiring ----------

function bind() {
  document.querySelectorAll('[data-source]').forEach((b) =>
    b.addEventListener('click', () => {
      state.prefs.source = b.dataset.source;
      save('prefs', state.prefs);
      render();
    }),
  );
  document.querySelectorAll('[data-lens]').forEach((b) =>
    b.addEventListener('click', () => {
      state.prefs.lens = b.dataset.lens;
      save('prefs', state.prefs);
      render();
    }),
  );

  $('#side').addEventListener('click', (e) => {
    const row = e.target.closest('[data-country]');
    if (row) {
      state.selected = row.dataset.country;
      render();
    }
    const reset = e.target.closest('[data-reset]');
    if (reset) {
      delete state.overrides[`${reset.dataset.reset}|${state.prefs.lens}`];
      save('overrides', state.overrides);
      render();
    }
  });
  $('#side-back').addEventListener('click', () => {
    state.selected = null;
    render();
  });
  $('#reset-zoom').addEventListener('click', () => worldMap.resetZoom());

  $('#unmatched-list').addEventListener('change', (e) => {
    const sel = e.target.closest('[data-assign]');
    if (!sel || !sel.value) return;
    state.overrides[`${sel.dataset.assign}|${state.prefs.lens}`] = [sel.value];
    save('overrides', state.overrides);
    render();
  });

  // Import panel
  const panel = $('#import-panel');
  $('#open-import').addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    $('#open-import').setAttribute('aria-expanded', !panel.hidden);
  });
  $('#empty-import').addEventListener('click', () => {
    panel.hidden = false;
    $('#open-import').setAttribute('aria-expanded', 'true');
    panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  $('#gr-form').addEventListener('submit', (e) => {
    e.preventDefault();
    handleSync('goodreads', e.target);
  });
  $('#lb-form').addEventListener('submit', (e) => {
    e.preventDefault();
    handleSync('letterboxd', e.target);
  });
  if (state.prefs.goodreadsUser) $('#gr-user').value = state.prefs.goodreadsUser;
  if (state.prefs.letterboxdUser) $('#lb-user').value = state.prefs.letterboxdUser;

  $('#file-input').addEventListener('change', (e) => {
    handleFiles([...e.target.files]);
    e.target.value = '';
  });
  const drop = $('#dropzone');
  ['dragenter', 'dragover'].forEach((t) =>
    document.addEventListener(t, (e) => {
      e.preventDefault();
      drop.classList.add('dragging');
    }),
  );
  ['dragleave', 'drop'].forEach((t) =>
    document.addEventListener(t, (e) => {
      e.preventDefault();
      if (t === 'drop' || !e.relatedTarget) drop.classList.remove('dragging');
    }),
  );
  document.addEventListener('drop', (e) => handleFiles([...e.dataTransfer.files]));

  $('#retry').addEventListener('click', () => {
    // Forget "not found" results so they get looked up again.
    for (const section of ['films', 'books']) {
      for (const [k, v] of Object.entries(state.cache[section])) {
        const vals = section === 'films' ? [v.origin, v.setting] : [v.setting];
        if (vals.every((x) => !x?.length)) delete state.cache[section][k];
      }
    }
    for (const [k, v] of Object.entries(state.cache.authors)) if (!v.length) delete state.cache.authors[k];
    save('cache', state.cache);
    runEnrich();
  });
  $('#clear').addEventListener('click', () => {
    if (!confirm('Remove all imported books, films, lookups and manual assignments from this browser?')) return;
    state.items = [];
    state.cache = emptyCache();
    state.overrides = {};
    state.selected = null;
    ['items', 'cache', 'overrides'].forEach((k) => save(k, k === 'cache' ? state.cache : k === 'items' ? [] : {}));
    setStatus('');
    render();
  });

  $('#theme-toggle').addEventListener('click', () => {
    const order = ['auto', 'light', 'dark'];
    state.prefs.theme = order[(order.indexOf(state.prefs.theme) + 1) % 3];
    save('prefs', state.prefs);
    applyTheme();
    render();
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', render);
}

async function init() {
  applyTheme();
  try {
    const topology = await (await fetch(TOPOLOGY_URL)).json();
    worldMap = new WorldMap($('#map'), topology, {
      onHover: showTooltip,
      onSelect: (code) => {
        state.selected = state.selected === code ? null : code;
        render();
      },
    });
  } catch (err) {
    setStatus(`Could not load the world map (${err.message}). Check your internet connection.`, 'error');
    return;
  }
  countryNames = worldMap.names;
  valid = new Set(countryNames.keys());
  countryOptions = [...countryNames]
    .sort((a, b) => a[1].localeCompare(b[1]))
    .map(([code, name]) => `<option value="${code}">${esc(name)}</option>`)
    .join('');
  bind();
  if (!state.items.length) $('#import-panel').hidden = false;
  render();
  if (state.items.length) runEnrich();
}

init();
