// Looks up countries for books and films using Wikidata (SPARQL) and Open Library.
// All results are ISO 3166-1 numeric codes ("276" = Germany), which match the
// ids in the world-atlas topojson.
//
//   Book origin   = every citizenship of the author + country of birthplace, all combined
//   Book setting  = Wikidata "narrative location" (P840), fallback Open Library subject places
//   Film origin   = Wikidata "country of origin" (P495)
//   Film setting  = Wikidata "narrative location" (P840)

import { normName } from './store.js';

const WDQS = 'https://query.wikidata.org/sparql';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lit = (s) => `${JSON.stringify(s)}@en`;
const pad3 = (c) => String(c).padStart(3, '0');
const splitCodes = (s) => (s ? s.split(' ').filter(Boolean).map(pad3) : []);

function chunk(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

async function sparql(query, attempt = 0) {
  const res = await fetch(WDQS, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Accept: 'application/sparql-results+json',
      'Api-User-Agent': 'ReadWatchMap/0.1 (personal reading map)',
    },
    body: new URLSearchParams({ query }),
  });
  if ((res.status === 429 || res.status >= 500) && attempt < 4) {
    await sleep(2000 * 2 ** attempt);
    return sparql(query, attempt + 1);
  }
  if (!res.ok) throw new Error(`Wikidata answered ${res.status}`);
  const json = await res.json();
  return json.results.bindings.map((b) =>
    Object.fromEntries(Object.entries(b).map(([k, v]) => [k, v.value])),
  );
}

// "J.K.  Rowling" -> ["J.K. Rowling", "J. K. Rowling"]
function nameVariants(name) {
  const n = name.replace(/\s+/g, ' ').trim();
  const spaced = n.replace(/\b([A-Z])\.(?=[A-Z])/g, '$1. ');
  const tight = n.replace(/\b([A-Z])\. (?=[A-Z]\.)/g, '$1.');
  return [...new Set([n, spaced, tight])];
}

// "Dune (Dune #1)" -> ["Dune"];  "Sapiens: A Brief History" -> [full, "Sapiens"]
export function titleVariants(title) {
  const base = title.replace(/\s*\([^)]*#[^)]*\)\s*$/, '').replace(/\s+/g, ' ').trim();
  const short = base.split(/:\s/)[0].trim();
  return [...new Set([base, short].filter((t) => t.length > 1))];
}

const maxBy = (arr, f) => arr.reduce((best, x) => (best === undefined || f(x) > f(best) ? x : best), undefined);

// ---------- authors ----------

async function resolveAuthors(names, valid) {
  const out = {};
  for (const batch of chunk(names, 40)) {
    const variantOf = new Map();
    for (const name of batch) for (const v of nameVariants(name)) variantOf.set(v, name);
    const rows = await sparql(`
      SELECT ?name ?person ?sl (GROUP_CONCAT(DISTINCT ?iso) AS ?cit) (GROUP_CONCAT(DISTINCT ?biso) AS ?birth) WHERE {
        VALUES ?name { ${[...variantOf.keys()].map(lit).join(' ')} }
        ?person rdfs:label|skos:altLabel ?name ; wdt:P31 wd:Q5 ; wikibase:sitelinks ?sl .
        OPTIONAL { ?person wdt:P27 ?c . ?c wdt:P299 ?iso }
        OPTIONAL { ?person wdt:P19/wdt:P17 ?bc . ?bc wdt:P299 ?biso }
      } GROUP BY ?name ?person ?sl`);
    const byName = new Map();
    for (const r of rows) {
      const name = variantOf.get(r.name);
      if (!name) continue;
      if (!byName.has(name)) byName.set(name, []);
      byName.get(name).push(r);
    }
    for (const name of batch) {
      const best = maxBy(byName.get(name) || [], (r) => Number(r.sl));
      // Every citizenship plus the (present-day) country of birth, e.g. Ocean Vuong -> United States + Vietnam.
      const codes = best ? [...splitCodes(best.cit), ...splitCodes(best.birth)].filter((c) => valid.has(c)) : [];
      out[normName(name)] = [...new Set(codes)];
    }
  }
  return out;
}

// ---------- places (free-text -> country) ----------

function cleanPlace(p) {
  return p.split(/\s--\s|,/)[0].replace(/\(.*?\)/g, '').replace(/\s+/g, ' ').trim();
}

async function resolvePlaces(names, valid) {
  const out = {};
  for (const batch of chunk(names, 40)) {
    const rows = await sparql(`
      SELECT ?name ?sl ?iso0 ?iso1 WHERE {
        VALUES ?name { ${batch.map(lit).join(' ')} }
        ?p rdfs:label ?name ; wikibase:sitelinks ?sl . FILTER(?sl > 10)
        OPTIONAL { ?p wdt:P299 ?iso0 }
        OPTIONAL { ?p wdt:P17 ?c . ?c wdt:P299 ?iso1 }
      }`);
    for (const name of batch) {
      const candidates = rows
        .filter((r) => r.name === name)
        .map((r) => ({ sl: Number(r.sl), code: pad3(r.iso0 || r.iso1 || '') }))
        .filter((r) => valid.has(r.code));
      const best = maxBy(candidates, (r) => r.sl);
      out[name] = best ? best.code : null;
    }
  }
  return out;
}

// ---------- books ----------

async function wikidataBookSettings(books, valid) {
  const out = {};
  for (const batch of chunk(books, 15)) {
    const values = [];
    batch.forEach((b, i) => {
      for (const t of titleVariants(b.title))
        for (const a of nameVariants(b.creator)) values.push(`("${i}" ${lit(t)} ${lit(a)})`);
    });
    const rows = await sparql(`
      SELECT ?key ?book ?sl (GROUP_CONCAT(DISTINCT ?siso) AS ?set) WHERE {
        VALUES (?key ?title ?author) { ${values.join(' ')} }
        ?a rdfs:label|skos:altLabel ?author . ?book wdt:P50 ?a ; rdfs:label ?title ; wikibase:sitelinks ?sl .
        OPTIONAL { ?book wdt:P840 ?loc . ?loc wdt:P17? ?sc . ?sc wdt:P299 ?siso }
      } GROUP BY ?key ?book ?sl`);
    batch.forEach((b, i) => {
      const withSetting = rows.filter((r) => r.key === String(i) && r.set);
      const best = maxBy(withSetting, (r) => Number(r.sl));
      out[b.key] = best ? [...new Set(splitCodes(best.set).filter((c) => valid.has(c)))] : [];
    });
  }
  return out;
}

async function openLibraryPlaces(book) {
  const params = new URLSearchParams({
    title: titleVariants(book.title).at(-1),
    author: book.creator,
    fields: 'place',
    limit: '3',
  });
  try {
    const res = await fetch(`https://openlibrary.org/search.json?${params}`);
    if (!res.ok) return [];
    const { docs = [] } = await res.json();
    const doc = docs.find((d) => d.place?.length);
    return doc ? doc.place.slice(0, 8).map(cleanPlace).filter((p) => p.length > 1) : [];
  } catch {
    return [];
  }
}

async function pool(items, size, fn) {
  let next = 0;
  const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      await fn(items[i], i);
    }
  });
  await Promise.all(workers);
}

// ---------- films ----------

async function resolveFilms(films, valid) {
  const out = {};
  for (const batch of chunk(films, 40)) {
    const values = batch.map((f, i) => `("${i}" ${lit(f.title)} ${/^\d{4}$/.test(f.year) ? f.year : 'UNDEF'})`);
    const rows = await sparql(`
      SELECT ?key ?film ?sl (GROUP_CONCAT(DISTINCT ?oiso) AS ?o) (GROUP_CONCAT(DISTINCT ?siso) AS ?s) WHERE {
        VALUES (?key ?title ?year) { ${values.join(' ')} }
        ?film rdfs:label|skos:altLabel ?title ; wdt:P577 ?date ; wdt:P57 [] ; wikibase:sitelinks ?sl .
        FILTER(!BOUND(?year) || ABS(YEAR(?date) - ?year) <= 1)
        OPTIONAL { ?film wdt:P495 ?oc . ?oc wdt:P299 ?oiso }
        OPTIONAL { ?film wdt:P840 ?loc . ?loc wdt:P17? ?sc . ?sc wdt:P299 ?siso }
      } GROUP BY ?key ?film ?sl`);
    batch.forEach((f, i) => {
      const best = maxBy(rows.filter((r) => r.key === String(i)), (r) => Number(r.sl));
      const pick = (s) => [...new Set(splitCodes(s).filter((c) => valid.has(c)))];
      out[f.key] = { origin: best ? pick(best.o) : [], setting: best ? pick(best.s) : [] };
    });
  }
  return out;
}

// ---------- pipeline ----------

/**
 * Fills `cache` ({authors, books, films, places}) for every item that hasn't
 * been looked up yet. Calls onProgress(message) and onUpdate() as results arrive.
 */
export async function enrich(items, cache, valid, { onProgress, onUpdate }) {
  const books = items.filter((i) => i.type === 'book');
  const films = items.filter((i) => i.type === 'film');

  // Authors cached under the old rule (birth country only as a fallback) are looked up again once.
  if (cache.authorRule !== 'citizenship+birth') {
    cache.authors = {};
    cache.authorRule = 'citizenship+birth';
  }

  const authors = [...new Set(books.map((b) => b.creator).filter(Boolean))].filter(
    (a) => !(normName(a) in cache.authors),
  );
  for (const [n, batch] of chunk(authors, 40).entries()) {
    onProgress(`Looking up authors… ${Math.min((n + 1) * 40, authors.length)}/${authors.length}`);
    Object.assign(cache.authors, await resolveAuthors(batch, valid));
    onUpdate();
  }

  const filmsTodo = films.filter((f) => !(f.key in cache.films));
  for (const [n, batch] of chunk(filmsTodo, 40).entries()) {
    onProgress(`Looking up films… ${Math.min((n + 1) * 40, filmsTodo.length)}/${filmsTodo.length}`);
    Object.assign(cache.films, await resolveFilms(batch, valid));
    onUpdate();
  }

  const booksTodo = books.filter((b) => !(b.key in cache.books));
  const noSetting = [];
  for (const [n, batch] of chunk(booksTodo, 15).entries()) {
    onProgress(`Looking up book settings… ${Math.min((n + 1) * 15, booksTodo.length)}/${booksTodo.length}`);
    const found = await wikidataBookSettings(batch, valid);
    for (const b of batch) {
      if (found[b.key].length) cache.books[b.key] = { setting: found[b.key] };
      else noSetting.push(b);
    }
    onUpdate();
  }

  // Fallback: Open Library "subject places", resolved to countries via Wikidata.
  if (noSetting.length) {
    const placesByBook = new Map();
    let done = 0;
    await pool(noSetting, 4, async (b) => {
      placesByBook.set(b.key, await openLibraryPlaces(b));
      onProgress(`Checking Open Library for settings… ${++done}/${noSetting.length}`);
    });
    const unknown = [...new Set([...placesByBook.values()].flat())].filter((p) => !(p in cache.places));
    if (unknown.length) {
      onProgress(`Resolving ${unknown.length} place names…`);
      Object.assign(cache.places, await resolvePlaces(unknown, valid));
    }
    for (const b of noSetting) {
      const codes = placesByBook.get(b.key).map((p) => cache.places[p]).filter(Boolean);
      cache.books[b.key] = { setting: [...new Set(codes)] };
    }
    onUpdate();
  }
}
