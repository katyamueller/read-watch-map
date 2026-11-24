// Tiny zero-dependency server: serves ./public and proxies the Goodreads shelf widget
// and Letterboxd RSS feed (browsers can't fetch them directly because of CORS).
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'public');
const PORT = Number(process.env.PORT) || 8080;
const UA = 'Mozilla/5.0 (read-watch-map; personal use)';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};


function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
  if (!m) return '';
  const raw = m[1].trim().replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1');
  return decodeEntities(raw.trim());
}

const items = (xml) => xml.match(/<item>[\s\S]*?<\/item>/g) || [];

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`${new URL(url).host} answered ${res.status}`);
  return res.text();
}

// Goodreads retired its shelf RSS feeds (late Oct 2026). The public shelf widget still works,
// but returns at most the 100 most recently added books, without read dates.
// For the full shelf, users upload their CSV export instead.
async function goodreads(userParam) {
  const id = (String(userParam).match(/(?:user\/show\/|^)(\d+)/) || [])[1];
  if (!id) throw new Error('Enter your numeric Goodreads user ID or profile URL (…/user/show/12345-name).');
  const js = await fetchText(
    `https://www.goodreads.com/review/custom_widget/${id}?shelf=read&num_books=100&cover_position=none&widget_id=1`,
  );
  // The widget is a JS snippet holding the HTML as an escaped string literal.
  const html = js.replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\//g, '/');
  const text = (s) => decodeEntities((s || '').replace(/<[^>]*>/g, '')).replace(/\s+/g, ' ').trim();
  // Header looks like "Katya's books".
  const header = text((html.match(/class="gr_custom_header_1">([\s\S]*?)<\/h2>/) || [])[1]);
  const name = (header.match(/^(.*?)\s*['’]s books/) || [])[1] || '';
  const books = html
    .split('class="gr_custom_each_container_1"')
    .slice(1)
    .map((block) => ({
      id: (block.match(/\/books\/[^"]*?\/(\d+)[._]/) || [])[1] || '',
      title: text((block.match(/class="gr_custom_title_1">([\s\S]*?)<\/div>/) || [])[1]),
      author: text((block.match(/class="gr_custom_author_1">\s*by\s*([\s\S]*?)<\/div>/) || [])[1]),
    }))
    .filter((b) => b.title);
  if (!books.length) {
    throw new Error(
      'No books found. Check that your Goodreads profile is public and your “read” shelf isn’t empty, or upload your Goodreads export instead.',
    );
  }
  return { name, items: books };
}

// Letterboxd: the RSS feed only holds the most recent ~50 diary entries.
async function letterboxd(user) {
  if (!/^[A-Za-z0-9_]+$/.test(user || '')) throw new Error('Enter a valid Letterboxd username.');
  const xml = await fetchText(`https://letterboxd.com/${user}/rss/`);
  // Channel title looks like "Letterboxd - Katya".
  const name = tag(xml, 'title').replace(/^Letterboxd\s*[-–]\s*/, '');
  const films = items(xml)
    .filter((it) => it.includes('<letterboxd:filmTitle>'))
    .map((it) => ({
      title: tag(it, 'letterboxd:filmTitle'),
      year: tag(it, 'letterboxd:filmYear'),
      date: tag(it, 'letterboxd:watchedDate'),
      url: tag(it, 'link'),
    }));
  return { name, items: films };
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': MIME['.json'] });
  res.end(JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname === '/api/goodreads') return sendJson(res, 200, await goodreads(url.searchParams.get('user')));
    if (url.pathname === '/api/letterboxd') return sendJson(res, 200, await letterboxd(url.searchParams.get('user')));

    const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).slice(1);
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT + path.sep)) return sendJson(res, 403, { error: 'Forbidden' });
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  } catch (err) {
    if (err.code === 'ENOENT') return sendJson(res, 404, { error: 'Not found' });
    sendJson(res, url.pathname.startsWith('/api/') ? 502 : 500, { error: err.message });
  }
});

server.listen(PORT, () => console.log(`Read & Watch Map running at http://localhost:${PORT}`));
