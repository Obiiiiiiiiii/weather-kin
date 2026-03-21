// db.js — SQLite database layer for multi-Kin configurations.
// Uses better-sqlite3 for synchronous, embedded storage.

const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");
const crypto = require("crypto");

const DATA_DIR = fs.existsSync("/app/data") ? "/app/data" : path.join(__dirname, "..");
const DB_PATH = path.join(DATA_DIR, "weather-kin.db");

let db;

function getDb() {
  if (!db) {
    db = new Database(DB_PATH);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    migrate();
  }
  return db;
}

function migrate() {
  const d = getDb();
  d.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS kins (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL DEFAULT '',
      ai_id TEXT NOT NULL,
      latitude REAL NOT NULL,
      longitude REAL NOT NULL,
      location_name TEXT NOT NULL DEFAULT '',
      location_region TEXT NOT NULL DEFAULT '',
      temperature_unit TEXT NOT NULL DEFAULT 'celsius',
      wind_speed_unit TEXT NOT NULL DEFAULT 'kmh',
      update_hours TEXT NOT NULL DEFAULT '0,6,12,18',
      forecast_hour INTEGER,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS kin_state (
      kin_id TEXT PRIMARY KEY REFERENCES kins(id) ON DELETE CASCADE,
      last_condition TEXT,
      last_wind_description TEXT,
      last_scene TEXT,
      last_update TEXT,
      saved_at TEXT
    );
  `);
}

// --- Settings (global API key, etc.) ---

function getSetting(key) {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key);
  return row ? row.value : null;
}

function setSetting(key, value) {
  getDb().prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
  `).run(key, value);
}

function getKindroidKey() {
  return getSetting("kindroid_api_key");
}

function setKindroidKey(key) {
  setSetting("kindroid_api_key", key);
}

function hasKindroidKey() {
  return Boolean(getKindroidKey());
}

// --- CRUD ---

function generateId() {
  return crypto.randomBytes(8).toString("hex");
}

function parseUpdateHours(hoursStr) {
  return hoursStr
    .split(",")
    .map((h) => {
      const n = Number(h.trim());
      if (isNaN(n) || n < 0 || n > 23) throw new Error(`Invalid hour: "${h.trim()}"`);
      return n;
    })
    .sort((a, b) => a - b);
}

function toConfig(row) {
  const updateHours = parseUpdateHours(row.update_hours);
  if (row.forecast_hour != null && !updateHours.includes(row.forecast_hour)) {
    updateHours.push(row.forecast_hour);
    updateHours.sort((a, b) => a - b);
  }
  return {
    id: row.id,
    name: row.name,
    kindroidKey: getKindroidKey(),
    aiId: row.ai_id,
    latitude: row.latitude,
    longitude: row.longitude,
    locationName: row.location_name,
    locationRegion: row.location_region,
    temperatureUnit: row.temperature_unit,
    windSpeedUnit: row.wind_speed_unit,
    updateHours,
    forecastHour: row.forecast_hour,
    enabled: Boolean(row.enabled),
  };
}

function toApiRow(row) {
  return {
    id: row.id,
    name: row.name,
    aiId: row.ai_id,
    latitude: row.latitude,
    longitude: row.longitude,
    locationName: row.location_name,
    locationRegion: row.location_region,
    temperatureUnit: row.temperature_unit,
    windSpeedUnit: row.wind_speed_unit,
    updateHours: row.update_hours,
    forecastHour: row.forecast_hour,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function listKins() {
  const rows = getDb().prepare("SELECT * FROM kins ORDER BY created_at").all();
  return rows.map(toApiRow);
}

function getKin(id) {
  const row = getDb().prepare("SELECT * FROM kins WHERE id = ?").get(id);
  return row ? toApiRow(row) : null;
}

function getKinConfig(id) {
  const row = getDb().prepare("SELECT * FROM kins WHERE id = ?").get(id);
  return row ? toConfig(row) : null;
}

function getAllEnabledConfigs() {
  const rows = getDb().prepare("SELECT * FROM kins WHERE enabled = 1").all();
  return rows.map(toConfig);
}

function createKin(data) {
  const id = generateId();
  const hours = parseUpdateHours(data.updateHours || "0,6,12,18");
  const forecastHour = data.forecastHour != null && data.forecastHour !== "" ? Number(data.forecastHour) : null;

  getDb().prepare(`
    INSERT INTO kins (id, name, ai_id, latitude, longitude,
      location_name, location_region, temperature_unit, wind_speed_unit,
      update_hours, forecast_hour, enabled)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)
  `).run(
    id,
    data.name || "",
    data.aiId,
    Number(data.latitude),
    Number(data.longitude),
    data.locationName || "",
    data.locationRegion || "",
    data.temperatureUnit || "celsius",
    data.windSpeedUnit || "kmh",
    hours.join(","),
    forecastHour,
  );

  return getKin(id);
}

function updateKin(id, data) {
  const existing = getDb().prepare("SELECT * FROM kins WHERE id = ?").get(id);
  if (!existing) return null;

  const fields = {};
  if (data.name !== undefined) fields.name = data.name;
  if (data.aiId !== undefined) fields.ai_id = data.aiId;
  if (data.latitude !== undefined) fields.latitude = Number(data.latitude);
  if (data.longitude !== undefined) fields.longitude = Number(data.longitude);
  if (data.locationName !== undefined) fields.location_name = data.locationName;
  if (data.locationRegion !== undefined) fields.location_region = data.locationRegion;
  if (data.temperatureUnit !== undefined) fields.temperature_unit = data.temperatureUnit;
  if (data.windSpeedUnit !== undefined) fields.wind_speed_unit = data.windSpeedUnit;
  if (data.updateHours !== undefined) {
    parseUpdateHours(data.updateHours); // validate
    fields.update_hours = data.updateHours;
  }
  if (data.forecastHour !== undefined) fields.forecast_hour = data.forecastHour === "" ? null : Number(data.forecastHour);
  if (data.enabled !== undefined) fields.enabled = data.enabled ? 1 : 0;

  const setClauses = Object.keys(fields).map((k) => `${k} = ?`);
  setClauses.push("updated_at = datetime('now')");
  const values = Object.values(fields);
  values.push(id);

  getDb().prepare(`UPDATE kins SET ${setClauses.join(", ")} WHERE id = ?`).run(...values);
  return getKin(id);
}

function deleteKin(id) {
  const result = getDb().prepare("DELETE FROM kins WHERE id = ?").run(id);
  return result.changes > 0;
}

// --- State persistence ---

function getKinState(kinId) {
  return getDb().prepare("SELECT * FROM kin_state WHERE kin_id = ?").get(kinId) || null;
}

function saveKinState(kinId, state) {
  getDb().prepare(`
    INSERT INTO kin_state (kin_id, last_condition, last_wind_description, last_scene, last_update, saved_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(kin_id) DO UPDATE SET
      last_condition = excluded.last_condition,
      last_wind_description = excluded.last_wind_description,
      last_scene = excluded.last_scene,
      last_update = excluded.last_update,
      saved_at = excluded.saved_at
  `).run(
    kinId,
    state.lastCondition ?? null,
    state.lastWindDescription ?? null,
    state.lastScene ?? null,
    state.lastUpdate ?? null,
  );
}

function getKinWithState(id) {
  const kin = getKin(id);
  if (!kin) return null;
  const state = getKinState(id);
  return {
    ...kin,
    lastScene: state?.last_scene || null,
    lastUpdate: state?.last_update || null,
  };
}

function listKinsWithState() {
  const kins = listKins();
  return kins.map((kin) => {
    const state = getKinState(kin.id);
    return {
      ...kin,
      lastScene: state?.last_scene || null,
      lastUpdate: state?.last_update || null,
    };
  });
}

module.exports = {
  getDb,
  getSetting,
  setSetting,
  getKindroidKey,
  setKindroidKey,
  hasKindroidKey,
  listKins,
  getKin,
  getKinConfig,
  getAllEnabledConfigs,
  createKin,
  updateKin,
  deleteKin,
  getKinState,
  saveKinState,
  getKinWithState,
  listKinsWithState,
};
