const API_ORIGIN = 'https://map.ixn.asia'

// Native canvas is the default target. The page falls back to snapshot if the
// vector renderer cannot load enough data.
const MINI_RENDERER = 'vectorCanvas'
const MANIFEST_URL = `${API_ORIGIN}/api/mini-program/manifest${MINI_RENDERER ? `?renderer=${MINI_RENDERER}` : ''}`

function buildSnapshotUrl(year) {
  return `${API_ORIGIN}/api/snapshot?year=${encodeURIComponent(year)}`
}

module.exports = {
  API_ORIGIN,
  MANIFEST_URL,
  MINI_RENDERER,
  buildSnapshotUrl,
}
