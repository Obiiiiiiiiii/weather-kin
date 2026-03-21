// weather.js — Weather fetching, formatting, and transition logic.
// Extracted from index.js to support multi-Kin configurations.
// All functions accept a config object instead of reading globals.

const KINDROID_BASE = "https://api.kindroid.ai/v1";

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

function describeWind(speed, windSpeedUnit) {
  const isKmh = windSpeedUnit === "kmh";
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
  ["rainy->snowing", "The rain has turned to snow."],
  ["rainy->snowing heavily", "The rain has turned to heavy snow."],
  ["rainy->snowing lightly", "The rain has turned to light snow."],
  ["snowing->rainy", "The snow has turned to rain."],
  ["snowing heavily->rainy", "The snow has turned to rain."],
  ["snowing lightly->rainy", "The snow has turned to rain."],
  ["drizzling->freezing drizzle", "The drizzle has turned to freezing drizzle."],
  ["freezing drizzle->drizzling", "The freezing drizzle has warmed up to regular drizzle."],
  ["rainy->freezing rain", "The rain has turned to freezing rain."],
  ["freezing rain->rainy", "The freezing rain has warmed up to regular rain."],
  ["overcast->foggy", "Fog is settling in."],
  ["foggy->overcast", "The fog is lifting."],
  ["rainy->showery", "The steady rain has broken up into showers."],
  ["showery->rainy", "The showers have settled into steady rain."],
  ["drizzling->showery", "The drizzle has picked up into showers."],
  ["showery->drizzling", "The showers have eased to a drizzle."],
  ["drizzling->rainy", "The drizzle has picked up into rain."],
  ["rainy->drizzling", "The rain has eased to a drizzle."],
  ["thunderstorming->thunderstorming with hail", "Hail is now mixed in with the storm."],
  ["thunderstorming with hail->thunderstorming", "The hail has stopped but the storm continues."],
  ["snowing->snowing heavily", "The snow is getting heavier."],
  ["snowing heavily->snowing", "The heavy snow is easing up."],
  ["snowing lightly->snowing", "The snow is picking up."],
  ["snowing->snowing lightly", "The snow is tapering off."],
  ["snowing lightly->snowing heavily", "The snow is getting much heavier."],
  ["snowing heavily->snowing lightly", "The heavy snow is tapering off."],
  ["snowing->freezing rain", "The snow has turned to freezing rain."],
  ["freezing rain->snowing", "The freezing rain has turned to snow."],
  ["snowing->freezing drizzle", "The snow has turned to freezing drizzle."],
  ["freezing drizzle->snowing", "The freezing drizzle has turned to snow."],
  ["rainy->foggy", "The rain has lifted; fog is settling in."],
  ["foggy->rainy", "The fog is lifting; rain is moving in."],
  ["foggy->drizzling", "The fog is turning to drizzle."],
  ["drizzling->foggy", "The drizzle has lifted; fog is settling in."],
  ["freezing drizzle->freezing rain", "The freezing drizzle is picking up to freezing rain."],
  ["freezing rain->freezing drizzle", "The freezing rain has eased to freezing drizzle."],
  ["showery->snowing", "The showers have turned to snow."],
  ["showery->snowing lightly", "The showers have turned to light snow."],
  ["showery->snowing heavily", "The showers have turned to heavy snow."],
  ["snowing->showery", "The snow has turned to showers."],
  ["snowing lightly->showery", "The snow has turned to showers."],
  ["snowing heavily->showery", "The snow has turned to showers."],
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
  ["overcast", "The skies have cleared up."],
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

// --- Merged Transition Phrases ---

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

// --- Build Open-Meteo URL ---

function buildMeteoUrl(config) {
  return (
    "https://api.open-meteo.com/v1/forecast" +
    `?latitude=${config.latitude}&longitude=${config.longitude}` +
    "&current=temperature_2m,weather_code,wind_speed_10m" +
    (config.forecastHour != null
      ? "&daily=temperature_2m_max,temperature_2m_min,weather_code,wind_speed_10m_max&forecast_days=1"
      : "") +
    `&temperature_unit=${config.temperatureUnit}&wind_speed_unit=${config.windSpeedUnit}`
  );
}

// --- Weather fetching ---

const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 10000;

async function fetchWeather(config) {
  const url = buildMeteoUrl(config);
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
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

// --- Scene formatting with transitions ---
// `state` is a mutable object { lastCondition, lastWindDescription, lastScene }
// that persists between ticks for a given Kin.

const UNSET = Symbol("unset");

function formatScene(data, config, state) {
  const current = data.current;
  const temp = Math.round(current.temperature_2m);
  const code = current.weather_code;
  const wind = current.wind_speed_10m;
  const tempSymbol = config.temperatureUnit === "fahrenheit" ? "°F" : "°C";

  const conditions = WMO_CONDITIONS.get(code) || "unknown conditions";
  const windPart = describeWind(wind, config.windSpeedUnit);

  const location = [config.locationName, config.locationRegion].filter(Boolean);
  const locationSuffix = location.length ? ` here in ${location.join(", ")}` : " outside";

  const currentWindLbl = windLabel(windPart);
  const lastWindLbl = windLabel(state.lastWindDescription);

  const conditionChanged = state.lastCondition !== UNSET && state.lastCondition !== conditions;
  const windChanged = state.lastWindDescription !== UNSET && lastWindLbl !== currentWindLbl;

  let conditionTransition = null;
  let conditionDirection = null;

  if (conditionChanged) {
    const lateralKey = `${state.lastCondition}->${conditions}`;
    if (LATERAL_TRANSITIONS.has(lateralKey)) {
      conditionTransition = LATERAL_TRANSITIONS.get(lateralKey);
      conditionDirection = "lateral";
    } else {
      const oldRank = SEVERITY_RANK.get(state.lastCondition);
      const newRank = SEVERITY_RANK.get(conditions);
      if (oldRank != null && newRank != null && Math.abs(newRank - oldRank) >= SEVERITY_THRESHOLD) {
        if (newRank > oldRank) {
          conditionTransition = ARRIVAL_PHRASES.get(conditions);
          conditionDirection = "escalation";
        } else {
          conditionTransition = DEPARTURE_PHRASES.get(state.lastCondition);
          conditionDirection = "deescalation";
        }
      }
    }
  }

  let windTransition = null;
  let windDirection = null;

  if (windChanged) {
    const windKey = `${lastWindLbl}->${currentWindLbl}`;
    if (WIND_ESCALATION.has(windKey)) {
      windTransition = WIND_ESCALATION.get(windKey);
      windDirection = "escalation";
    } else if (WIND_DEESCALATION.has(windKey)) {
      windTransition = WIND_DEESCALATION.get(windKey);
      windDirection = "deescalation";
    }
  }

  let scene;

  if (conditionTransition && windTransition) {
    const sameDirection =
      (conditionDirection === "escalation" && windDirection === "escalation") ||
      (conditionDirection === "deescalation" && windDirection === "deescalation");

    if (sameDirection && conditionDirection === "escalation") {
      const template = MERGED_ESCALATION.get(conditions);
      if (template) {
        const mergedPhrase = template.replace("{wind}", bareWindLabel(windPart));
        scene = `It's currently ${temp}${tempSymbol}${locationSuffix}. ${mergedPhrase}`;
      }
    }

    if (!scene && sameDirection && conditionDirection === "deescalation") {
      const template = MERGED_DEESCALATION.get(state.lastCondition);
      if (template) {
        const mergedPhrase = template.replace("{wind}", bareWindLabel(state.lastWindDescription));
        const windInBase = windPart ? `, ${windPart}` : "";
        scene = `It's currently ${temp}${tempSymbol} and ${conditions}${locationSuffix}${windInBase}. ${mergedPhrase}`;
      }
    }

    if (!scene && conditionDirection === "lateral") {
      const windInBase = windDirection === "deescalation" && windPart ? `, ${windPart}` : "";
      scene = `It's currently ${temp}${tempSymbol}${locationSuffix}${windInBase}. ${conditionTransition} ${windTransition}`;
    }

    if (!scene) {
      const includeConditionInBase = conditionDirection === "deescalation" && state.lastCondition !== "overcast";
      const includeWindInBase = windDirection === "deescalation";
      const effectiveWindPart = includeWindInBase && windPart ? `, ${windPart}` : "";

      if (includeConditionInBase) {
        scene = `It's currently ${temp}${tempSymbol} and ${conditions}${locationSuffix}${effectiveWindPart}.`;
      } else {
        scene = `It's currently ${temp}${tempSymbol}${locationSuffix}${effectiveWindPart}.`;
      }

      const joined = stripPeriod(conditionTransition) + "; " + lowercaseFirst(stripPeriod(windTransition)) + ".";
      scene += ` ${joined}`;
    }
  } else if (conditionTransition && !windTransition) {
    const windInBase = windPart ? `, ${windPart}` : "";

    if (conditionDirection === "escalation") {
      scene = `It's currently ${temp}${tempSymbol}${locationSuffix}${windInBase}. ${conditionTransition}`;
    } else if (conditionDirection === "deescalation") {
      if (state.lastCondition === "overcast") {
        scene = `It's currently ${temp}${tempSymbol}${locationSuffix}${windInBase}. ${conditionTransition}`;
      } else {
        scene = `It's currently ${temp}${tempSymbol} and ${conditions}${locationSuffix}${windInBase}. ${conditionTransition}`;
      }
    } else if (conditionDirection === "lateral") {
      scene = `It's currently ${temp}${tempSymbol}${locationSuffix}${windInBase}. ${conditionTransition}`;
    }
  } else if (windTransition && !conditionTransition) {
    if (windDirection === "escalation") {
      scene = `It's currently ${temp}${tempSymbol} and ${conditions}${locationSuffix}. ${windTransition}`;
    } else {
      const windInBase = windPart ? `, ${windPart}` : "";
      scene = `It's currently ${temp}${tempSymbol} and ${conditions}${locationSuffix}${windInBase}. ${windTransition}`;
    }
  }

  if (!scene) {
    scene = `It's currently ${temp}${tempSymbol} and ${conditions}${locationSuffix}${windPart ? `, ${windPart}` : ""}.`;
  }

  state.lastCondition = conditions;
  state.lastWindDescription = windPart;

  return scene;
}

// --- Forecast ---

function describeForecastWind(maxSpeed, windSpeedUnit) {
  const isKmh = windSpeedUnit === "kmh";
  const moderate = isKmh ? 30 : 19;
  const strong = isKmh ? 50 : 31;

  if (maxSpeed < moderate) return null;
  if (maxSpeed < strong) return "It's expected to be windy.";
  return "Strong winds are expected.";
}

function formatForecast(data, config) {
  const daily = data.daily;
  const high = Math.round(daily.temperature_2m_max[0]);
  const low = Math.round(daily.temperature_2m_min[0]);
  const code = daily.weather_code[0];
  const maxWind = daily.wind_speed_10m_max[0];
  const tempSymbol = config.temperatureUnit === "fahrenheit" ? "°F" : "°C";

  const conditions = WMO_CONDITIONS.get(code) || "unknown conditions";
  const windLine = describeForecastWind(maxWind, config.windSpeedUnit);

  const location = [config.locationName, config.locationRegion].filter(Boolean);
  const locationSuffix = location.length ? ` for ${location.join(", ")}` : "";
  let scene = `Today's weather forecast${locationSuffix}: a high of ${high}${tempSymbol} and a low of ${low}${tempSymbol}, ${conditions}.`;
  if (windLine) scene += ` ${windLine}`;

  return scene;
}

// --- Kindroid ---

async function updateKindroidScene(sceneText, kindroidKey, aiId) {
  const res = await fetch(`${KINDROID_BASE}/update-info`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${kindroidKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      ai_id: aiId,
      current_scene: sceneText,
    }),
    signal: AbortSignal.timeout(30000),
  });

  if (!res.ok) {
    throw new Error(`Kindroid API ${res.status}: ${await res.text()}`);
  }
}

module.exports = {
  UNSET,
  WMO_CONDITIONS,
  fetchWeather,
  formatScene,
  formatForecast,
  updateKindroidScene,
  buildMeteoUrl,
};
