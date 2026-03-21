// app.js — Dashboard frontend logic.
// Manages the globe, location search, settings, and Kin CRUD.

(function () {
  "use strict";

  // --- State ---
  let token = "";
  let kins = [];
  let globe = null;
  let pendingCoords = null; // { lat, lng } set by globe click or search
  let hasKindroidKey = false;

  // --- Auth ---

  async function checkAuth() {
    const res = await api("GET", "/api/auth/check");
    if (res.requiresPassword && !res.authenticated) {
      show("login-screen");
      hide("dashboard");
    } else {
      show("dashboard");
      hide("login-screen");
      await boot();
    }
  }

  document.getElementById("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const pw = document.getElementById("login-password").value;
    const res = await fetch("/api/auth/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: pw }),
    }).then((r) => r.json());

    if (res.authenticated) {
      token = pw;
      hide("login-screen");
      show("dashboard");
      hide("login-error");
      await boot();
    } else {
      show("login-error");
    }
  });

  // --- API helper ---

  async function api(method, path, body) {
    const opts = {
      method,
      headers: { "Content-Type": "application/json" },
    };
    if (token) opts.headers["Authorization"] = `Bearer ${token}`;
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    return res.json();
  }

  // --- Boot ---

  async function boot() {
    initGlobe();
    initHourPicker();
    initForecastHourSelect();
    await refreshSettings();
    await refreshKins();

    // If no API key set, prompt settings on first load
    if (!hasKindroidKey) {
      openSettings();
    }

    // Auto-refresh every 60 seconds
    setInterval(refreshKins, 60000);
  }

  // --- Settings ---

  async function refreshSettings() {
    const res = await api("GET", "/api/settings");
    hasKindroidKey = res.hasKindroidKey;
  }

  document.getElementById("settings-btn").addEventListener("click", openSettings);
  document.getElementById("settings-close").addEventListener("click", closeSettings);
  document.getElementById("settings-overlay").addEventListener("click", (e) => {
    if (e.target.id === "settings-overlay") closeSettings();
  });

  function openSettings() {
    document.getElementById("settings-api-key").value = "";
    document.getElementById("settings-api-key").placeholder = hasKindroidKey ? "(saved — enter new key to change)" : "Enter your API key";
    hideStatus();
    show("settings-overlay");
  }

  function closeSettings() {
    hide("settings-overlay");
  }

  function showStatus(msg, type) {
    const el = document.getElementById("settings-status");
    el.textContent = msg;
    el.className = type;
    el.style.display = "block";
  }

  function hideStatus() {
    document.getElementById("settings-status").style.display = "none";
  }

  document.getElementById("settings-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const key = document.getElementById("settings-api-key").value.trim();
    if (!key) {
      if (hasKindroidKey) {
        closeSettings();
        return;
      }
      showStatus("Please enter your API key.", "error");
      return;
    }

    const res = await api("PUT", "/api/settings", { kindroidKey: key });
    if (res.ok) {
      hasKindroidKey = true;
      showStatus("API key saved.", "success");
      setTimeout(closeSettings, 1000);
    } else {
      showStatus(res.error || "Failed to save.", "error");
    }
  });

  // --- Globe ---

  function initGlobe() {
    const container = document.getElementById("globe");
    globe = Globe()(container)
      .backgroundColor("rgba(0,0,0,0)")
      .showAtmosphere(false)
      .atmosphereAltitude(0)
      .polygonCapColor(() => "#d1d5de")
      .polygonSideColor(() => "#0a0e17")
      .polygonStrokeColor(() => null)
      .polygonAltitude(0.004)
      .pointsData([])
      .pointLat("lat")
      .pointLng("lng")
      .pointColor("color")
      .pointAltitude(0.02)
      .pointRadius(0.5)
      .pointLabel("label")
      .onGlobeClick(({ lat, lng }) => {
        setPendingCoords(lat, lng);
        openAddModal();
      })
      .onPointClick((point) => {
        const card = document.querySelector(`[data-kin-id="${point.id}"]`);
        if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
      });

    // Set ocean color and fix z-fighting with polygon layer
    const mat = globe.globeMaterial();
    mat.color.set("#0a0e17");
    mat.polygonOffset = true;
    mat.polygonOffsetFactor = 2;
    mat.polygonOffsetUnits = 2;

    // Load country polygons
    fetch("https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json")
      .then((r) => r.json())
      .then((world) => {
        if (typeof topojson !== "undefined") {
          globe.polygonsData(topojson.feature(world, world.objects.countries).features);
        } else {
          console.error("topojson library not loaded");
        }
      })
      .catch((err) => console.error("Failed to load country data:", err));

    // Resize handling
    function resize() {
      const rect = container.getBoundingClientRect();
      globe.width(rect.width);
      globe.height(rect.height);
    }
    window.addEventListener("resize", resize);
    resize();
  }

  function updateGlobePoints() {
    if (!globe) return;
    const points = kins.map((k) => ({
      id: k.id,
      lat: k.latitude,
      lng: k.longitude,
      color: k.enabled ? "#5b9cf5" : "#8891a5",
      label: `<div style="background:rgba(20,25,38,0.9);padding:6px 10px;border-radius:6px;font-size:13px;color:#e4e8f1;border:1px solid #2a3142">
        <strong>${esc(k.name || "Unnamed Kin")}</strong><br>
        <span style="color:#8891a5">${k.latitude.toFixed(2)}, ${k.longitude.toFixed(2)}</span>
        ${k.lastScene ? `<br><em style="color:#b0b8c9">${esc(k.lastScene)}</em>` : ""}
      </div>`,
    }));
    globe.pointsData(points);
  }

  // --- Pending coordinates (from globe click or search) ---

  function setPendingCoords(lat, lng) {
    pendingCoords = { lat: +lat.toFixed(4), lng: +lng.toFixed(4) };
    // If modal is open, fill in the coords
    document.getElementById("kin-lat").value = pendingCoords.lat;
    document.getElementById("kin-lng").value = pendingCoords.lng;

    // Reverse geocode for location name
    reverseGeocode(pendingCoords.lat, pendingCoords.lng);
  }

  async function reverseGeocode(lat, lng) {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&zoom=10`,
        { headers: { "User-Agent": "weather-kin-dashboard" } }
      );
      const data = await res.json();
      if (data.address) {
        const name = data.address.city || data.address.town || data.address.village || data.address.hamlet || "";
        const region = data.address.state || data.address.county || "";
        document.getElementById("kin-location-name").value = name;
        document.getElementById("kin-location-region").value = region;
      }
    } catch {
      // Silently fail — user can type manually
    }
  }

  // --- Location Search ---

  const searchInput = document.getElementById("location-search");
  const searchResults = document.getElementById("search-results");
  let searchTimeout = null;

  searchInput.addEventListener("input", () => {
    clearTimeout(searchTimeout);
    const q = searchInput.value.trim();
    if (q.length < 3) {
      hide("search-results");
      return;
    }
    searchTimeout = setTimeout(() => searchLocation(q), 350);
  });

  searchInput.addEventListener("blur", () => {
    setTimeout(() => hide("search-results"), 200);
  });

  async function searchLocation(query) {
    try {
      const res = await fetch(
        `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=5`,
        { headers: { "User-Agent": "weather-kin-dashboard" } }
      );
      const results = await res.json();
      if (results.length === 0) {
        hide("search-results");
        return;
      }

      searchResults.innerHTML = results
        .map(
          (r) =>
            `<div class="search-result" data-lat="${r.lat}" data-lng="${r.lon}">${esc(r.display_name)}</div>`
        )
        .join("");
      show("search-results");

      searchResults.querySelectorAll(".search-result").forEach((el) => {
        el.addEventListener("mousedown", (e) => {
          e.preventDefault();
          const lat = parseFloat(el.dataset.lat);
          const lng = parseFloat(el.dataset.lng);
          searchInput.value = el.textContent;
          hide("search-results");

          // Move globe to location
          globe.pointOfView({ lat, lng, altitude: 1.5 }, 1000);
          setPendingCoords(lat, lng);

          // Open add modal
          openAddModal();
        });
      });
    } catch {
      hide("search-results");
    }
  }

  // --- Hour Picker ---

  function initHourPicker() {
    const picker = document.getElementById("hour-picker");
    picker.innerHTML = "";
    for (let h = 0; h < 24; h++) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "hour-btn";
      btn.textContent = `${h}:00`;
      btn.dataset.hour = h;
      btn.addEventListener("click", () => {
        btn.classList.toggle("selected");
        syncHourPicker();
      });
      picker.appendChild(btn);
    }
  }

  function syncHourPicker() {
    const selected = Array.from(document.querySelectorAll(".hour-btn.selected"))
      .map((b) => parseInt(b.dataset.hour))
      .sort((a, b) => a - b);
    document.getElementById("kin-update-hours").value = selected.join(",");
  }

  function setHourPickerValue(hoursStr) {
    const hours = hoursStr ? hoursStr.split(",").map(Number) : [0, 6, 12, 18];
    document.querySelectorAll(".hour-btn").forEach((btn) => {
      const h = parseInt(btn.dataset.hour);
      btn.classList.toggle("selected", hours.includes(h));
    });
    document.getElementById("kin-update-hours").value = hours.join(",");
  }

  // --- Forecast Hour Select ---

  function initForecastHourSelect() {
    const sel = document.getElementById("kin-forecast-hour");
    for (let h = 0; h < 24; h++) {
      const opt = document.createElement("option");
      opt.value = h;
      opt.textContent = `${h}:00`;
      sel.appendChild(opt);
    }
  }

  // --- Kin CRUD ---

  async function refreshKins() {
    kins = await api("GET", "/api/kins");
    renderKinList();
    updateGlobePoints();
  }

  function renderKinList() {
    const list = document.getElementById("kin-list");
    const empty = document.getElementById("empty-state");

    if (kins.length === 0) {
      list.innerHTML = "";
      list.appendChild(empty);
      empty.style.display = "block";
      return;
    }

    empty.style.display = "none";
    list.innerHTML = kins
      .map(
        (k) => `
      <div class="kin-card" data-kin-id="${k.id}">
        <div class="kin-card-header">
          <span class="kin-card-name">${esc(k.name || "Unnamed Kin")}</span>
          <div class="kin-card-actions">
            <button class="btn-icon" title="Trigger update now" data-trigger="${k.id}">&#x21bb;</button>
            <button class="btn-icon${k.enabled ? "" : " btn-paused"}" title="${k.enabled ? "Pause" : "Resume"}" data-toggle="${k.id}">${k.enabled ? "&#x23F8;" : "&#x25B6;&#xFE0E;"}</button>
            <button class="btn-icon" title="Edit" data-edit="${k.id}">&#x270E;</button>
            <button class="btn-icon" title="Delete" data-delete="${k.id}">&#x2715;</button>
          </div>
        </div>
        <div class="kin-card-location">${formatLocation(k)}</div>
        ${k.lastScene ? `<div class="kin-card-scene">${esc(k.lastScene)}</div>` : ""}
        <div class="kin-card-meta">
          <span><span class="status-dot ${k.enabled ? "active" : "inactive"}"></span>${k.enabled ? "Active" : "Paused"}</span>
          <span>${k.lastUpdate ? timeAgo(k.lastUpdate) : "No updates yet"}</span>
        </div>
      </div>
    `
      )
      .join("");

    // Event delegation
    list.querySelectorAll("[data-toggle]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.toggle;
        const kin = kins.find((k) => k.id == id);
        if (!kin) return;
        await api("PUT", `/api/kins/${id}`, { enabled: !kin.enabled });
        await refreshKins();
      });
    });
    list.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => openEditModal(btn.dataset.edit));
    });
    list.querySelectorAll("[data-delete]").forEach((btn) => {
      btn.addEventListener("click", () => deleteKin(btn.dataset.delete));
    });
    list.querySelectorAll("[data-trigger]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        const id = btn.dataset.trigger;
        const kin = kins.find((k) => k.id == id);
        const oldUpdate = kin ? kin.lastUpdate : null;
        btn.disabled = true;
        await api("POST", `/api/kins/${id}/trigger`);
        // Poll until the update lands (up to 15s)
        let attempts = 0;
        const poll = setInterval(async () => {
          attempts++;
          await refreshKins();
          const updated = kins.find((k) => k.id == id);
          if ((updated && updated.lastUpdate !== oldUpdate) || attempts >= 5) {
            clearInterval(poll);
            btn.disabled = false;
          }
        }, 3000);
      });
    });
  }

  function formatLocation(k) {
    const parts = [];
    if (k.locationName) parts.push(k.locationName);
    if (k.locationRegion) parts.push(k.locationRegion);
    if (parts.length) return `${parts.join(", ")} (${k.latitude.toFixed(2)}, ${k.longitude.toFixed(2)})`;
    return `${k.latitude.toFixed(4)}, ${k.longitude.toFixed(4)}`;
  }

  // --- Add/Edit Kin Modal ---

  const modal = document.getElementById("modal-overlay");
  const form = document.getElementById("kin-form");

  document.getElementById("add-kin-btn").addEventListener("click", () => {
    if (!hasKindroidKey) {
      openSettings();
      return;
    }
    openAddModal();
  });
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal-cancel").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  function openAddModal() {
    if (!hasKindroidKey) {
      openSettings();
      return;
    }

    document.getElementById("modal-title").textContent = "Add Kin";
    document.getElementById("modal-submit").textContent = "Add Kin";
    form.reset();
    document.getElementById("kin-id").value = "";
    setHourPickerValue("0,6,12,18");
    document.getElementById("kin-forecast-hour").value = "";

    // If we have pending coords from a globe click/search, use them
    if (pendingCoords) {
      document.getElementById("kin-lat").value = pendingCoords.lat;
      document.getElementById("kin-lng").value = pendingCoords.lng;
    }

    show("modal-overlay");
  }

  function openEditModal(id) {
    const kin = kins.find((k) => k.id === id);
    if (!kin) return;

    document.getElementById("modal-title").textContent = "Edit Kin";
    document.getElementById("modal-submit").textContent = "Save Changes";
    document.getElementById("kin-id").value = kin.id;
    document.getElementById("kin-name").value = kin.name || "";
    document.getElementById("kin-ai-id").value = kin.aiId || "";
    document.getElementById("kin-lat").value = kin.latitude;
    document.getElementById("kin-lng").value = kin.longitude;
    document.getElementById("kin-location-name").value = kin.locationName || "";
    document.getElementById("kin-location-region").value = kin.locationRegion || "";
    document.getElementById("kin-temp-unit").value = kin.temperatureUnit;
    document.getElementById("kin-wind-unit").value = kin.windSpeedUnit;
    setHourPickerValue(kin.updateHours);
    document.getElementById("kin-forecast-hour").value = kin.forecastHour ?? "";

    show("modal-overlay");
  }

  function closeModal() {
    hide("modal-overlay");
    pendingCoords = null;
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = document.getElementById("kin-id").value;
    const isEdit = Boolean(id);

    const data = {
      name: document.getElementById("kin-name").value,
      aiId: document.getElementById("kin-ai-id").value,
      latitude: document.getElementById("kin-lat").value,
      longitude: document.getElementById("kin-lng").value,
      locationName: document.getElementById("kin-location-name").value,
      locationRegion: document.getElementById("kin-location-region").value,
      temperatureUnit: document.getElementById("kin-temp-unit").value,
      windSpeedUnit: document.getElementById("kin-wind-unit").value,
      updateHours: document.getElementById("kin-update-hours").value,
      forecastHour: document.getElementById("kin-forecast-hour").value,
    };

    if (isEdit) {
      await api("PUT", `/api/kins/${id}`, data);
    } else {
      const res = await api("POST", "/api/kins", data);
      if (res.error) {
        alert(res.error);
        return;
      }
    }

    closeModal();
    await refreshKins();
  });

  async function deleteKin(id) {
    const kin = kins.find((k) => k.id === id);
    const name = kin?.name || "this Kin";
    if (!confirm(`Remove ${name}? This will stop weather updates for this Kin.`)) return;
    await api("DELETE", `/api/kins/${id}`);
    await refreshKins();
  }

  // --- Helpers ---

  function show(id) {
    document.getElementById(id).style.display = "";
  }

  function hide(id) {
    document.getElementById(id).style.display = "none";
  }

  function esc(str) {
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
  }

  function timeAgo(isoStr) {
    const diff = Date.now() - new Date(isoStr).getTime();
    const mins = Math.floor(diff / 60000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  }

  // --- Init ---
  checkAuth();
})();
