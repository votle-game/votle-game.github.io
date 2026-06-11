# Votle

Guess which countries voted against UN General Assembly resolutions. Pick a difficulty, era, and topic, then click your way around an interactive world map – with optional geography, religion, and language hints to narrow it down.

## What's included

```
votle/
  site/             - static frontend (GitHub Pages)
    index.html
    style.css
    config.js       - points the frontend at your Worker URL
    geo.js          - lightweight TopoJSON renderer
    app.js
    data/
      resolutions.json    - 4,399 UNGA resolutions with per-country votes
      country_meta.json   - region/religion/language for hints
      countries-50m.json  - world map (TopoJSON, alpha-2 country ids)
  worker/           - Cloudflare Worker backend (accounts + stats)
    worker.js
    schema.sql
```

Vote data is derived from the `unvotes` dataset (Voeten et al., via Harvard Dataverse / dgrtwo's GitHub mirror). The world map is from `world-atlas` (50m resolution), re-keyed to alpha-2 country codes. Flags are loaded at runtime from flagcdn.com.

## 1. Deploy the frontend (GitHub Pages)

1. Create a new repo (or a `votle` folder in an existing Pages-enabled repo), e.g. `sb-vault/votle`.
2. Push the contents of `site/` to the repo root (or to the relevant subfolder).
3. Enable GitHub Pages for the repo (Settings → Pages → Deploy from branch).
4. The site will be live at `https://sb-vault.github.io/votle/` (or your chosen path).

No build step is required – it's plain HTML/CSS/JS.

## 2. Deploy the backend (Cloudflare Worker + D1)

Accounts and stats are optional – the game works fully without signing in. Sign-in just persists results so the stats dashboard has data to show.

### Create the D1 database

In the Cloudflare dashboard:

1. **Workers & Pages → D1 → Create database**, name it `votle` (or similar).
2. Open the new database → **Console**, paste the contents of `worker/schema.sql`, and run it. This creates the `users` and `results` tables.

### Create a KV namespace

1. **Workers & Pages → KV → Create namespace**, name it `VOTLE_SESSIONS` (or similar). This stores login session tokens.

### Create the Worker

1. **Workers & Pages → Create → Worker**, name it `votle` (so it deploys to `votle.<your-subdomain>.workers.dev`).
2. Open the Worker → **Edit code**, delete the placeholder, and paste the contents of `worker/worker.js`.
3. Go to **Settings → Variables and Bindings**:
   - Add a **D1 database binding**: variable name `DB`, select the `votle` database you created.
   - Add a **KV namespace binding**: variable name `KV`, select the `VOTLE_SESSIONS` namespace.
4. **Save and Deploy**.

### Connect the frontend to the Worker

Edit `site/config.js` and set `WORKER_URL` to your deployed Worker's URL, e.g.:

```js
const VOTLE_CONFIG = {
  WORKER_URL: 'https://votle.lucas-alexander-pilu.workers.dev',
  DATA_BASE: 'data',
};
```

Re-deploy the frontend (push the change) and accounts/stats should work.

## Worker API reference

| Endpoint    | Method | Auth | Body / Notes |
|-------------|--------|------|---------------|
| `/register` | POST   | –    | `{ username, password }` -> `{ token, username }` |
| `/login`    | POST   | –    | `{ username, password }` -> `{ token, username }` |
| `/result`   | POST   | Bearer token | Game result payload -> `{ ok: true }` |
| `/stats`    | GET    | Bearer token | -> aggregated stats (games played, win rate, streaks, breakdowns by difficulty/era/topic) |

Passwords are hashed with PBKDF2-SHA256 (100,000 iterations) before storage. Session tokens are random 256-bit values stored in KV with a 90-day TTL.

## Updating data

The dataset and map are static JSON files in `site/data/`. To refresh them, re-run `build_meta.py` (regenerates `country_meta.json`) or re-fetch the source `unvotes` dataset and re-export `resolutions.json` in the same shape:

```json
{
  "id": "RCID",
  "date": "YYYY-MM-DD",
  "title": "Resolution number",
  "short": "Short title",
  "descr": "Description",
  "issues": ["Issue category", "..."],
  "votes": { "US": 1, "GB": 1, "RU": 0 }
}
```

Vote codes: `0` = no, `1` = yes, `2` = abstain. Countries absent from `votes` for a given resolution are treated as absent/non-voting.
