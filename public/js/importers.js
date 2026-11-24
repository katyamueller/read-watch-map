// Turns Goodreads / Letterboxd exports and RSS syncs into a common item shape:
// { key, type: 'book' | 'film', title, creator, year, date, url }

/* global d3, JSZip */
import { bookKey, filmKey } from './store.js';

// Goodreads wraps ISBNs like ="0123456789"
const cleanIsbn = (s) => (s || '').replace(/[="]/g, '');

const tidy = (s) => (s || '').replace(/\s+/g, ' ').trim();

function book({ id, title, author, year, date, isbn }) {
  title = tidy(title);
  author = tidy(author);
  return {
    key: bookKey(title, author),
    type: 'book',
    title,
    creator: author,
    year: year || '',
    date: date || '',
    isbn: cleanIsbn(isbn),
    url: id ? `https://www.goodreads.com/book/show/${id}` : '',
  };
}

function film({ title, year, date, url }) {
  title = tidy(title);
  return { key: filmKey(title, year), type: 'film', title, creator: '', year: year || '', date: date || '', url: url || '' };
}

function fromCsv(text) {
  const rows = d3.csvParse(text.replace(/^﻿/, ''));
  const cols = rows.columns;
  if (cols.includes('Exclusive Shelf') && cols.includes('Author')) {
    return rows
      .filter((r) => r['Exclusive Shelf'] === 'read')
      .map((r) =>
        book({
          id: r['Book Id'],
          title: r.Title,
          author: r.Author,
          year: r['Original Publication Year'] || r['Year Published'],
          date: r['Date Read'],
          isbn: r.ISBN13 || r.ISBN,
        }),
      );
  }
  if (cols.includes('Name') && cols.includes('Year') && cols.includes('Letterboxd URI')) {
    return rows.map((r) =>
      film({ title: r.Name, year: r.Year, date: r['Watched Date'] || r.Date, url: r['Letterboxd URI'] }),
    );
  }
  throw new Error('This CSV doesn\'t look like a Goodreads library export or a Letterboxd watched.csv / diary.csv.');
}

export async function readFile(file) {
  if (/\.zip$/i.test(file.name)) {
    const zip = await JSZip.loadAsync(file);
    const names = Object.keys(zip.files);
    const pick = (base) => names.filter((n) => n === base || n.endsWith(`/${base}`)).sort((a, b) => a.length - b.length)[0];
    const entry = pick('watched.csv') || pick('diary.csv');
    if (!entry) throw new Error('No watched.csv found in this ZIP. Is it a Letterboxd export?');
    return fromCsv(await zip.file(entry).async('string'));
  }
  return fromCsv(await file.text());
}

async function api(path) {
  let res;
  try {
    res = await fetch(path);
  } catch {
    throw new Error('Could not reach the local server. Start the app with "npm start".');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

export async function syncGoodreads(user) {
  const { name, items } = await api(`/api/goodreads?user=${encodeURIComponent(user)}`);
  return { name, items: items.map(book) };
}

export async function syncLetterboxd(user) {
  const { name, items } = await api(`/api/letterboxd?user=${encodeURIComponent(user)}`);
  return { name, items: items.map(film) };
}

export function dedupe(items) {
  const byKey = new Map();
  for (const it of items) byKey.set(it.key, { ...byKey.get(it.key), ...it });
  return [...byKey.values()];
}
