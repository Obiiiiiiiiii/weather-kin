# weather-kin

Node.js service that polls Open-Meteo for weather and updates Kindroid AI Current Settings. Supports a web dashboard for managing multiple Kins.

## Structure

- `server.js` — dashboard HTTP server (API routes + static file serving + scheduler)
- `lib/weather.js` — weather fetching, WMO codes, transition system, Kindroid API calls
- `lib/db.js` — SQLite database layer (better-sqlite3) for multi-Kin configs and state
- `lib/scheduler.js` — per-Kin polling loop manager
- `public/` — dashboard frontend (plain HTML/CSS/JS, no build step)
  - `index.html` — single-page dashboard
  - `style.css` — dark theme styles
  - `app.js` — globe (Globe.gl), search (Nominatim), Kin CRUD
- `index.js` — legacy single-Kin mode (env-var driven, no dashboard)
- `.env.example` — template for environment variables

## Key details

- One npm dependency: `better-sqlite3` for embedded multi-Kin storage.
- Dashboard mode (`npm start` / `node server.js`): all config via web UI, supports multiple Kins.
- Legacy mode (`npm run start:legacy` / `node index.js`): single Kin via env vars, no dashboard.
- Weather codes follow the WMO standard; the mapping lives in `WMO_CONDITIONS` in `lib/weather.js`.
- The process runs indefinitely using chained `setTimeout` to hit specific wall-clock hours; it is not a one-shot script.
- Scheduling uses `updateHours` (e.g. `[0,6,12,18]`) — fixed times, not intervals. Each tick schedules the next.
- `forecastHour` is optional. When set, that hour's tick calls `formatForecast()` instead of `formatScene()`.
- `locationName` and `locationRegion` are optional. Current conditions fall back to "outside"; forecasts drop the location clause entirely.
- Wind thresholds adjust based on `windSpeedUnit` (km/h vs mph) — see `describeWind()` and `describeForecastWind()`.
- On fetch failure the last successful scene is retained — do not add logic to clear it.
- Optional `DASHBOARD_PASSWORD` env var protects the dashboard with Bearer token auth.
- Globe uses Globe.gl (CDN), location search uses Nominatim (OpenStreetMap, free, no key).
- The API never sends Kindroid API keys to the frontend — they're write-only.
