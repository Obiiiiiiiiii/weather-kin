// weather-kin: Polls Open-Meteo for weather and updates a Kin's
// Current Setting on Kindroid with a natural language scene.
//
// Required env vars:
//   KINDROID_API_KEY    - Your Kindroid API key
//   KINDROID_AI_ID      - Kin's AI ID
//   LATITUDE            - Location latitude (e.g. 49.16)
//   LONGITUDE           - Location longitude (e.g. -123.94)
//
// Optional env vars:
//   LOCATION_NAME       - Display name for the location (e.g. "Seabreak")
//   LOCATION_REGION     - Region/state for seasonal context (e.g. "British Columbia")
//   TEMPERATURE_UNIT    - "celsius" or "fahrenheit" (default: celsius)
//   WIND_SPEED_UNIT     - "kmh" or "mph" (default: kmh)
//   UPDATE_HOURS        - Comma-separated hours to update (default: "0,6,12,18")
//
// No weather API key needed (Open-Meteo is free and requires no account).

const http = require("http");

const KINDROID_BASE = "https://api.kindroid.ai/v1";

// --- Config ---

function requiredEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

function optionalEnv(name, fallback) {
  return process.env[name] || fallback;
}

const CONFIG = {
  kindroidKey: requiredEnv("KINDROID_API_KEY"),
  aiId: requiredEnv("KINDROID_AI_ID"),
  locationName: optionalEnv("LOCATION_NAME", ""),
  latitude: requiredEnv("LATITUDE"),
  longitude: requiredEnv("LONGITUDE"),
  temperatureUnit: optionalEnv("TEMPERATURE_UNIT", "celsius"),
  windSpeedUnit: optionalEnv("WIND_SPEED_UNIT", "kmh"),
  locationRegion: optionalEnv("LOCATION_REGION", ""),
  updateHours: optionalEnv("UPDATE_HOURS", "0,6,12,18")
    .split(",")
    .map((h) => {
      const n = Number(h.trim());
      if (isNaN(n) || n < 0 || n > 23) {
        console.error(`Invalid hour in UPDATE_HOURS: "${h.trim()}"`);
        process.exit(1);
      }
      return n;
    })
    .sort((a, b) => a - b),
};

const OPEN_METEO_URL =
  "https://api.open-meteo.com/v1/forecast" +
  `?latitude=${CONFIG.latitude}&longitude=${CONFIG.longitude}` +
  "&current=temperature_2m,weather_code,wind_speed_10m" +
  `&temperature_unit=${CONFIG.temperatureUnit}&wind_speed_unit=${CONFIG.windSpeedUnit}`;

const TEMP_SYMBOL = CONFIG.temperatureUnit === "fahrenheit" ? "°F" : "°C";

// --- WMO Weather Code mapping ---

const WMO_CONDITIONS = new Map([
  [0, "clear"],
  [1, "mostly clear"],
  [2, "partly cloudy"],
  [3, "overcast"],
  [45, "foggy"],
  [48, "foggy"],
  [51, "drizzling"],
  [53, "drizzling"],
  [55, "drizzling"],
  [56, "freezing drizzle"],
  [58, "freezing drizzle"],
  [61, "rainy"],
  [63, "rainy"],
  [65, "rainy"],
  [66, "freezing rain"],
  [67, "freezing rain"],
  [71, "snowing"],
  [73, "snowing"],
  [75, "snowing"],
  [77, "snowing lightly"],
  [80, "showery"],
  [81, "showery"],
  [82, "showery"],
  [85, "snowing heavily"],
  [86, "snowing heavily"],
  [95, "thunderstorming"],
  [96, "thunderstorming with hail"],
  [99, "thunderstorming with hail"],
]);

function describeWind(speed) {
  const isKmh = CONFIG.windSpeedUnit === "kmh";
  const light = isKmh ? 15 : 9;
  const moderate = isKmh ? 30 : 19;
  const strong = isKmh ? 50 : 31;

  if (speed < light) return null;
  if (speed < moderate) return "There's a light breeze.";
  if (speed < strong) return "It's windy outside.";
  return "It's really blustery out.";
}

// --- Weather ---

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 10000;

async function fetchWeather() {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const res = await fetch(OPEN_METEO_URL, { signal: AbortSignal.timeout(15000) });
    if (res.ok) return res.json();

    const body = await res.text();
    if (attempt < MAX_RETRIES && res.status >= 500) {
      console.log(`Open-Meteo ${res.status}, retrying in ${RETRY_DELAY_MS / 1000}s (attempt ${attempt}/${MAX_RETRIES})...`);
      await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
      continue;
    }
    throw new Error(`Open-Meteo ${res.status}: ${body}`);
  }
}

function formatScene(data) {
  const current = data.current;
  const temp = Math.round(current.temperature_2m);
  const code = current.weather_code;
  const wind = current.wind_speed_10m;

  const conditions = WMO_CONDITIONS.get(code) || "unknown conditions";
  const windLine = describeWind(wind);

  const locationParts = [CONFIG.locationName, CONFIG.locationRegion].filter(Boolean);
  const locationSuffix = locationParts.length ? ` in ${locationParts.join(", ")}` : " here";
  let scene = `It's currently ${temp}${TEMP_SYMBOL} and ${conditions}${locationSuffix}.`;
  if (windLine) scene += ` ${windLine}`;

  return scene;
}

// --- Kindroid ---

async function updateCurrentScene(sceneText) {
  const res = await fetch(`${KINDROID_BASE}/update-info`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${CONFIG.kindroidKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ai_id: CONFIG.aiId,
      current_scene: sceneText,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`Kindroid API ${res.status}: ${await res.text()}`);
  }
}

// --- Scheduling ---

function msUntilNextUpdate() {
  const now = new Date();
  const candidates = CONFIG.updateHours.flatMap((h) => {
    const today = new Date(now);
    today.setHours(h, 0, 0, 0);
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);
    return [today, tomorrow];
  });
  const next = candidates
    .filter((t) => t > now)
    .sort((a, b) => a - b)[0];
  return { ms: next - now, time: next };
}

function scheduleNext() {
  const { ms, time } = msUntilNextUpdate();
  const hh = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  console.log(`Next update at ${hh} (in ${Math.round(ms / 60000)} min)`);
  setTimeout(async () => {
    await tick();
    scheduleNext();
  }, ms);
}

// --- Main loop ---

let lastScene = null;

async function tick() {
  const timestamp = new Date().toISOString();
  try {
    console.log(`[${timestamp}] Fetching weather...`);
    const data = await fetchWeather();
    lastScene = formatScene(data);
    console.log(`[${timestamp}] Scene: "${lastScene}"`);

    await updateCurrentScene(lastScene);
    console.log(`[${timestamp}] Kindroid updated.`);
  } catch (err) {
    console.error(`[${timestamp}] Error: ${err.message}`);
    if (lastScene) {
      console.log(`[${timestamp}] Retaining last scene: "${lastScene}"`);
    }
  }
}

// --- Health check server (keeps Railway happy) ---

const PORT = process.env.PORT || 3000;

http.createServer((req, res) => {
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({ status: "ok", lastScene }));
}).listen(PORT, () => {
  console.log(`Health check listening on port ${PORT}`);
});

// --- Start ---

console.log(`Update schedule: ${CONFIG.updateHours.map((h) => `${h}:00`).join(", ")}`);
tick();
scheduleNext();
