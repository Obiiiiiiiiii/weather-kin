# weather-kin

Single-file Node.js service (`index.js`) that polls Open-Meteo for weather and updates a Kindroid AI's Current Setting.

## Structure

- `index.js` — entire application (no dependencies beyond Node built-ins)
- `Dockerfile` — Alpine-based container image
- `.env.example` — template for required/optional environment variables

## Key details

- No npm dependencies — uses Node's built-in `fetch` (requires Node 18+).
- All configuration is via environment variables; see the `CONFIG` object at the top of `index.js`.
- Weather codes follow the WMO standard; the mapping lives in `WMO_CONDITIONS`.
- The process runs indefinitely via `setInterval`; it is not a one-shot script.
- On fetch failure the last successful scene is retained — do not add logic to clear it.
