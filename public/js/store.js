// Persistence in localStorage. Everything stays in this browser.

const KEYS = {
  items: 'rwm-items-v1',
  cache: 'rwm-cache-v1',
  overrides: 'rwm-overrides-v1',
  prefs: 'rwm-prefs-v1',
};

export const normName = (s) => (s || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();

export const bookKey = (title, author) => `b|${normName(title)}|${normName(author)}`;
export const filmKey = (title, year) => `f|${normName(title)}|${year || ''}`;

export function load(name, fallback) {
  try {
    const v = localStorage.getItem(KEYS[name]);
    return v ? JSON.parse(v) : fallback;
  } catch {
    return fallback;
  }
}

export function save(name, value) {
  try {
    localStorage.setItem(KEYS[name], JSON.stringify(value));
  } catch (err) {
    console.warn(`Could not save ${name}`, err);
  }
}

export const emptyCache = () => ({ authors: {}, books: {}, films: {}, places: {} });
