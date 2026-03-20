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
//   FORECAST_HOUR       - Hour (0-23) to send a daily forecast instead of current conditions
//
// No weather API key needed (Open-Meteo is free and requires no account).

const http = require("http");
const fs = require("fs");
const path = require("path");

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
  forecastHour: process.env.FORECAST_HOUR != null
    ? (() => {
        const n = Number(process.env.FORECAST_HOUR);
        if (isNaN(n) || n < 0 || n > 23) {
          console.error(`Invalid FORECAST_HOUR: "${process.env.FORECAST_HOUR}"`);
          process.exit(1);
        }
        return n;
      })()
    : null,
};

// Ensure FORECAST_HOUR is included in the update schedule
if (CONFIG.forecastHour != null && !CONFIG.updateHours.includes(CONFIG.forecastHour)) {
  CONFIG.updateHours.push(CONFIG.forecastHour);
  CONFIG.updateHours.sort((a, b) => a - b);
}

const OPEN_METEO_URL =
  "https://api.open-meteo.com/v1/forecast" +
  `?latitude=${CONFIG.latitude}&longitude=${CONFIG.longitude}` +
  "&current=temperature_2m,weather_code,wind_speed_10m" +
  (CONFIG.forecastHour != null
    ? "&daily=temperature_2m_max,temperature_2m_min,weather_code,wind_speed_10m_max&forecast_days=1"
    : "") +
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
  [57, "freezing drizzle"],
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

// --- Wind ---

function describeWind(speed) {
  const isKmh = CONFIG.windSpeedUnit === "kmh";
  const light = isKmh ? 15 : 9;
  const moderate = isKmh ? 30 : 19;
  const strong = isKmh ? 50 : 31;

  if (speed < light) return null;
  if (speed < moderate) return "with a light breeze";
  if (speed < strong) return "with strong winds";
  return "with heavy gusts";
}

const WIND_FORMS = new Map([
  ["with a light breeze", { label: "light breeze", bare: "a light breeze" }],
  ["with strong winds",   { label: "strong winds",  bare: "strong winds" }],
  ["with heavy gusts",    { label: "heavy gusts",   bare: "heavy gusts" }],
]);

function windLabel(windPart) {
  return WIND_FORMS.get(windPart)?.label ?? "null";
}

function bareWindLabel(windPart) {
  return WIND_FORMS.get(windPart)?.bare ?? null;
}

// --- Transition System: Layer 2 — Lateral moves ---

const LATERAL_TRANSITIONS = new Map([
  // Rain <-> Snow
  ["rainy->snowing", "The rain has turned to snow."],
  ["rainy->snowing heavily", "The rain has turned to heavy snow."],
  ["rainy->snowing lightly", "The rain has turned to light snow."],
  ["snowing->rainy", "The snow has turned to rain."],
  ["snowing heavily->rainy", "The snow has turned to rain."],
  ["snowing lightly->rainy", "The snow has turned to rain."],

  // Drizzle <-> Freezing drizzle
  ["drizzling->freezing drizzle", "The drizzle has turned to freezing drizzle."],
  ["freezing drizzle->drizzling", "The freezing drizzle has warmed up to regular drizzle."],

  // Rain <-> Freezing rain
  ["rainy->freezing rain", "The rain has turned to freezing rain."],
  ["freezing rain->rainy", "The freezing rain has warmed up to regular rain."],

  // Overcast <-> Fog
  ["overcast->foggy", "Fog is settling in."],
  ["foggy->overcast", "The fog is lifting."],

  // Rain <-> Showers
  ["rainy->showery", "The steady rain has broken up into showers."],
  ["showery->rainy", "The showers have settled into steady rain."],

  // Drizzle <-> Showers
  ["drizzling->showery", "The drizzle has picked up into showers."],
  ["showery->drizzling", "The showers have eased to a drizzle."],

  // Drizzle <-> Rain
  ["drizzling->rainy", "The drizzle has picked up into rain."],
  ["rainy->drizzling", "The rain has eased to a drizzle."],

  // Thunderstorm <-> Thunderstorm with hail
  ["thunderstorming->thunderstorming with hail", "Hail is now mixed in with the storm."],
  ["thunderstorming with hail->thunderstorming", "The hail has stopped but the storm continues."],

  // Snow intensity shifts
  ["snowing->snowing heavily", "The snow is getting heavier."],
  ["snowing heavily->snowing", "The heavy snow is easing up."],
  ["snowing lightly->snowing", "The snow is picking up."],
  ["snowing->snowing lightly", "The snow is tapering off."],
  ["snowing lightly->snowing heavily", "The snow is getting much heavier."],
  ["snowing heavily->snowing lightly", "The heavy snow is tapering off."],

  // Snow <-> Freezing precipitation
  ["snowing->freezing rain", "The snow has turned to freezing rain."],
  ["freezing rain->snowing", "The freezing rain has turned to snow."],
  ["snowing->freezing drizzle", "The snow has turned to freezing drizzle."],
  ["freezing drizzle->snowing", "The freezing drizzle has turned to snow."],

  // Rain <-> Fog
  ["rainy->foggy", "The rain has lifted; fog is settling in."],
  ["foggy->rainy", "The fog is lifting; rain is moving in."],

  // Fog <-> Drizzle
  ["foggy->drizzling", "The fog is turning to drizzle."],
  ["drizzling->foggy", "The drizzle has lifted; fog is settling in."],

  // Freezing drizzle <-> Freezing rain
  ["freezing drizzle->freezing rain", "The freezing drizzle is picking up to freezing rain."],
  ["freezing rain->freezing drizzle", "The freezing rain has eased to freezing drizzle."],

  // Showers <-> Snow
  ["showery->snowing", "The showers have turned to snow."],
  ["showery->snowing lightly", "The showers have turned to light snow."],
  ["showery->snowing heavily", "The showers have turned to heavy snow."],
  ["snowing->showery", "The snow has turned to showers."],
  ["snowing lightly->showery", "The snow has turned to showers."],
  ["snowing heavily->showery", "The snow has turned to showers."],

  // Showers <-> Freezing rain
  ["showery->freezing rain", "The showers have turned to freezing rain."],
  ["freezing rain->showery", "The freezing rain has turned to showers."],
]);

// --- Transition System: Layer 3 — Severity-ranked escalation/de-escalation ---

const SEVERITY_RANK = new Map([
  ["clear", 0],
  ["mostly clear", 1],
  ["partly cloudy", 2],
  ["overcast", 3],
  ["foggy", 4],
  ["drizzling", 5],
  ["freezing drizzle", 6],
  ["rainy", 7],
  ["freezing rain", 8],
  ["showery", 9],
  ["snowing lightly", 10],
  ["snowing", 11],
  ["snowing heavily", 12],
  ["thunderstorming", 13],
  ["thunderstorming with hail", 14],
]);

const SEVERITY_THRESHOLD = 3;

const ARRIVAL_PHRASES = new Map([
  ["clear", "The skies have cleared."],
  ["mostly clear", "The skies have mostly cleared."],
  ["partly cloudy", "The clouds are starting to break up."],
  ["overcast", "The skies have clouded over."],
  ["foggy", "Fog is rolling in."],
  ["drizzling", "It's started to drizzle."],
  ["freezing drizzle", "Freezing drizzle has moved in."],
  ["rainy", "Rain has moved in."],
  ["freezing rain", "Freezing rain has moved in."],
  ["showery", "Showers have moved in."],
  ["snowing lightly", "Light snow has started falling."],
  ["snowing", "It's started to snow."],
  ["snowing heavily", "Heavy snow has moved in."],
  ["thunderstorming", "A thunderstorm has rolled in."],
  ["thunderstorming with hail", "A thunderstorm with hail has rolled in."],
]);

const DEPARTURE_PHRASES = new Map([
  ["clear", "The skies have cleared."],
  ["mostly clear", "The skies are clearing."],
  ["partly cloudy", "Things are starting to clear up."],
  ["overcast", "The skies have clouded over, but the precipitation has stopped."],
  ["foggy", "The fog is lifting."],
  ["drizzling", "The drizzle has let up."],
  ["freezing drizzle", "The freezing drizzle has let up."],
  ["rainy", "The rain has stopped."],
  ["freezing rain", "The freezing rain has stopped."],
  ["showery", "The showers have passed."],
  ["snowing lightly", "The snow has tapered off."],
  ["snowing", "The snow has stopped."],
  ["snowing heavily", "The heavy snow has stopped."],
  ["thunderstorming", "The storm has passed."],
  ["thunderstorming with hail", "The storm has passed."],
]);

// --- Wind Transition System ---

const WIND_ESCALATION = new Map([
  ["null->light breeze", "A breeze has picked up."],
  ["null->strong winds", "Strong winds have picked up."],
  ["null->heavy gusts", "Heavy gusts have rolled in."],
  ["light breeze->strong winds", "The winds are getting stronger."],
  ["light breeze->heavy gusts", "Heavy gusts have rolled in."],
  ["strong winds->heavy gusts", "The winds are picking up to heavy gusts."],
]);

const WIND_DEESCALATION = new Map([
  ["light breeze->null", "The breeze has settled."],
  ["strong winds->null", "The strong winds have died down."],
  ["strong winds->light breeze", "The strong winds have eased up."],
  ["heavy gusts->null", "The heavy gusts have died down."],
  ["heavy gusts->light breeze", "The heavy gusts have eased up."],
  ["heavy gusts->strong winds", "The heavy gusts have let up."],
]);

// --- Merged Transition Phrases (same-direction condition + wind) ---

const MERGED_ESCALATION = new Map([
  ["overcast", "Overcast skies and {wind} have moved in."],
  ["foggy", "Fog and {wind} have rolled in."],
  ["drizzling", "Drizzle and {wind} have set in."],
  ["freezing drizzle", "Freezing drizzle and {wind} have moved in."],
  ["rainy", "Rain and {wind} have moved in."],
  ["freezing rain", "Freezing rain and {wind} have moved in."],
  ["showery", "Showers and {wind} have moved in."],
  ["snowing lightly", "Light snow and {wind} have moved in."],
  ["snowing", "Snow and {wind} have moved in."],
  ["snowing heavily", "Heavy snow and {wind} have moved in."],
  ["thunderstorming", "A thunderstorm and {wind} have rolled in."],
  ["thunderstorming with hail", "A thunderstorm with hail and {wind} have rolled in."],
]);

const MERGED_DEESCALATION = new Map([
  ["drizzling", "The drizzle and {wind} have let up."],
  ["freezing drizzle", "The freezing drizzle and {wind} have let up."],
  ["rainy", "The rain and {wind} have let up."],
  ["freezing rain", "The freezing rain and {wind} have let up."],
  ["showery", "The showers and {wind} have let up."],
  ["snowing lightly", "The light snow and {wind} have let up."],
  ["snowing", "The snow and {wind} have let up."],
  ["snowing heavily", "The heavy snow and {wind} have let up."],
  ["thunderstorming", "The storm and {wind} have passed."],
  ["thunderstorming with hail", "The storm and {wind} have passed."],
  ["foggy", "The fog and {wind} have let up."],
  ["overcast", "The overcast skies and {wind} have let up."],
]);

// --- Transition helpers ---

function stripPeriod(s) {
  return s.endsWith(".") ? s.slice(0, -1) : s;
}

function lowercaseFirst(s) {
  return s.charAt(0).toLowerCase() + s.slice(1);
}

// --- Weather ---

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 10000;

async function fetchWeather() {
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(OPEN_METEO_URL, { signal: AbortSignal.timeout(15000) });
      if (res.ok) return res.json();

      const body = await res.text();
      if (attempt < MAX_RETRIES && res.status >= 500) {
        console.log(`Open-Meteo ${res.status}, retrying in ${RETRY_DELAY_MS / 1000}s (attempt ${attempt}/${MAX_RETRIES})...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw new Error(`Open-Meteo ${res.status}: ${body}`);
    } catch (err) {
      if (attempt < MAX_RETRIES) {
        console.log(`Fetch error: ${err.message}, retrying in ${RETRY_DELAY_MS / 1000}s (attempt ${attempt}/${MAX_RETRIES})...`);
        await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      throw err;
    }
  }
}

function buildLocationParts() {
  return [CONFIG.locationName, CONFIG.locationRegion].filter(Boolean);
}

// --- State persistence ---
// Saves transition state to disk so restarts don't lose context.

const STATE_DIR = fs.existsSync("/app/data") ? "/app/data" : __dirname;
const STATE_FILE = path.join(STATE_DIR, ".weather-state.json");

function loadState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, "utf-8");
    const saved = JSON.parse(raw);
    console.log("Restored state from disk.");
    return {
      lastCondition: saved.lastCondition ?? UNSET,
      lastWindDescription: saved.lastWindDescription === undefined ? UNSET : saved.lastWindDescription,
      lastScene: saved.lastScene ?? null,
    };
  } catch {
    return { lastCondition: UNSET, lastWindDescription: UNSET, lastScene: null };
  }
}

function saveState() {
  const data = {
    lastCondition: lastCondition === UNSET ? undefined : lastCondition,
    lastWindDescription: lastWindDescription === UNSET ? undefined : lastWindDescription,
    lastScene,
    savedAt: new Date().toISOString(),
  };
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify(data), "utf-8");
  } catch (err) {
    console.error(`Failed to save state: ${err.message}`);
  }
}

// --- Transition state (persists between ticks) ---
// UNSET distinguishes "never observed" from "observed as null (calm)".

const UNSET = Symbol("unset");
const restored = loadState();
let lastCondition = restored.lastCondition;
let lastWindDescription = restored.lastWindDescription;

// --- Scene formatting with transitions ---

function formatScene(data) {
  const current = data.current;
  const temp = Math.round(current.temperature_2m);
  const code = current.weather_code;
  const wind = current.wind_speed_10m;

  const conditions = WMO_CONDITIONS.get(code) || "unknown conditions";
  const windPart = describeWind(wind);

  const location = buildLocationParts();
  const locationSuffix = location.length ? ` here in ${location.join(", ")}` : " outside";

  const currentWindLabel = windLabel(windPart);
  const lastWindLabel = windLabel(lastWindDescription);

  const conditionChanged = lastCondition !== UNSET && lastCondition !== conditions;
  const windChanged = lastWindDescription !== UNSET && lastWindLabel !== currentWindLabel;

  // --- Determine condition transition type and phrase ---
  let conditionTransition = null;
  let conditionDirection = null;

  if (conditionChanged) {
    const lateralKey = `${lastCondition}->${conditions}`;
    if (LATERAL_TRANSITIONS.has(lateralKey)) {
      conditionTransition = LATERAL_TRANSITIONS.get(lateralKey);
      conditionDirection = "lateral";
    } else {
      const oldRank = SEVERITY_RANK.get(lastCondition);
      const newRank = SEVERITY_RANK.get(conditions);
      if (oldRank != null && newRank != null && Math.abs(newRank - oldRank) >= SEVERITY_THRESHOLD) {
        if (newRank > oldRank) {
          conditionTransition = ARRIVAL_PHRASES.get(conditions);
          conditionDirection = "escalation";
        } else {
          conditionTransition = DEPARTURE_PHRASES.get(lastCondition);
          conditionDirection = "deescalation";
        }
      }
    }
  }

  // --- Determine wind transition type and phrase ---
  let windTransition = null;
  let windDirection = null;

  if (windChanged) {
    const windKey = `${lastWindLabel}->${currentWindLabel}`;
    if (WIND_ESCALATION.has(windKey)) {
      windTransition = WIND_ESCALATION.get(windKey);
      windDirection = "escalation";
    } else if (WIND_DEESCALATION.has(windKey)) {
      windTransition = WIND_DEESCALATION.get(windKey);
      windDirection = "deescalation";
    }
  }

  let scene;

  // --- Handle dual transitions (both condition and wind changed) ---
  if (conditionTransition && windTransition) {
    const sameDirection =
      (conditionDirection === "escalation" && windDirection === "escalation") ||
      (conditionDirection === "deescalation" && windDirection === "deescalation");

    if (sameDirection && conditionDirection === "escalation") {
      // Same-direction escalation: merged template, drop both from base
      const template = MERGED_ESCALATION.get(conditions);
      if (template) {
        const mergedPhrase = template.replace("{wind}", bareWindLabel(windPart));
        scene = `It's currently ${temp}${TEMP_SYMBOL}${locationSuffix}. ${mergedPhrase}`;
      }
    }

    if (!scene && sameDirection && conditionDirection === "deescalation") {
      // Same-direction de-escalation: merged template, keep both in base
      const template = MERGED_DEESCALATION.get(lastCondition);
      if (template) {
        const mergedPhrase = template.replace("{wind}", bareWindLabel(lastWindDescription));
        const windInBase = windPart ? `, ${windPart}` : "";
        scene = `It's currently ${temp}${TEMP_SYMBOL} and ${conditions}${locationSuffix}${windInBase}. ${mergedPhrase}`;
      }
    }

    if (!scene && conditionDirection === "lateral") {
      // Lateral + wind: period-join (laterals may already contain semicolons)
      // Drop wind from base on escalation (transition announces it);
      // keep wind in base on de-escalation (transition describes what left).
      const windInBase = windDirection === "deescalation" && windPart ? `, ${windPart}` : "";
      scene = `It's currently ${temp}${TEMP_SYMBOL}${locationSuffix}${windInBase}. ${conditionTransition} ${windTransition}`;
    }

    if (!scene) {
      // Cross-direction: semicolon-join
      const includeConditionInBase = conditionDirection === "deescalation";
      const includeWindInBase = windDirection === "deescalation";
      const effectiveWindPart = includeWindInBase && windPart ? `, ${windPart}` : "";

      if (includeConditionInBase) {
        scene = `It's currently ${temp}${TEMP_SYMBOL} and ${conditions}${locationSuffix}${effectiveWindPart}.`;
      } else {
        scene = `It's currently ${temp}${TEMP_SYMBOL}${locationSuffix}${effectiveWindPart}.`;
      }

      const joined = stripPeriod(conditionTransition) + "; " + lowercaseFirst(stripPeriod(windTransition)) + ".";
      scene += ` ${joined}`;
    }
  }

  // --- Handle condition-only transition ---
  else if (conditionTransition && !windTransition) {
    const windInBase = windPart ? `, ${windPart}` : "";

    if (conditionDirection === "escalation") {
      // Arrival: drop condition from base
      scene = `It's currently ${temp}${TEMP_SYMBOL}${locationSuffix}${windInBase}. ${conditionTransition}`;
    } else if (conditionDirection === "deescalation") {
      // Departure: keep condition in base
      scene = `It's currently ${temp}${TEMP_SYMBOL} and ${conditions}${locationSuffix}${windInBase}. ${conditionTransition}`;
    } else if (conditionDirection === "lateral") {
      // Lateral: drop condition from base
      scene = `It's currently ${temp}${TEMP_SYMBOL}${locationSuffix}${windInBase}. ${conditionTransition}`;
    }
  }

  // --- Handle wind-only transition ---
  else if (windTransition && !conditionTransition) {
    if (windDirection === "escalation") {
      // Drop wind from base
      scene = `It's currently ${temp}${TEMP_SYMBOL} and ${conditions}${locationSuffix}. ${windTransition}`;
    } else {
      // Keep wind in base
      const windInBase = windPart ? `, ${windPart}` : "";
      scene = `It's currently ${temp}${TEMP_SYMBOL} and ${conditions}${locationSuffix}${windInBase}. ${windTransition}`;
    }
  }

  // --- No transitions (steady state or cold start) ---
  if (!scene) {
    scene = `It's currently ${temp}${TEMP_SYMBOL} and ${conditions}${locationSuffix}${windPart ? `, ${windPart}` : ""}.`;
  }

  // --- Update state ---
  lastCondition = conditions;
  lastWindDescription = windPart;

  return scene;
}

// --- Forecast ---

function describeForecastWind(maxSpeed) {
  const isKmh = CONFIG.windSpeedUnit === "kmh";
  const moderate = isKmh ? 30 : 19;
  const strong = isKmh ? 50 : 31;

  if (maxSpeed < moderate) return null;
  if (maxSpeed < strong) return "It's expected to be windy.";
  return "Strong winds are expected.";
}

function formatForecast(data) {
  const daily = data.daily;
  const high = Math.round(daily.temperature_2m_max[0]);
  const low = Math.round(daily.temperature_2m_min[0]);
  const code = daily.weather_code[0];
  const maxWind = daily.wind_speed_10m_max[0];

  const conditions = WMO_CONDITIONS.get(code) || "unknown conditions";
  const windLine = describeForecastWind(maxWind);

  const location = buildLocationParts();
  const locationSuffix = location.length ? ` for ${location.join(", ")}` : "";
  let scene = `Today's weather forecast${locationSuffix}: a high of ${high}${TEMP_SYMBOL} and a low of ${low}${TEMP_SYMBOL}, ${conditions}.`;
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
    try {
      await tick();
    } catch (err) {
      console.error(`Unexpected tick error: ${err.message}`);
    }
    scheduleNext();
  }, ms);
}

// --- Main loop ---

let lastScene = restored.lastScene;

async function tick() {
  const timestamp = new Date().toISOString();
  try {
    const isForecastTick =
      CONFIG.forecastHour != null && new Date().getHours() === CONFIG.forecastHour;
    console.log(`[${timestamp}] Fetching weather${isForecastTick ? " (forecast)" : ""}...`);
    const data = await fetchWeather();
    lastScene = isForecastTick ? formatForecast(data) : formatScene(data);
    console.log(`[${timestamp}] Scene: "${lastScene}"`);

    await updateCurrentScene(lastScene);
    saveState();
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
