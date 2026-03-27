# weather-kin

Single-file Node.js service (`index.js`) that polls Open-Meteo for weather and updates a Kindroid AI's Current Setting.

## Structure

- `index.js` — entire application (no dependencies beyond Node built-ins)
- `.env.example` — template for required/optional environment variables

## Key details

- No npm dependencies — uses Node's built-in `fetch` and `http` (requires Node 18+).
- All configuration is via environment variables; see the `CONFIG` object at the top of `index.js`.
- Weather codes follow the WMO standard; the mapping lives in `WMO_CONDITIONS`.
- The process runs indefinitely using chained `setTimeout` to hit specific wall-clock hours; it is not a one-shot script.
- Scheduling uses `UPDATE_HOURS` (e.g. `"0,6,12,18"`) — fixed times, not intervals. Each tick schedules the next.
- `FORECAST_HOUR` is optional. When set, that hour's tick calls `formatForecast()` (daily high/low/conditions/wind) instead of `formatScene()` (current conditions). All other hours use `formatScene()`.
- `LOCATION_NAME` and `LOCATION_REGION` are optional. Current conditions fall back to "outside"; forecasts drop the location clause entirely.
- Wind thresholds adjust based on `WIND_SPEED_UNIT` (km/h vs mph) — see `describeWind()` and `describeForecastWind()`.
- A minimal HTTP health check server keeps Railway from killing the process.
- On fetch failure the last successful scene is retained — do not add logic to clear it.
