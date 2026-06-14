const { buildSnapshotUrl } = require('./config')

function fillTemplate(template, params) {
  return String(template || '').replace(/\{(\w+)\}/g, (_, key) => encodeURIComponent(params[key] || ''))
}

function snapshotRenderer(yearId, manifest) {
  const template = manifest && manifest.endpoints && manifest.endpoints.snapshot
  return {
    snapshotUrl: template ? fillTemplate(template, { year: yearId }) : buildSnapshotUrl(yearId),
  }
}

function vectorCanvasRenderer(yearId, manifest) {
  const vector = manifest && manifest.renderers && manifest.renderers.vectorCanvas
  const endpoints = (manifest && manifest.endpoints) || {}
  const center = manifest && manifest.defaultCenter ? manifest.defaultCenter : [106.26767430086022, 40.76057563344236]
  const zoom = (vector && vector.initialZoom) || (manifest && manifest.defaultZoom) || 2
  const radius = (vector && vector.tileRadius) || 1
  return {
    ...snapshotRenderer(yearId, manifest),
    rendererFallback: 'snapshot',
    tilePlanUrl: endpoints.tilePlan
      ? fillTemplate(endpoints.tilePlan, {
          year: yearId,
          lon: center[0],
          lat: center[1],
          z: zoom,
          radius,
        })
      : '',
  }
}

function renderYear(renderer, yearId, manifest) {
  if (renderer === 'vectorCanvas') return vectorCanvasRenderer(yearId, manifest)
  return snapshotRenderer(yearId, manifest)
}

module.exports = {
  fillTemplate,
  renderYear,
}
