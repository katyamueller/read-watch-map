# Read & Watch Map

A browser app that shows where the books you've read (Goodreads) and the films you've watched (Letterboxd) come from, on a world map.

- **Show:** Books / Films / Both
- **Map by:** *Author / origin* (author's country, or a film's production country) or *Setting* (where the story takes place)
- Hover a country to preview titles, click it to list them all. Scroll or pinch to zoom.

## Run it

Requires Node 18 or newer. There are no dependencies to install.

```sh
npm start        # → http://localhost:8080  (PORT=3000 npm start to change)
```

## Getting your data in

| Source | Automatic (username) | Full history (file) |
|---|---|---|
| Goodreads | User ID or profile URL: fetches your whole "read" shelf via RSS. The profile must be public. | *My Books → Import and export → Export Library* → drop the `.csv` |
| Letterboxd | Username: fetches only the ~50 most recent diary entries (an RSS limit). | *Settings → Data → Export your data* → drop the `.zip` |

Imports are merged and de-duplicated, so you can sync again later to add new entries.

## How countries are found

| | Author / origin | Setting |
|---|---|---|
| Books | Author's citizenship on Wikidata; falls back to birthplace's present-day country for historical states | Wikidata "narrative location"; falls back to Open Library subject places |
| Films | Wikidata "country of origin" | Wikidata "narrative location" |

A title can count for several countries. Anything not found appears under **Not located**, where you can assign a country by hand. Results are cached in `localStorage`, so repeat visits are instant.

## Files

- `server.js`: static file server plus a small RSS proxy (browsers can't fetch Goodreads/Letterboxd feeds directly because of CORS)
- `public/js/importers.js`: CSV/ZIP parsing and sync
- `public/js/enrich.js`: Wikidata and Open Library lookups
- `public/js/map.js`: D3 choropleth
- `public/js/app.js`: UI state, filters and rendering
