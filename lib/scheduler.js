// scheduler.js — Manages per-Kin weather polling loops.
// Each Kin gets its own independent timer based on its update_hours.

const { UNSET, fetchWeather, formatScene, formatForecast, updateKindroidScene } = require("./weather");
const db = require("./db");

// Active timers keyed by Kin ID
const timers = new Map();
// In-memory state keyed by Kin ID
const states = new Map();

function getState(kinId) {
  if (states.has(kinId)) return states.get(kinId);

  // Try to restore from database
  const saved = db.getKinState(kinId);
  const state = {
    lastCondition: saved?.last_condition ?? UNSET,
    lastWindDescription: saved?.last_wind_description === undefined ? UNSET : (saved?.last_wind_description ?? UNSET),
    lastScene: saved?.last_scene ?? null,
  };
  states.set(kinId, state);
  return state;
}

function msUntilNextUpdate(updateHours) {
  const now = new Date();
  const candidates = updateHours.flatMap((h) => {
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

async function tick(kinId, { force = false } = {}) {
  const config = db.getKinConfig(kinId);
  if (!config) {
    console.log(`[${kinId}] Kin not found, stopping.`);
    stop(kinId);
    return;
  }
  if (!config.enabled && !force) {
    console.log(`[${kinId}] Kin disabled, skipping scheduled tick.`);
    stop(kinId);
    return;
  }

  const state = getState(kinId);
  const timestamp = new Date().toISOString();
  const label = config.name || kinId;

  try {
    const isForecastTick =
      config.forecastHour != null && new Date().getHours() === config.forecastHour;
    console.log(`[${timestamp}] [${label}] Fetching weather${isForecastTick ? " (forecast)" : ""}...`);

    const data = await fetchWeather(config);
    state.lastScene = isForecastTick ? formatForecast(data, config) : formatScene(data, config, state);
    console.log(`[${timestamp}] [${label}] Scene: "${state.lastScene}"`);

    // Persist state before pushing to Kindroid so it's saved even if the push fails
    db.saveKinState(kinId, {
      lastCondition: state.lastCondition === UNSET ? null : state.lastCondition,
      lastWindDescription: state.lastWindDescription === UNSET ? null : state.lastWindDescription,
      lastScene: state.lastScene,
      lastUpdate: timestamp,
    });

    if (config.kindroidKey) {
      await updateKindroidScene(state.lastScene, config.kindroidKey, config.aiId);
      console.log(`[${timestamp}] [${label}] Kindroid updated.`);
    } else {
      console.log(`[${timestamp}] [${label}] No API key — scene saved locally only.`);
    }
  } catch (err) {
    console.error(`[${timestamp}] [${label}] Error: ${err.message}`);
    if (state.lastScene) {
      console.log(`[${timestamp}] [${label}] Retaining last scene: "${state.lastScene}"`);
    }
  }
}

function scheduleNext(kinId) {
  const config = db.getKinConfig(kinId);
  if (!config || !config.enabled) return;

  const { ms, time } = msUntilNextUpdate(config.updateHours);
  const label = config.name || kinId;
  const hh = time.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  console.log(`[${label}] Next update at ${hh} (in ${Math.round(ms / 60000)} min)`);

  const timer = setTimeout(async () => {
    await tick(kinId);
    scheduleNext(kinId);
  }, ms);

  timers.set(kinId, timer);
}

function start(kinId) {
  stop(kinId); // Clear any existing timer
  const config = db.getKinConfig(kinId);
  if (!config || !config.enabled) return;

  const label = config.name || kinId;
  console.log(`[${label}] Starting scheduler — hours: ${config.updateHours.map((h) => `${h}:00`).join(", ")}`);

  // Do an initial tick, then schedule
  tick(kinId).then(() => scheduleNext(kinId));
}

function stop(kinId) {
  const timer = timers.get(kinId);
  if (timer) {
    clearTimeout(timer);
    timers.delete(kinId);
  }
  states.delete(kinId);
}

function restart(kinId) {
  stop(kinId);
  start(kinId);
}

function startAll() {
  const configs = db.getAllEnabledConfigs();
  console.log(`Starting ${configs.length} Kin scheduler(s)...`);
  for (const config of configs) {
    start(config.id);
  }
}

function stopAll() {
  for (const kinId of timers.keys()) {
    stop(kinId);
  }
}

function getStatus(kinId) {
  return {
    running: timers.has(kinId),
    state: states.get(kinId) || null,
  };
}

module.exports = {
  start,
  stop,
  restart,
  startAll,
  stopAll,
  getStatus,
  tick,
};
