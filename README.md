# Read & Watch Map

A browser app that shows where the books you've read (Goodreads) and the films you've watched (Letterboxd) come from, on a world map.

- **Show:** Books / Films / Both
- **Map by:** *Origin* (author's country, or a film's production countries), *Author / director* (author's country, or every citizenship and country of birth of a film's directors) or *Setting* (where the story takes place)
- Hover a country to preview titles, click it to list them all. Scroll or pinch to zoom.

## Run it

Requires Node 18 or newer. There are no dependencies to install.

```sh
npm start        # → http://localhost:8080  (PORT=3000 npm start to change)
```

## Getting your data in

| Source | Automatic (username) | Full history (file) |
|---|---|---|
| Goodreads | User ID or profile URL: fetches the 100 books most recently added to your "read" shelf via the public shelf widget (Goodreads retired its RSS feeds in late October 2026). The profile must be public. | *My Books → Import and export → Export Library* → drop the `.csv` |
| Letterboxd | Username: fetches only the ~50 most recent diary entries (an RSS limit). | *Settings → Data → Export your data* → drop the `.zip` |

Imports are merged and de-duplicated, so you can sync again later to add new entries.

## How countries are found

| | Origin | Author / director | Setting |
|---|---|---|---|
| Books | Every citizenship of the author on Wikidata plus the present-day country of their birthplace | Same as Origin | Wikidata "narrative location"; falls back to Open Library subject places |
| Films | Wikidata "country of origin" | Every director's citizenships plus country of birth | Wikidata "narrative location" |

A title can count for several countries. Anything not found appears under **Not located**, where you can assign a country by hand. Results are cached in `localStorage`, so repeat visits are instant.

## Files

- `server.js`: static file server plus a small RSS proxy (browsers can't fetch Goodreads/Letterboxd feeds directly because of CORS)
- `public/js/importers.js`: CSV/ZIP parsing and sync
- `public/js/enrich.js`: Wikidata and Open Library lookups
- `public/js/map.js`: D3 choropleth
- `public/js/app.js`: UI state, filters and rendering
