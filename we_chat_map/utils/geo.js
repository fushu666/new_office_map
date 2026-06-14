const MAX_LATITUDE = 85.05112878
const TILE_SIZE = 256

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value))
}

function lonLatToTile(lon, lat, zoom) {
  const z = Number(zoom)
  const n = 2 ** z
  const safeLat = clamp(Number(lat), -MAX_LATITUDE, MAX_LATITUDE)
  const latRad = (safeLat * Math.PI) / 180
  const x = Math.floor(((Number(lon) + 180) / 360) * n)
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n)
  return {
    z,
    x: clamp(x, 0, n - 1),
    y: clamp(y, 0, n - 1),
  }
}

function lonLatToWorldPixel(lon, lat, zoom, tileSize = TILE_SIZE) {
  const z = Number(zoom)
  const worldSize = tileSize * 2 ** z
  const safeLat = clamp(Number(lat), -MAX_LATITUDE, MAX_LATITUDE)
  const sin = Math.sin((safeLat * Math.PI) / 180)
  return {
    x: ((Number(lon) + 180) / 360) * worldSize,
    y: (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * worldSize,
    worldSize,
  }
}

function worldPixelToLonLat(x, y, zoom, tileSize = TILE_SIZE) {
  const worldSize = tileSize * 2 ** Number(zoom)
  const wrappedX = ((Number(x) % worldSize) + worldSize) % worldSize
  const lon = (wrappedX / worldSize) * 360 - 180
  const mercatorY = 0.5 - Number(y) / worldSize
  const lat = (90 - (360 * Math.atan(Math.exp(-mercatorY * 2 * Math.PI))) / Math.PI)
  return [lon, clamp(lat, -MAX_LATITUDE, MAX_LATITUDE)]
}

function makeProjector(center, zoom, width, height, radius, tileSize = TILE_SIZE) {
  const centerPx = lonLatToWorldPixel(center[0], center[1], zoom, tileSize)
  const span = tileSize * (Math.max(0, Number(radius) || 1) * 2 + 1)
  const scale = Math.min(width / span, height / span)
  return (coord) => {
    const px = lonLatToWorldPixel(coord[0], coord[1], zoom, tileSize)
    let dx = px.x - centerPx.x
    if (dx > px.worldSize / 2) dx -= px.worldSize
    if (dx < -px.worldSize / 2) dx += px.worldSize
    return [
      width / 2 + dx * scale,
      height / 2 + (px.y - centerPx.y) * scale,
    ]
  }
}

function tileToBounds(z, x, y) {
  const n = 2 ** Number(z)
  const west = (Number(x) / n) * 360 - 180
  const east = ((Number(x) + 1) / n) * 360 - 180
  const northRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * Number(y)) / n)))
  const southRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * (Number(y) + 1)) / n)))
  return {
    west,
    east,
    north: (northRad * 180) / Math.PI,
    south: (southRad * 180) / Math.PI,
  }
}

function tilesForViewport(center, zoom, radius) {
  const tile = lonLatToTile(center[0], center[1], zoom)
  const tiles = []
  const r = Math.max(0, Math.trunc(radius || 1))
  const n = 2 ** Number(zoom)
  for (let dx = -r; dx <= r; dx += 1) {
    for (let dy = -r; dy <= r; dy += 1) {
      const x = (tile.x + dx + n) % n
      const y = tile.y + dy
      if (y >= 0 && y < n) tiles.push({ z: tile.z, x, y })
    }
  }
  return tiles
}

module.exports = {
  TILE_SIZE,
  lonLatToTile,
  lonLatToWorldPixel,
  worldPixelToLonLat,
  makeProjector,
  tileToBounds,
  tilesForViewport,
}
