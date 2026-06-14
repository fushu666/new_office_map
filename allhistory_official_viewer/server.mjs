import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { signCmaptileUrl } from "../allhistory_tools/allhistory_signer.mjs";
import { decodeTileToGeoJSON, inspectTileLayers } from "./mvt_decoder.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const maplibreDir = path.join(publicDir, "maplibre");
const PORT = Number(process.env.PORT || 8898);
const HOST = process.env.HOST || "127.0.0.1";
const PUBLIC_ORIGIN = (process.env.PUBLIC_ORIGIN || "").replace(/\/+$/, "");
const REFERER = "https://www.allhistory.com/";
const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";
const diskCacheDir = process.env.AH_CACHE_DIR || path.join(__dirname, ".cache", "official");

const SOURCE_IDS = new Set([
  "dlsgis_his_regime",
  "dlsgis_base",
  "dlsgis_his_regime_city",
  "dlsgis_his_terrain",
  "dlsgis_his_regime_water",
  "dlsgis_his_regime_lonlat",
  "texture",
  "dlsgis_his_regime_spec",
]);

const SOURCE_ALIASES = {
  dlsgis_base: "base",
  dlsgis_his_regime: "regime",
  dlsgis_his_regime_city: "city",
  dlsgis_his_regime_spec: "spec",
  dlsgis_his_regime_water: "water",
  dlsgis_his_regime_lonlat: "lonlat",
  dlsgis_his_terrain: "terrain",
  texture: "texture",
};

const cache = new Map();
const pendingFetches = new Map();
const CACHE_LIMIT = 600;
fs.mkdirSync(diskCacheDir, { recursive: true });

function send(res, status, body, type = "text/plain; charset=utf-8", headers = {}) {
  res.writeHead(status, {
    "Content-Type": type,
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": headers["Cache-Control"] || "public, max-age=300",
    ...headers,
  });
  res.end(body);
}

function sendJson(res, status, data) {
  send(res, status, JSON.stringify(data, null, 2), "application/json; charset=utf-8");
}

function sendStatic(res, filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const fileName = path.basename(filePath).toLowerCase();
  let cacheControl = "public, max-age=300";
  if (fileName === "index.html") {
    cacheControl = "no-cache";
  } else if ([".js", ".css", ".svg", ".png", ".pbf", ".json"].includes(ext)) {
    cacheControl = "public, max-age=31536000, immutable";
  }
  send(res, 200, fs.readFileSync(filePath), contentType(filePath), { "Cache-Control": cacheControl });
}

function contentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".js") return "application/javascript; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".svg") return "image/svg+xml; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  if (ext === ".png") return "image/png";
  if (ext === ".pbf") return "application/x-protobuf";
  return "application/octet-stream";
}

function cacheKeyForUrl(rawUrl) {
  return Buffer.from(rawUrl).toString("base64url");
}

function cacheMetaPath(key) {
  return path.join(diskCacheDir, `${key}.json`);
}

function cacheBodyPath(key) {
  return path.join(diskCacheDir, `${key}.bin`);
}

function readDiskCache(rawUrl) {
  const key = cacheKeyForUrl(rawUrl);
  const metaPath = cacheMetaPath(key);
  const bodyPath = cacheBodyPath(key);
  if (!fs.existsSync(metaPath) || !fs.existsSync(bodyPath)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
    return {
      ok: meta.ok,
      status: meta.status,
      type: meta.type,
      body: fs.readFileSync(bodyPath),
      signedUrl: meta.signedUrl || rawUrl,
      cached: "disk",
    };
  } catch {
    return null;
  }
}

function writeDiskCache(rawUrl, result) {
  if (!result.ok) return;
  const key = cacheKeyForUrl(rawUrl);
  try {
    fs.writeFileSync(cacheBodyPath(key), result.body);
    fs.writeFileSync(cacheMetaPath(key), JSON.stringify({
      ok: result.ok,
      status: result.status,
      type: result.type,
      signedUrl: result.signedUrl,
      cachedAt: new Date().toISOString(),
    }));
  } catch (error) {
    console.warn("disk cache write failed", error.message);
  }
}

function safePublicPath(urlPath) {
  const rel = decodeURIComponent(urlPath === "/" ? "/index.html" : urlPath).replace(/^\/+/, "");
  const full = path.resolve(publicDir, rel);
  return full.startsWith(publicDir) ? full : null;
}

function safeMaplibrePath(urlPath) {
  const rel = decodeURIComponent(urlPath.replace(/^\/maplibre\/+/, ""));
  const full = path.resolve(maplibreDir, rel);
  return full.startsWith(maplibreDir) ? full : null;
}

function yearIdFromInput(input) {
  const raw = String(input || "").trim().toUpperCase();
  if (/^AD\d+$/.test(raw) || /^BC\d+$/.test(raw)) return raw;
  const n = Number(raw);
  if (!Number.isFinite(n) || n === 0) return "AD806";
  return n < 0 ? `BC${Math.abs(Math.trunc(n))}` : `AD${Math.trunc(n)}`;
}

function proxyTileUrl(remoteTemplate, sourceId, year) {
  return `${originBase()}/api/tile?year=${encodeURIComponent(year)}&source=${encodeURIComponent(sourceId)}&z={z}&x={x}&y={y}&remote=${encodeURIComponent(remoteTemplate)}`;
}

function tileGeoJsonUrl(sourceId, year, z, x, y) {
  return `${originBase()}/api/mini-program/tile-geojson?year=${encodeURIComponent(year)}&source=${encodeURIComponent(sourceId)}&z=${z}&x=${x}&y=${y}`;
}

let currentOrigin = PUBLIC_ORIGIN || `http://${HOST === "0.0.0.0" ? "127.0.0.1" : HOST}:${PORT}`;
function originBase() {
  return currentOrigin;
}

function requestOrigin(req, reqUrl) {
  if (PUBLIC_ORIGIN) return PUBLIC_ORIGIN;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const forwardedHost = String(req.headers["x-forwarded-host"] || "").split(",")[0].trim();
  const proto = forwardedProto || reqUrl.protocol.replace(":", "") || "http";
  const host = forwardedHost || req.headers.host || `127.0.0.1:${PORT}`;
  return `${proto}://${host}`;
}

function rewriteStyle(style, year) {
  const next = JSON.parse(JSON.stringify(style));
  next.sprite = `${originBase()}/api/sprite`;
  next.glyphs = `${originBase()}/api/glyphs/{fontstack}/{range}.pbf`;

  for (const [sourceId, source] of Object.entries(next.sources || {})) {
    if (!SOURCE_IDS.has(sourceId) || !Array.isArray(source.tiles) || !source.tiles[0]) continue;
    source.tiles = [proxyTileUrl(source.tiles[0], sourceId, year)];
    if (source.type === "raster") {
      source.tileSize ||= 256;
    }
  }

  return next;
}

async function fetchRemoteBuffer(rawUrl) {
  const signedUrl = await signCmaptileUrl(rawUrl);
  const cached = cache.get(signedUrl);
  if (cached) return cached;

  const diskCached = readDiskCache(signedUrl);
  if (diskCached) {
    if (cache.size < CACHE_LIMIT) cache.set(signedUrl, diskCached);
    return diskCached;
  }

  if (pendingFetches.has(signedUrl)) return pendingFetches.get(signedUrl);

  const fetchPromise = (async () => {
  const response = await fetch(signedUrl, {
    headers: {
      "User-Agent": USER_AGENT,
      "Referer": REFERER,
    },
  });
  const body = Buffer.from(await response.arrayBuffer());
  const result = {
    ok: response.ok,
    status: response.status,
    type: response.headers.get("content-type") || contentType(new URL(rawUrl).pathname),
    body,
    signedUrl,
  };

    if (response.ok) {
      if (cache.size < CACHE_LIMIT) cache.set(signedUrl, result);
      writeDiskCache(signedUrl, result);
    }
    return result;
  })();

  pendingFetches.set(signedUrl, fetchPromise);
  try {
    return await fetchPromise;
  } finally {
    pendingFetches.delete(signedUrl);
  }
}

async function proxyRemote(res, rawUrl, typeOverride = "") {
  if (!/^https:\/\/([\w-]+\.)?allhistory\.com\//i.test(rawUrl) && !/^https:\/\/cmaptile2?\.allhistory\.com\//i.test(rawUrl)) {
    send(res, 400, "remote host not allowed");
    return;
  }

  const result = await fetchRemoteBuffer(rawUrl);
  send(res, result.status, result.body, typeOverride || result.type, {
    "Cache-Control": result.ok ? "public, max-age=604800, immutable" : "no-store",
    "X-Upstream-Url": result.signedUrl,
  });
}

function expandTemplate(template, params) {
  return template
    .replaceAll("{year}", params.year)
    .replaceAll("{z}", params.z)
    .replaceAll("{x}", params.x)
    .replaceAll("{y}", params.y)
    .replaceAll("{fontstack}", params.fontstack || "")
    .replaceAll("{range}", params.range || "");
}

function lonLatToTile(lon, lat, zoom) {
  const z = Number(zoom);
  const n = 2 ** z;
  const safeLat = Math.min(85.05112878, Math.max(-85.05112878, Number(lat)));
  const latRad = (safeLat * Math.PI) / 180;
  const x = Math.floor(((Number(lon) + 180) / 360) * n);
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return {
    z,
    x: Math.min(n - 1, Math.max(0, x)),
    y: Math.min(n - 1, Math.max(0, y)),
  };
}

function tilesForViewport(lon, lat, zoom, radius) {
  const tile = lonLatToTile(lon, lat, zoom);
  const n = 2 ** tile.z;
  const r = Math.max(0, Math.min(4, Math.trunc(Number(radius) || 1)));
  const tiles = [];
  for (let dx = -r; dx <= r; dx += 1) {
    for (let dy = -r; dy <= r; dy += 1) {
      const x = (tile.x + dx + n) % n;
      const y = tile.y + dy;
      if (y >= 0 && y < n) tiles.push({ z: tile.z, x, y });
    }
  }
  return tiles;
}

async function fetchOfficialStyle(year) {
  const remote = `https://cmaptile2.allhistory.com/v-34/styles/dlsgis-his-regime-${year}.json`;
  const fetched = await fetchRemoteBuffer(remote);
  if (!fetched.ok) {
    const error = new Error(`style ${fetched.status}`);
    error.status = fetched.status;
    error.body = fetched.body;
    error.type = fetched.type;
    throw error;
  }
  return JSON.parse(fetched.body.toString("utf8"));
}

async function handleStyle(req, res, reqUrl) {
  const year = yearIdFromInput(reqUrl.searchParams.get("year") || "AD806");
  try {
    const style = await fetchOfficialStyle(year);
    sendJson(res, 200, rewriteStyle(style, year));
  } catch (error) {
    send(res, error.status || 500, error.body || error.message, error.type || "text/plain; charset=utf-8");
    return;
  }
}

async function handleTimeline(req, res) {
  const remote = "https://map.allhistory.com/dlsgis/api/timeline?h=1";
  const fetched = await fetchRemoteBuffer(remote);
  if (!fetched.ok) {
    send(res, fetched.status, fetched.body, fetched.type);
    return;
  }
  send(res, 200, fetched.body, "application/json; charset=utf-8", {
    "Cache-Control": "public, max-age=86400",
  });
}

async function handleMiniProgramManifest(req, res, reqUrl) {
  const remote = "https://map.allhistory.com/dlsgis/api/timeline?h=1";
  const fetched = await fetchRemoteBuffer(remote);
  let timelineData = null;
  if (fetched.ok) {
    timelineData = JSON.parse(fetched.body.toString("utf8"))?.data || null;
  }
  const rendererOverride = reqUrl.searchParams.get("renderer") || process.env.MINI_PROGRAM_RENDERER || "";
  const renderer = rendererOverride === "vectorCanvas" ? "vectorCanvas" : "snapshot";

  sendJson(res, 200, {
    version: 1,
    renderer,
    renderers: {
      snapshot: {
        status: "ready",
        description: "Official AllHistory PNG snapshot for native mini-program rendering.",
      },
      vectorCanvas: {
        status: "experimental",
        description: "Native canvas renderer using decoded official vector PBF tiles.",
        tileRadius: 1,
        initialZoom: Math.max(Number(timelineData?.default_zoom || 2), 3),
      },
    },
    defaultYear: timelineData?.default_year ? yearIdFromInput(timelineData.default_year) : "AD750",
    defaultCenter: timelineData?.default_centroid || [106.26767430086022, 40.76057563344236],
    defaultZoom: timelineData?.default_zoom || 2,
    timeline: timelineData?.timeline || [],
    endpoints: {
      timeline: `${originBase()}/api/timeline`,
      snapshot: `${originBase()}/api/snapshot?year={year}`,
      style: `${originBase()}/api/style?year={year}`,
      tile: `${originBase()}/api/tile`,
      tilePlan: `${originBase()}/api/mini-program/tile-plan?year={year}&lon={lon}&lat={lat}&z={z}&radius={radius}`,
      tileGeoJSON: `${originBase()}/api/mini-program/tile-geojson?year={year}&source={source}&z={z}&x={x}&y={y}`,
      spriteJson: `${originBase()}/api/sprite.json`,
      spritePng: `${originBase()}/api/sprite.png`,
    },
    sources: [
      "dlsgis_base",
      "dlsgis_his_regime",
      "dlsgis_his_regime_city",
      "dlsgis_his_regime_spec",
      "dlsgis_his_regime_water",
      "dlsgis_his_regime_lonlat",
      "dlsgis_his_terrain",
      "texture",
    ],
  });
}

async function handleMiniProgramTilePlan(req, res, reqUrl) {
  const year = yearIdFromInput(reqUrl.searchParams.get("year") || "AD750");
  const lon = Number(reqUrl.searchParams.get("lon") || 106.26767430086022);
  const lat = Number(reqUrl.searchParams.get("lat") || 40.76057563344236);
  const z = Number(reqUrl.searchParams.get("z") || 2);
  const radius = Number(reqUrl.searchParams.get("radius") || 1);

  try {
    const style = await fetchOfficialStyle(year);
    const tiles = tilesForViewport(lon, lat, z, radius);
    const sources = {};

    for (const [sourceId, source] of Object.entries(style.sources || {})) {
      if (!SOURCE_IDS.has(sourceId) || !Array.isArray(source.tiles) || !source.tiles[0]) continue;
      sources[sourceId] = {
        id: sourceId,
        alias: SOURCE_ALIASES[sourceId] || sourceId,
        type: source.type,
        minzoom: source.minzoom ?? 0,
        maxzoom: source.maxzoom ?? 22,
        tileSize: source.tileSize || 256,
        tiles: tiles.map((tile) => ({
          ...tile,
          url: proxyTileUrl(source.tiles[0], sourceId, year)
            .replaceAll("{z}", tile.z)
            .replaceAll("{x}", tile.x)
            .replaceAll("{y}", tile.y),
          geojsonUrl: source.type === "vector" ? tileGeoJsonUrl(sourceId, year, tile.z, tile.x, tile.y) : "",
        })),
      };
    }

    const layers = (style.layers || []).map((layer) => ({
      id: layer.id,
      type: layer.type,
      source: layer.source || "",
      sourceLayer: layer["source-layer"] || "",
      minzoom: layer.minzoom,
      maxzoom: layer.maxzoom,
      paint: layer.paint || {},
      layout: layer.layout || {},
    }));

    sendJson(res, 200, {
      year,
      center: [lon, lat],
      zoom: z,
      radius,
      tiles,
      sources,
      layers,
      sprite: `${originBase()}/api/sprite`,
      glyphs: `${originBase()}/api/glyphs/{fontstack}/{range}.pbf`,
    });
  } catch (error) {
    send(res, error.status || 500, error.body || error.message, error.type || "text/plain; charset=utf-8");
  }
}

function sourceMatches(sourceId, raw) {
  const value = String(raw || "").trim();
  if (!value) return false;
  return sourceId === value || SOURCE_ALIASES[sourceId] === value || sourceId.toLowerCase() === value.toLowerCase();
}

async function handleMiniProgramTileGeoJSON(req, res, reqUrl) {
  const year = yearIdFromInput(reqUrl.searchParams.get("year") || "AD750");
  const sourceParam = reqUrl.searchParams.get("source") || "dlsgis_his_regime";
  const z = Number(reqUrl.searchParams.get("z") || 2);
  const x = Number(reqUrl.searchParams.get("x") || 0);
  const y = Number(reqUrl.searchParams.get("y") || 0);
  const featureLimit = Number(reqUrl.searchParams.get("limit") || 0);
  const geometryFilter = String(reqUrl.searchParams.get("geometry") || "").trim();
  const inspect = reqUrl.searchParams.get("inspect") === "1";

  try {
    const style = await fetchOfficialStyle(year);
    const entry = Object.entries(style.sources || {}).find(([sourceId, source]) =>
      SOURCE_IDS.has(sourceId) && source.type === "vector" && Array.isArray(source.tiles) && source.tiles[0] && sourceMatches(sourceId, sourceParam)
    );
    if (!entry) {
      send(res, 404, `vector source not found: ${sourceParam}`);
      return;
    }

    const [sourceId, source] = entry;
    const remote = expandTemplate(source.tiles[0], { year, z, x, y });
    const fetched = await fetchRemoteBuffer(remote);
    if (!fetched.ok) {
      send(res, fetched.status, fetched.body, fetched.type);
      return;
    }

    if (inspect) {
      sendJson(res, 200, {
        year,
        source: sourceId,
        alias: SOURCE_ALIASES[sourceId] || sourceId,
        z,
        x,
        y,
        layers: inspectTileLayers(fetched.body),
      });
      return;
    }

    let geojson = decodeTileToGeoJSON(fetched.body, {
      source: SOURCE_ALIASES[sourceId] || sourceId,
      year,
      z,
      x,
      y,
    });
    if (geometryFilter) {
      const allowed = new Set(geometryFilter.split(",").map((item) => item.trim()).filter(Boolean));
      geojson = {
        ...geojson,
        features: geojson.features.filter((feature) => allowed.has(feature.geometry?.type)),
      };
    }
    if (featureLimit > 0) {
      geojson = {
        ...geojson,
        features: geojson.features.slice(0, featureLimit),
      };
    }
    sendJson(res, 200, geojson);
  } catch (error) {
    send(res, error.status || 500, error.body || error.stack || error.message, error.type || "text/plain; charset=utf-8");
  }
}

async function handleSnapshot(req, res, reqUrl) {
  const year = yearIdFromInput(reqUrl.searchParams.get("year") || "AD750");
  const remote = `https://cmaptile2.allhistory.com/v-12/png/dlsgis-his-regime-${year}.png`;
  await proxyRemote(res, remote, "image/png");
}

async function handleTile(req, res, reqUrl) {
  const remoteTemplate = reqUrl.searchParams.get("remote");
  if (!remoteTemplate) {
    send(res, 400, "missing remote");
    return;
  }
  const params = {
    year: yearIdFromInput(reqUrl.searchParams.get("year") || "AD806"),
    z: reqUrl.searchParams.get("z"),
    x: reqUrl.searchParams.get("x"),
    y: reqUrl.searchParams.get("y"),
  };
  if (!params.z || !params.x || !params.y) {
    send(res, 400, "missing z/x/y");
    return;
  }
  const remote = expandTemplate(remoteTemplate, params);
  const isRaster = /\.png($|\?)/i.test(remote);
  await proxyRemote(res, remote, isRaster ? "image/png" : "application/x-protobuf");
}

async function handleGlyph(req, res, reqUrl) {
  const match = reqUrl.pathname.match(/^\/api\/glyphs\/(.+)\/([^/]+\.pbf)$/);
  if (!match) {
    send(res, 404, "not found");
    return;
  }
  const fontstack = decodeURIComponent(match[1]);
  const range = decodeURIComponent(match[2]).replace(/\.pbf$/, "");
  const remote = `https://cmaptile.allhistory.com/v1/fonts/${encodeURIComponent(fontstack)}/${range}.pbf`;
  await proxyRemote(res, remote, "application/x-protobuf");
}

async function handleSprite(req, res, reqUrl) {
  const match = reqUrl.pathname.match(/^\/api\/sprite(@2x)?\.(json|png)$/);
  const scale = match?.[1] || "";
  const ext = match?.[2] || "json";
  const remote = `https://cmaptile.allhistory.com/v1/styles/dlsgis-history/sprite${scale}.${ext}`;
  await proxyRemote(res, remote, ext === "png" ? "image/png" : "application/json; charset=utf-8");
}

const server = http.createServer(async (req, res) => {
  try {
    const reqUrl = new URL(req.url, `http://${req.headers.host || `127.0.0.1:${PORT}`}`);
    currentOrigin = requestOrigin(req, reqUrl);

    if (req.method !== "GET") {
      send(res, 405, "method not allowed");
      return;
    }

    if (reqUrl.pathname === "/healthz") {
      sendJson(res, 200, {
        ok: true,
        port: PORT,
        host: HOST,
        origin: originBase(),
        cacheDir: diskCacheDir,
        memoryCacheSize: cache.size,
        pendingFetches: pendingFetches.size,
      });
      return;
    }

    if (reqUrl.pathname === "/api/style") {
      await handleStyle(req, res, reqUrl);
      return;
    }
    if (reqUrl.pathname === "/api/timeline") {
      await handleTimeline(req, res);
      return;
    }
    if (reqUrl.pathname === "/api/mini-program/manifest") {
      await handleMiniProgramManifest(req, res, reqUrl);
      return;
    }
    if (reqUrl.pathname === "/api/mini-program/tile-plan") {
      await handleMiniProgramTilePlan(req, res, reqUrl);
      return;
    }
    if (reqUrl.pathname === "/api/mini-program/tile-geojson") {
      await handleMiniProgramTileGeoJSON(req, res, reqUrl);
      return;
    }
    if (reqUrl.pathname === "/api/snapshot") {
      await handleSnapshot(req, res, reqUrl);
      return;
    }
    if (reqUrl.pathname === "/api/tile") {
      await handleTile(req, res, reqUrl);
      return;
    }
    if (reqUrl.pathname.startsWith("/api/glyphs/")) {
      await handleGlyph(req, res, reqUrl);
      return;
    }
    if (/^\/api\/sprite(@2x)?\.(json|png)$/.test(reqUrl.pathname)) {
      await handleSprite(req, res, reqUrl);
      return;
    }

    if (reqUrl.pathname.startsWith("/maplibre/")) {
      const filePath = safeMaplibrePath(reqUrl.pathname);
      if (!filePath || !fs.existsSync(filePath)) send(res, 404, "not found");
      else sendStatic(res, filePath);
      return;
    }

    const filePath = safePublicPath(reqUrl.pathname);
    if (!filePath || !fs.existsSync(filePath)) {
      send(res, 404, "not found");
      return;
    }
    sendStatic(res, filePath);
  } catch (error) {
    console.error(error);
    send(res, 500, error.stack || error.message);
  }
});

server.listen(PORT, HOST, () => {
  const shownHost = HOST === "0.0.0.0" ? "127.0.0.1" : HOST;
  console.log(`AllHistory official viewer: http://${shownHost}:${PORT}`);
  if (PUBLIC_ORIGIN) console.log(`Public origin: ${PUBLIC_ORIGIN}`);
});
