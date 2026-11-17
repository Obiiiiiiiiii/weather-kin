// Scene mode (SCENE_MODE=true): instead of a weather-only line, keep the Kin's Current/Scene Setting true to the chat.
// Every SCENE_INTERVAL_MIN minutes: read new chat messages from Kindroid. If any look like a change of clothes or
// place (a cheap local word check), ask Claude Haiku what the Kin is wearing and where he is. Add the light outside
// (from the sun's real height, no network) and a short weather bit, and write the line only when it changed.
// Everything the Kin can read calls the user USER_NAME (e.g. "Alex").
const fs = require("fs");
const path = require("path");
const { lightPhrase } = require("./light.js");

const LIMIT = 160; // Kindroid's Current Setting cap
const PERSON = /user|human|person/i;

function env(name, fallback) {
  const v = process.env[name];
  return v === undefined || v === "" ? fallback : v;
}

const CUE = new RegExp([
  "wear", "wore", "dress", "outfit", "put(s|ting)? on", "pull(s|ed|ing)? on", "slip(s|ped)? (on|into)", "chang(e|es|ed|ing) (into|out|clothes)",
  "strip", "undress", "take(s)? off", "took off", "shrug(s|ged)? (on|off)", "naked", "shirtless", "towel", "robe",
  "jacket", "coat", "shirt", "sweater", "hoodie", "thermal", "flannel", "jeans", "pants", "chinos", "shorts", "boots", "shoes", "barefoot",
  "pyjama", "pajama", "scarf", "hat",
  "walk(s|ed|ing)? (in|into|to|out|over|home|back)", "arriv", "head(s|ed|ing)? (to|out|home|back|over|for)", "go(es|ing)? (to|out|home|back)", "went",
  "driv(e|es|ing)", "drove", "step(s|ped)? (in|into|out|outside|inside)", "enter", "leav(e|es|ing)", "left", "back home", "get(s)? to", "got to",
  "inside", "outside", "room", "kitchen", "bedroom", "bed", "couch", "car", "beach", "shore", "dock", "harbou?r", "caf[eé]", "bar", "pub", "shop",
  "store", "park", "office", "house", "home", "apartment", "flat", "porch", "deck", "trail", "forest", "woods", "street", "town",
  "garage", "workbench", "wrench", "tools?", "grease", "engine", "carb", "hood", "tire", "truck", "shower", "bath", "sink", "stove",
  "yard", "lawn", "boat", "gym",
].map((w) => `\\b${w}`).join("|"), "i");

function start({ CONFIG, kindroidBase, fetchWeather, WMO_CONDITIONS, TEMP_SYMBOL, describeWind, updateCurrentScene, stateDir }) {
  const S = {
    anthropicKey: env("ANTHROPIC_API_KEY", ""),
    model: env("HAIKU_MODEL", "claude-haiku-5-5"),
    kinName: env("KIN_NAME", ""),
    userName: env("USER_NAME", "the user"),
    style: env("KIN_STYLE", ""),
    defaultOutfit: env("DEFAULT_OUTFIT", ""),
    everyMin: Math.max(2, Number(env("SCENE_INTERVAL_MIN", "5")) || 5),
    lightLat: Number(env("LIGHT_LATITUDE", CONFIG.latitude)),
    lightLon: Number(env("LIGHT_LONGITUDE", CONFIG.longitude)),
    lightTz: env("LIGHT_TZ", env("TZ", "")),
    placeHours: Number(env("PLACE_HOURS", "2")),
    outfitHours: Number(env("OUTFIT_HOURS", "10")),
    weather: env("SCENE_WEATHER", "false").toLowerCase() === "true",
    phoneToken: env("PHONE_TOKEN", ""),
  };
  if (!S.anthropicKey) console.warn("SCENE_MODE: no ANTHROPIC_API_KEY, so outfit and place won't be read from the chat (light and weather still work).");

  const FILE = path.join(stateDir, ".scene-state.json");
  let st = {};
  try { st = JSON.parse(fs.readFileSync(FILE, "utf-8")); console.log("Restored scene state."); } catch {}
  st = { outfit: "", place: "", outfit_at: 0, place_at: 0, seen: 0, scene: "", weather: "", weather_at: 0, phone: null, ...st };
  const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(st), "utf-8"); } catch (e) { console.error(`Failed to save scene state: ${e.message}`); } };
  const log = (m) => console.log(`[${new Date().toISOString()}] scene: ${m}`);

  // --- Chat, straight from Kindroid. Oldest first; only what's newer than the last message seen. ---
  async function readChat() {
    let after = st.seen ? st.seen - 1 : Date.now() - 6 * 3600000;
    const all = [];
    for (let page = 0; page < 3; page++) {
      const url = `${kindroidBase}/get-chat-messages?ai_id=${encodeURIComponent(CONFIG.aiId)}&limit=100&start_after_timestamp=${after}`;
      const res = await fetch(url, { headers: { Authorization: `Bearer ${CONFIG.kindroidKey}` }, signal: AbortSignal.timeout(30000) });
      const raw = await res.text();
      if (!res.ok) throw new Error(`Kindroid chat ${res.status}: ${raw.slice(0, 150)}`);
      const j = JSON.parse(raw);
      const list = Array.isArray(j) ? j : j.messages || j.data || [];
      for (const m of list) {
        let at = Number(m.timestamp ?? m.created_at ?? 0);
        if (at && at < 1e12) at *= 1000;
        const dn = String(m.display_name ?? "").trim().toLowerCase();
        const isUser = S.kinName && dn ? dn !== S.kinName.toLowerCase() : PERSON.test(String(m.sender ?? ""));
        all.push({ at, user: isUser, text: String(m.message ?? m.text ?? "") });
      }
      if (list.length < 100) break;
      const last = all[all.length - 1].at;
      if (!last || last <= after) break;
      after = last;
    }
    return all.filter((m) => m.text && m.at > st.seen).sort((a, b) => a.at - b.at);
  }

  // --- Haiku: the outfit and place as they stand now. ---
  const recent = []; // last ~30 messages for context
  async function askHaiku(msgs) {
    const name = S.kinName || "the companion";
    const transcript = msgs.map((m) => `${m.user ? S.userName : name}: ${m.text.slice(0, 700)}`).join("\n\n");
    const month = new Date().toLocaleString("en-CA", { month: "long", timeZone: S.lightTz || "UTC" });
    const system =
      `You keep track of the ongoing scene in a roleplay chat between ${S.userName} and their companion ${name} (he/him). ` +
      `Given what we last knew and the newest messages, say what ${name} is wearing and where ${name} is RIGHT NOW. ` +
      `Change a field only when the messages show it changed (he got dressed or changed, he arrived somewhere). ` +
      `Talking about, remembering or planning something does not count. Where he is should be inferred from what he's doing ` +
      `RIGHT NOW in the newest messages, and that beats an older stated location: car work, wrenches, grease, carb cleaner or ` +
      `engine parts mean the garage; cooking or the sink means the kitchen; and so on. Weigh the newest messages most. ` +
      `If something truly isn't knowable, keep what we last knew. Never use any name for the user except ${S.userName}. ` +
      `Answer with JSON only: {"outfit": "what he has on as a natural phrase that follows 'is wearing', e.g. 'a grey t-shirt, ` +
      `work jeans and socks', at most 80 characters", "place": "ONE place as a natural phrase that follows 'he's in', e.g. ` +
      `'the kitchen at home' or 'the garage', at most 50 characters"}.` +
      (S.style ? ` If the chat hasn't said what ${name} is wearing, pick something plausible from his usual style that fits where ` +
        `he is and the season (it's ${month}). His usual style: ${S.style.slice(0, 400)}` : "");
    const user = `What we last knew:\noutfit: ${st.outfit || "(unknown)"}\nplace: ${st.place || "(unknown)"}\n\nNewest messages, oldest first:\n${transcript}`;
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "x-api-key": S.anthropicKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: JSON.stringify({ model: S.model, max_tokens: 400, thinking: { type: "disabled" }, system, messages: [{ role: "user", content: user }] }),
      signal: AbortSignal.timeout(30000),
    });
    const raw = await res.text();
    if (!res.ok) throw new Error(`Anthropic ${res.status}: ${raw.slice(0, 200)}`);
    const text = (JSON.parse(raw).content || []).map((c) => c.text || "").join("");
    const json = JSON.parse((text.match(/\{[\s\S]*\}/) || ["{}"])[0]);
    const clean = (v, old) => (typeof v === "string" && v.trim() && !/unknown/i.test(v)
      ? v.trim().replace(/\.$/, "").slice(0, 90).replace(/[\s,]+\S*$/, (m, i, s) => (s.length >= 90 ? "" : m)) : old);
    return { outfit: clean(json.outfit, st.outfit), place: clean(json.place, st.place) };
  }

  // --- Short weather, refreshed every 30 minutes: "11°C and overcast, strong winds" ---
  async function weatherBit() {
    if (!S.weather) return "";
    if (st.weather && Date.now() - st.weather_at < 30 * 60000) return st.weather;
    try {
      const c = (await fetchWeather()).current;
      const cond = WMO_CONDITIONS.get(c.weather_code) || "";
      const wind = describeWind(c.wind_speed_10m); // "with strong winds" or null
      st.weather = `${Math.round(c.temperature_2m)}${TEMP_SYMBOL}${cond ? ` and ${cond}` : ""}${wind ? ` ${wind}` : ""}`;
      st.weather_at = Date.now();
    } catch (e) { log(`weather failed, keeping the last one: ${e.message}`); }
    return st.weather;
  }

  function sky() {
    const ph = st.phone;
    if (ph && Date.now() - ph.at < 3 * 86400000) return { lat: ph.lat, lon: ph.lon, tz: ph.tz || "" };
    return { lat: S.lightLat, lon: S.lightLon, tz: S.lightTz };
  }

  function compose(light, weather) {
    const now = Date.now();
    const outfit = st.outfit && now - st.outfit_at < S.outfitHours * 3600000 ? st.outfit : S.defaultOutfit;
    const place = st.place && now - st.place_at < S.placeHours * 3600000 ? st.place : "";
    const who = S.kinName || "He";
    const short = (s, n) => (!s || s.length <= n ? s : s.slice(0, n - 1).replace(/[\s,]+\S*$/, ""));
    const prep = (p) => (/^(in|at|on|by|near|under|inside|outside|out|home)\b/i.test(p) ? "" : /^(the |a |an |his |her |their )/i.test(p) ? "in " : "at ");
    const build = (o, p, w) => [
      o && `${who} is wearing ${o}.`,
      p && `${o ? "He's" : `${who} is`} ${prep(p)}${p}.`,
      `Outside, it's ${light}${w ? `, ${w}` : ""}.`,
    ].filter(Boolean).join(" ");
    for (const [o, p, w] of [[outfit, place, weather], [short(outfit, 50), short(place, 40), weather], [short(outfit, 50), short(place, 40), ""], [short(outfit, 35), short(place, 30), ""]]) {
      const line = build(o, p, w);
      if (line.length <= LIMIT) return line;
    }
    return build(short(outfit, 25), short(place, 20), "").slice(0, LIMIT);
  }

  let busy = false;
  async function tick(force = false) {
    if (busy) return;
    busy = true;
    try {
      let msgs = [];
      try { msgs = await readChat(); } catch (e) { log(`chat read failed: ${e.message}`); }
      if (msgs.length) {
        st.seen = msgs[msgs.length - 1].at;
        recent.push(...msgs);
        recent.splice(0, Math.max(0, recent.length - 30));
      }
      const first = !st.checked_once;
      if (S.anthropicKey && recent.length && (first || msgs.some((m) => CUE.test(m.text)))) {
        try {
          Object.assign(st, await askHaiku(recent.slice(first || !st.place ? -30 : -8)));
          st.outfit_at = st.place_at = Date.now();
          st.checked_once = true;
          log(`Haiku: ${st.outfit || "?"} / ${st.place || "?"}`);
        } catch (e) { log(`Haiku failed: ${e.message}`); }
      }
      const at = sky();
      const line = compose(lightPhrase(new Date(), at.lat, at.lon, at.tz), await weatherBit());
      if (line !== st.scene || force) {
        await updateCurrentScene(line);
        st.scene = line;
        log(`wrote: ${line}`);
      }
    } catch (e) {
      log(`error: ${e.message}`);
    } finally {
      save();
      busy = false;
    }
  }

  // Optional: POST /phone?token=PHONE_TOKEN with {"lat":..,"lon":..,"tz"?:..} moves the light with the user's phone.
  function handle(req, res) {
    const url = new URL(req.url, "http://x");
    if (req.method === "POST" && url.pathname === "/phone") {
      if (!S.phoneToken || url.searchParams.get("token") !== S.phoneToken) { res.writeHead(403); res.end("no"); return true; }
      let body = "";
      req.on("data", (d) => { body += d; if (body.length > 10000) req.destroy(); });
      req.on("end", () => {
        try {
          const v = JSON.parse(body);
          const lat = Number(v.lat ?? v.latitude), lon = Number(v.lon ?? v.lng ?? v.longitude);
          if (!Number.isFinite(lat) || !Number.isFinite(lon)) throw new Error("need lat and lon");
          st.phone = { lat: +lat.toFixed(2), lon: +lon.toFixed(2), tz: typeof v.tz === "string" ? v.tz : "", at: Date.now() };
          save();
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          tick();
        } catch (e) { res.writeHead(400); res.end(e.message); }
      });
      return true;
    }
    if (req.method === "POST" && url.pathname === "/scene") {
      // POST /scene?token=PHONE_TOKEN with {"outfit"?, "place"?}: fix it by hand.
      if (!S.phoneToken || url.searchParams.get("token") !== S.phoneToken) { res.writeHead(403); res.end("no"); return true; }
      let body = "";
      req.on("data", (d) => { body += d; if (body.length > 10000) req.destroy(); });
      req.on("end", () => {
        try {
          const v = JSON.parse(body || "{}");
          if (typeof v.outfit === "string" && v.outfit.trim()) { st.outfit = v.outfit.trim().slice(0, 90); st.outfit_at = Date.now(); }
          if (typeof v.place === "string" && v.place.trim()) { st.place = v.place.trim().slice(0, 90); st.place_at = Date.now(); }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          tick(true);
        } catch (e) { res.writeHead(400); res.end(e.message); }
      });
      return true;
    }
    return false;
  }

  log(`every ${S.everyMin} min; light at ${S.lightLat},${S.lightLon} ${S.lightTz || "(sun time)"}; weather ${S.weather ? "on" : "off"}`);
  const first = tick(true);
  const timer = setInterval(() => tick(), S.everyMin * 60000);
  return { handle, lastScene: () => st.scene, stop: () => clearInterval(timer), firstTick: first };
}

module.exports = { start };
