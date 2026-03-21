// app.js — Dashboard frontend logic.
// Manages the globe, location search, and Kin CRUD.

(function () {
  "use strict";

  // --- State ---
  let token = "";
  let kins = [];
  let globe = null;
  let pendingCoords = null; // { lat, lng } set by globe click or search

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
    await refreshKins();
    // Auto-refresh every 60 seconds
    setInterval(refreshKins, 60000);
  }

  // --- Globe ---

  function initGlobe() {
    const container = document.getElementById("globe");
    globe = Globe()(container)
      .globeImageUrl("https://unpkg.com/three-globe@2.35.0/example/img/earth-blue-marble.jpg")
      .bumpImageUrl("https://unpkg.com/three-globe@2.35.0/example/img/earth-topology.png")
      .backgroundImageUrl("https://unpkg.com/three-globe@2.35.0/example/img/night-sky.png")
      .pointsData([])
      .pointLat("lat")
      .pointLng("lng")
      .pointColor("color")
      .pointAltitude(0.02)
      .pointRadius(0.5)
      .pointLabel("label")
      .onGlobeClick(({ lat, lng }) => {
        setPendingCoords(lat, lng);
      })
      .onPointClick((point) => {
        // Scroll to that kin's card
        const card = document.querySelector(`[data-kin-id="${point.id}"]`);
        if (card) card.scrollIntoView({ behavior: "smooth", block: "center" });
      });

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
      color: k.enabled ? "#5bef8b" : "#8891a5",
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

          // Open add modal if not already editing
          if (document.getElementById("modal-overlay").style.display === "none") {
            openAddModal();
          }
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
    // Keep the "None" option, add 0-23
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
    list.querySelectorAll("[data-edit]").forEach((btn) => {
      btn.addEventListener("click", () => openEditModal(btn.dataset.edit));
    });
    list.querySelectorAll("[data-delete]").forEach((btn) => {
      btn.addEventListener("click", () => deleteKin(btn.dataset.delete));
    });
    list.querySelectorAll("[data-trigger]").forEach((btn) => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        await api("POST", `/api/kins/${btn.dataset.trigger}/trigger`);
        setTimeout(refreshKins, 3000);
        setTimeout(() => { btn.disabled = false; }, 5000);
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

  // --- Modal ---

  const modal = document.getElementById("modal-overlay");
  const form = document.getElementById("kin-form");

  document.getElementById("add-kin-btn").addEventListener("click", () => openAddModal());
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal-cancel").addEventListener("click", closeModal);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) closeModal();
  });

  function openAddModal() {
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
    document.getElementById("kin-api-key").value = ""; // Don't expose key
    document.getElementById("kin-api-key").required = false;
    document.getElementById("kin-api-key").placeholder = "(unchanged)";
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
    // Reset API key field for next use
    document.getElementById("kin-api-key").required = true;
    document.getElementById("kin-api-key").placeholder = "";
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

    const apiKey = document.getElementById("kin-api-key").value;
    if (apiKey) data.kindroidKey = apiKey;

    if (isEdit) {
      await api("PUT", `/api/kins/${id}`, data);
    } else {
      if (!apiKey) {
        alert("API Key is required when adding a new Kin.");
        return;
      }
      data.kindroidKey = apiKey;
      await api("POST", "/api/kins", data);
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
