const query = new URLSearchParams(location.search);
const STORAGE_KEY = "allhistory:lastYear";
const VIEW_KEY = "allhistory:lastView";
const PANEL_KEY = "allhistory:panelCollapsed";
const storedYear = (() => {
  try {
    return localStorage.getItem(STORAGE_KEY) || "";
  } catch {
    return "";
  }
})();
const DEFAULT_YEAR = query.get("year") || storedYear || "750";
const FALLBACK_TIMELINE = buildYearRange(-3200, -1000, 50).concat(buildYearRange(-990, 1900, 1));

let initialYear = DEFAULT_YEAR;

const state = {
  map: null,
  timeline: [],
  timelineMeta: null,
  currentYear: "",
  currentIndex: 0,
  loadingToken: 0,
  styleCache: new Map(),
  prefetchTimer: 0,
  viewSaveTimer: 0,
  deferredLayerTimer: 0,
};

const DEFERRED_SOURCES = new Set([
  "texture",
  "dlsgis_his_terrain",
  "dlsgis_his_regime_city",
  "dlsgis_his_regime_spec",
  "dlsgis_his_regime_lonlat",
]);

function $(id) {
  return document.getElementById(id);
}

function setStatus(text) {
  $("status").textContent = text;
}

function buildYearRange(from, to, step) {
  const years = [];
  for (let year = from; year <= to; year += step) years.push(year);
  return years;
}

function yearNumToId(year) {
  const n = Number(year);
  return n < 0 ? `BC${Math.abs(Math.trunc(n))}` : `AD${Math.trunc(n)}`;
}

function yearIdToNum(input) {
  const raw = String(input || "").trim().toUpperCase();
  if (/^BC\d+$/.test(raw)) return -Number(raw.slice(2));
  if (/^AD\d+$/.test(raw)) return Number(raw.slice(2));
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) return 750;
  return Math.trunc(n);
}

function normalizeYear(input) {
  return yearNumToId(yearIdToNum(input));
}

function yearIdToDisplay(input) {
  return String(yearIdToNum(input));
}

function rememberYear(year) {
  try {
    localStorage.setItem(STORAGE_KEY, yearIdToDisplay(year));
  } catch {
    // localStorage can be disabled in private or embedded browsers.
  }
}

function readStoredJson(key) {
  try {
    return JSON.parse(localStorage.getItem(key) || "null");
  } catch {
    return null;
  }
}

function writeStoredJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be disabled in private or embedded browsers.
  }
}

function expandOfficialTimeline(items) {
  const years = [];
  for (const item of items || []) {
    if (Array.isArray(item) && item.length >= 2) {
      const from = Number(item[0]);
      const to = Number(item[1]);
      if (Number.isFinite(from) && Number.isFinite(to)) {
        for (let year = from; year <= to; year++) years.push(year);
      }
    } else {
      const year = Number(item);
      if (Number.isFinite(year)) years.push(year);
    }
  }
  return [...new Set(years)].sort((a, b) => a - b);
}

function nearestTimelineIndex(yearInput) {
  const target = yearIdToNum(yearInput);
  if (!state.timeline.length) return 0;

  let lo = 0;
  let hi = state.timeline.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (state.timeline[mid] < target) lo = mid + 1;
    else hi = mid;
  }

  if (lo > 0 && Math.abs(state.timeline[lo - 1] - target) <= Math.abs(state.timeline[lo] - target)) {
    return lo - 1;
  }
  return lo;
}

function resolveAvailableYear(yearInput) {
  if (!state.timeline.length) return normalizeYear(yearInput);
  return yearNumToId(state.timeline[nearestTimelineIndex(yearInput)]);
}

function updateTimelineUi(index) {
  const clamped = Math.max(0, Math.min(index, state.timeline.length - 1));
  state.currentIndex = clamped;

  const year = state.timeline[clamped] ?? yearIdToNum(DEFAULT_YEAR);
  const yearId = yearNumToId(year);
  $("timeline-slider").value = String(clamped);
  $("year-input").value = String(year);
  $("year-label").textContent = String(year);
  $("timeline-count").textContent = `${clamped + 1} / ${state.timeline.length}`;
}

async function loadJson(url, cacheMode = "force-cache") {
  const response = await fetch(url, { cache: cacheMode });
  if (!response.ok) throw new Error(`${url} ${response.status}`);
  return response.json();
}

function setLoading(isLoading) {
  const button = $("load-year");
  if (!button) return;
  button.disabled = isLoading;
  button.classList.toggle("is-loading", isLoading);
  button.textContent = isLoading ? "加载中" : "加载";
}

async function loadTimeline() {
  try {
    const json = await loadJson("/api/timeline", "no-store");
    const timeline = expandOfficialTimeline(json?.data?.timeline);
    state.timelineMeta = json?.data || null;
    state.timeline = timeline.length ? timeline : FALLBACK_TIMELINE;
  } catch (error) {
    console.warn(error);
    state.timeline = FALLBACK_TIMELINE;
    state.timelineMeta = null;
  }

  const slider = $("timeline-slider");
  slider.max = String(Math.max(0, state.timeline.length - 1));

  const startYear = query.get("year") || (state.timelineMeta?.default_year ?? DEFAULT_YEAR);
  initialYear = normalizeYear(startYear);
  updateTimelineUi(nearestTimelineIndex(initialYear));
}

async function loadStyle(year) {
  const key = normalizeYear(year);
  if (state.styleCache.has(key)) return state.styleCache.get(key);
  const style = await loadJson(`/api/style?year=${encodeURIComponent(key)}`);
  state.styleCache.set(key, style);
  if (state.styleCache.size > 8) state.styleCache.delete(state.styleCache.keys().next().value);
  return style;
}

function splitCriticalStyle(style) {
  const next = JSON.parse(JSON.stringify(style));
  const deferredLayerIds = [];
  for (const layer of next.layers || []) {
    if (!DEFERRED_SOURCES.has(layer.source)) continue;
    if (layer.layout?.visibility === "none") continue;
    layer.layout = { ...(layer.layout || {}), visibility: "none" };
    deferredLayerIds.push(layer.id);
  }
  return { style: next, deferredLayerIds };
}

function revealDeferredLayers(layerIds) {
  window.clearTimeout(state.deferredLayerTimer);
  state.deferredLayerTimer = window.setTimeout(() => {
    for (const id of layerIds) {
      if (!state.map.getLayer(id)) continue;
      state.map.setLayoutProperty(id, "visibility", "visible");
    }
  }, 900);
}

async function loadYear(yearInput, options = {}) {
  const requestedYear = normalizeYear(yearInput);
  const year = resolveAvailableYear(requestedYear);
  const token = ++state.loadingToken;
  state.currentYear = year;

  if (!options.keepTimeline) updateTimelineUi(nearestTimelineIndex(year));
  if (requestedYear !== year) {
    $("year-input").value = yearIdToDisplay(year);
  }
  setLoading(true);
  setStatus(`正在加载 ${yearIdToDisplay(year)}`);

  try {
    const style = await loadStyle(year);
    if (token !== state.loadingToken) return;

    let completed = false;
    const completeLoad = () => {
      if (completed || token !== state.loadingToken) return;
      completed = true;
      setStatus(`${yearIdToDisplay(year)} 已加载`);
      rememberYear(year);
      setLoading(false);
      history.replaceState(null, "", `?year=${encodeURIComponent(yearIdToDisplay(year))}`);
      scheduleNearbyPrefetch();
    };

    window.clearTimeout(state.deferredLayerTimer);
    const critical = splitCriticalStyle(style);
    state.map.setStyle(critical.style);
    state.map.once("styledata", () => {
      if (token !== state.loadingToken) return;
      setStatus(`${yearIdToDisplay(year)} 正在加载瓦片`);
      state.map.once("render", () => window.setTimeout(completeLoad, 300));
    });
    state.map.once("idle", () => {
      completeLoad();
      revealDeferredLayers(critical.deferredLayerIds);
    });

    window.setTimeout(() => {
      if (token !== state.loadingToken) return;
      if ($("status").textContent.includes("正在")) {
        completeLoad();
        revealDeferredLayers(critical.deferredLayerIds);
      }
    }, 1800);
  } catch (error) {
    if (token !== state.loadingToken) return;
    setLoading(false);
    setStatus(`${yearIdToDisplay(year)} 加载失败：${error.message}`);
  }
}

function scheduleNearbyPrefetch() {
  window.clearTimeout(state.prefetchTimer);
  state.prefetchTimer = window.setTimeout(() => {
    const offsets = [-2, -1, 1, 2];
    const indexes = offsets
      .map((offset) => state.currentIndex + offset)
      .filter((index) => index >= 0 && index < state.timeline.length);
    indexes.forEach((index) => prefetchYearNearViewport(yearNumToId(state.timeline[index])));
  }, 600);
}

function lonLatToTile(lon, lat, zoom) {
  const z = Math.max(1, Math.min(5, Math.floor(Number(zoom) || 2)));
  const n = 2 ** z;
  const safeLat = Math.min(85.05112878, Math.max(-85.05112878, Number(lat)));
  const latRad = (safeLat * Math.PI) / 180;
  return {
    z,
    x: Math.min(n - 1, Math.max(0, Math.floor(((Number(lon) + 180) / 360) * n))),
    y: Math.min(n - 1, Math.max(0, Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n))),
  };
}

function tileUrlsNearViewport(style) {
  if (!state.map) return [];
  const center = state.map.getCenter();
  const tile = lonLatToTile(center.lng, center.lat, state.map.getZoom());
  const n = 2 ** tile.z;
  const urls = [];
  for (const source of Object.values(style.sources || {})) {
    if (!Array.isArray(source.tiles) || !source.tiles[0]) continue;
    for (let dx = -1; dx <= 1; dx += 1) {
      for (let dy = -1; dy <= 1; dy += 1) {
        const x = (tile.x + dx + n) % n;
        const y = tile.y + dy;
        if (y < 0 || y >= n) continue;
        urls.push(source.tiles[0].replaceAll("{z}", tile.z).replaceAll("{x}", x).replaceAll("{y}", y));
      }
    }
  }
  return urls.slice(0, 60);
}

async function prefetchYearNearViewport(year) {
  try {
    const style = await loadStyle(year);
    const urls = tileUrlsNearViewport(style);
    const run = () => urls.forEach((url) => fetch(url, { cache: "force-cache", priority: "low" }).catch(() => {}));
    if ("requestIdleCallback" in window) window.requestIdleCallback(run, { timeout: 1800 });
    else window.setTimeout(run, 1000);
  } catch {
    // Prefetch is opportunistic.
  }
}

function scheduleInputPrefetch() {
  window.clearTimeout(state.prefetchTimer);
  state.prefetchTimer = window.setTimeout(() => {
    const year = resolveAvailableYear($("year-input").value);
    if (year && year !== state.currentYear) prefetchYearNearViewport(year);
  }, 700);
}

function getStepSize() {
  const input = $("step-size");
  const value = Math.trunc(Number(input?.value || 1));
  const step = Number.isFinite(value) ? Math.max(1, Math.min(500, value)) : 1;
  if (input && String(step) !== input.value) input.value = String(step);
  return step;
}

function stepTimeline(delta) {
  if (!state.timeline.length) return;
  const next = Math.max(0, Math.min(state.currentIndex + delta * getStepSize(), state.timeline.length - 1));
  updateTimelineUi(next);
  loadYear(yearNumToId(state.timeline[next]), { keepTimeline: true });
}

function initMap() {
  const savedView = readStoredJson(VIEW_KEY);
  state.map = new maplibregl.Map({
    container: "map",
    style: {
      version: 8,
      sources: {},
      layers: [{ id: "background", type: "background", paint: { "background-color": "#4f8cad" } }],
    },
    center: Array.isArray(savedView?.center) ? savedView.center : [106, 34],
    zoom: Number.isFinite(savedView?.zoom) ? savedView.zoom : 2,
    minZoom: 1,
    maxZoom: 9,
    renderWorldCopies: true,
    attributionControl: false,
    localIdeographFontFamily: "Microsoft YaHei, SimHei, sans-serif",
  });

  state.map.dragRotate.disable();
  state.map.touchZoomRotate.disableRotation();
  state.map.on("error", (event) => console.warn(event?.error || event));
  state.map.on("moveend", () => {
    window.clearTimeout(state.viewSaveTimer);
    state.viewSaveTimer = window.setTimeout(() => {
      const center = state.map.getCenter();
      writeStoredJson(VIEW_KEY, {
        center: [center.lng, center.lat],
        zoom: state.map.getZoom(),
      });
      scheduleNearbyPrefetch();
    }, 250);
  });
}

function bindUi() {
  $("year-input").value = yearIdToDisplay(DEFAULT_YEAR);
  $("timeline-slider").value = "0";

  $("year-form").addEventListener("submit", (event) => {
    event.preventDefault();
    loadYear($("year-input").value);
    $("year-input").blur();
  });

  $("year-input").addEventListener("keydown", (event) => {
    if (event.key !== "Enter") return;
    event.preventDefault();
    $("year-form").requestSubmit();
  });

  $("year-input").addEventListener("change", () => {
    loadYear($("year-input").value);
  });
  $("year-input").addEventListener("input", scheduleInputPrefetch);

  $("year-input").addEventListener("blur", () => {
    const year = normalizeYear($("year-input").value);
    if (year !== state.currentYear) loadYear(year);
  });

  $("timeline-slider").addEventListener("input", () => {
    updateTimelineUi(Number($("timeline-slider").value));
  });

  $("timeline-slider").addEventListener("change", () => {
    const year = state.timeline[Number($("timeline-slider").value)];
    loadYear(yearNumToId(year), { keepTimeline: true });
  });

  $("step-back").addEventListener("click", () => stepTimeline(-1));
  $("step-next").addEventListener("click", () => stepTimeline(1));
  $("step-size").addEventListener("change", getStepSize);
  $("step-size").addEventListener("blur", getStepSize);

  const controls = document.querySelector(".map-controls");
  const toggle = $("panel-toggle");
  const collapsed = readStoredJson(PANEL_KEY) === true;
  controls.classList.toggle("is-collapsed", collapsed);
  document.body.classList.toggle("panel-collapsed", collapsed);
  toggle.setAttribute("aria-expanded", String(!collapsed));
  toggle.addEventListener("click", () => {
    const next = !controls.classList.contains("is-collapsed");
    controls.classList.toggle("is-collapsed", next);
    document.body.classList.toggle("panel-collapsed", next);
    toggle.setAttribute("aria-expanded", String(!next));
    writeStoredJson(PANEL_KEY, next);
  });
}

initMap();
bindUi();
loadTimeline()
  .then(() => loadYear(initialYear, { keepTimeline: true }))
  .catch((error) => setStatus(error.message));
