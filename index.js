// weather-kin: Polls Open-Meteo for weather in Nanaimo, BC and updates
// Derek Stone's Current Setting on Kindroid with a natural language scene.
//
// Required env vars:
//   KINDROID_API_KEY  - Your Kindroid API key
//   KINDROID_AI_ID    - Derek's AI ID
//
// Runs every 6 hours. No weather API key needed (Open-Meteo is free).

const KINDROID_BASE = "https://api.kindroid.ai/v1";
const OPEN_METEO_URL =
  "https://api.open-meteo.com/v1/forecast" +
  "?latitude=49.16&longitude=-123.94" +
  "&current=temperature_2m,weather_code,wind_speed_10m" +
  "&temperature_unit=celsius&wind_speed_unit=kmh";

const INTERVAL_HOURS = 6;

// --- Config ---

function requiredEnv(name) {
  const val = process.env[name];
  if (!val) {
    console.error(`Missing required env var: ${name}`);
    process.exit(1);
  }
  return val;
}

const CONFIG = {
  kindroidKey: requiredEnv("KINDROID_API_KEY"),
  aiId: requiredEnv("KINDROID_AI_ID"),
};

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

function describeWind(kmh) {
  if (kmh < 15) return null;
  if (kmh < 30) return "There's a light breeze.";
  if (kmh < 50) return "It's windy outside.";
  return "It's really blustery out.";
}

// --- Weather ---

async function fetchWeather() {
  const res = await fetch(OPEN_METEO_URL, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) {
    throw new Error(`Open-Meteo ${res.status}: ${await res.text()}`);
  }
  return res.json();
}

function formatScene(data) {
  const current = data.current;
  const temp = Math.round(current.temperature_2m);
  const code = current.weather_code;
  const wind = current.wind_speed_10m;

  const conditions = WMO_CONDITIONS.get(code) || "unknown conditions";
  const windLine = describeWind(wind);

  let scene = `It's currently ${temp}°C and ${conditions} in Seabreak.`;
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

// Run immediately, then every 6 hours
tick();

const intervalMs = INTERVAL_HOURS * 60 * 60 * 1000;
console.log(`Scheduling every ${INTERVAL_HOURS}h (${intervalMs}ms)`);
setInterval(tick, intervalMs);
