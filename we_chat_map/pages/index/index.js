const { API_ORIGIN, MANIFEST_URL } = require('../../utils/config')
const { renderYear } = require('../../utils/renderers')
const { TILE_SIZE, lonLatToTile, lonLatToWorldPixel, worldPixelToLonLat, makeProjector } = require('../../utils/geo')

const fallbackTimeline = buildYearRange(-3200, -1000, 50).concat(buildYearRange(-990, 1900, 1))
const vectorSourceOrder = [
  'dlsgis_base',
  'dlsgis_his_regime_water',
  'dlsgis_his_regime',
  'dlsgis_his_regime_spec',
  'dlsgis_his_regime_city',
  'dlsgis_his_regime_lonlat',
]

const vectorGeometry = {
  dlsgis_base: 'Polygon,MultiPolygon,LineString,MultiLineString',
  dlsgis_his_regime_water: 'Polygon,MultiPolygon,LineString,MultiLineString',
  dlsgis_his_regime: 'Polygon,MultiPolygon,LineString,MultiLineString',
  dlsgis_his_regime_spec: 'Point,MultiPoint,LineString,MultiLineString,Polygon,MultiPolygon',
  dlsgis_his_regime_city: 'Point,MultiPoint',
  dlsgis_his_regime_lonlat: 'LineString,MultiLineString',
}

const rasterSourceOrder = ['dlsgis_his_terrain', 'texture']

function buildYearRange(from, to, step) {
  const years = []
  for (let year = from; year <= to; year += step) years.push(year)
  return years
}

function yearNumToId(year) {
  const n = Number(year)
  return n < 0 ? `BC${Math.abs(Math.trunc(n))}` : `AD${Math.trunc(n)}`
}

function yearIdToNum(input) {
  const raw = String(input || '').trim().toUpperCase()
  if (/^BC\d+$/.test(raw)) return -Number(raw.slice(2))
  if (/^AD\d+$/.test(raw)) return Number(raw.slice(2))
  const n = Number(raw)
  if (!Number.isFinite(n) || n === 0) return 750
  return Math.trunc(n)
}

function normalizeYear(input) {
  return yearNumToId(yearIdToNum(input))
}

function expandOfficialTimeline(items) {
  const years = []
  ;(items || []).forEach((item) => {
    if (Array.isArray(item) && item.length >= 2) {
      const from = Number(item[0])
      const to = Number(item[1])
      if (Number.isFinite(from) && Number.isFinite(to)) {
        for (let year = from; year <= to; year += 1) years.push(year)
      }
    } else {
      const year = Number(item)
      if (Number.isFinite(year)) years.push(year)
    }
  })
  return Array.from(new Set(years)).sort((a, b) => a - b)
}

function appendQuery(url, params) {
  const parts = []
  Object.keys(params).forEach((key) => {
    if (params[key] !== undefined && params[key] !== '') parts.push(`${key}=${encodeURIComponent(params[key])}`)
  })
  return `${url}${url.indexOf('?') >= 0 ? '&' : '?'}${parts.join('&')}`
}

Page({
  data: {
    yearId: 'AD750',
    yearInput: 'AD750',
    snapshotUrl: '',
    status: '正在读取时间轴...',
    manifest: null,
    renderer: 'snapshot',
    tilePlanUrl: '',
    tilePlan: null,
    vectorFeatureTiles: [],
    timeline: [],
    timelineMax: 0,
    currentIndex: 0,
    timelineText: '0 / 0',
    scale: 1,
    mapX: 0,
    mapY: 0,
    restMapX: 0,
    restMapY: 0,
    mapWidth: 750,
    mapHeight: 375,
    viewportWidth: 375,
    viewportHeight: 667,
    safeTop: 24,
    pixelRatio: 1,
    vectorCenter: [106.26767430086022, 40.76057563344236],
    vectorZoom: 3,
    vectorRadius: 1,
    vectorScale: 1,
  },

  onLoad() {
    this.tilePlanCache = new Map()
    this.geoJsonCache = new Map()
    this.rasterImageCache = new Map()
    this.spriteMeta = null
    this.spriteImage = null
    this.spriteLoading = false
    this.spriteCallbacks = []
    this.vectorRequestToken = 0
    wx.setNavigationBarTitle({ title: 'AllHistory 官方地图' })
    this.initViewport()
    this.loadTimeline()
  },

  onPullDownRefresh() {
    this.loadYear(this.data.yearId)
  },

  initViewport() {
    wx.getSystemInfo({
      success: (info) => {
        const viewportWidth = info.windowWidth
        const viewportHeight = info.windowHeight
        const safeTop = (info.safeArea && Number(info.safeArea.top)) || info.statusBarHeight || 24
        const mapWidth = Math.max(viewportWidth * 2.4, viewportHeight * 1.8)
        const mapHeight = mapWidth / 2
        const restMapX = Math.round((viewportWidth - mapWidth) / 2)
        const restMapY = Math.round((viewportHeight - mapHeight) / 2 - viewportHeight * 0.08)
        this.setData({
          mapWidth,
          mapHeight,
          viewportWidth,
          viewportHeight,
          safeTop,
          mapX: restMapX,
          mapY: restMapY,
          restMapX,
          restMapY,
          pixelRatio: info.pixelRatio || 1,
        })
      },
    })
  },

  loadTimeline() {
    wx.request({
      url: MANIFEST_URL,
      success: (res) => {
        const manifest = res.data || {}
        const timeline = expandOfficialTimeline(manifest.timeline)
        this.setData({
          manifest,
          renderer: manifest.renderer || 'snapshot',
          vectorCenter: manifest.defaultCenter || this.data.vectorCenter,
          vectorZoom: manifest.renderers && manifest.renderers.vectorCanvas ? manifest.renderers.vectorCanvas.initialZoom || this.data.vectorZoom : this.data.vectorZoom,
          vectorRadius: manifest.renderers && manifest.renderers.vectorCanvas ? manifest.renderers.vectorCanvas.tileRadius || this.data.vectorRadius : this.data.vectorRadius,
        })
        this.initTimeline(timeline.length ? timeline : fallbackTimeline, manifest.defaultYear)
      },
      fail: () => {
        this.setData({
          renderer: 'snapshot',
          status: '矢量地图不可用，切换图片模式',
        })
        this.loadTimelineFallback()
      },
    })
  },

  loadTimelineFallback() {
    wx.request({
      url: `${API_ORIGIN}/api/timeline`,
      success: (res) => {
        const data = res.data && res.data.data
        const timeline = expandOfficialTimeline(data && data.timeline)
        this.initTimeline(timeline.length ? timeline : fallbackTimeline, data && data.default_year)
      },
      fail: () => {
        this.setData({
          renderer: 'snapshot',
          status: '使用本地时间轴',
        })
        this.initTimeline(fallbackTimeline, 750)
      },
    })
  },

  initTimeline(timeline, defaultYear) {
    const year = normalizeYear(defaultYear || 750)
    const index = this.nearestTimelineIndex(timeline, year)
    this.setData({
      timeline,
      timelineMax: Math.max(0, timeline.length - 1),
    })
    this.updateTimelineUi(index)
    this.loadYear(year, { keepTimeline: true })
  },

  nearestTimelineIndex(timeline, yearInput) {
    const target = yearIdToNum(yearInput)
    if (!timeline.length) return 0

    let lo = 0
    let hi = timeline.length - 1
    while (lo < hi) {
      const mid = Math.floor((lo + hi) / 2)
      if (timeline[mid] < target) lo = mid + 1
      else hi = mid
    }
    if (lo > 0 && Math.abs(timeline[lo - 1] - target) <= Math.abs(timeline[lo] - target)) return lo - 1
    return lo
  },

  updateTimelineUi(index) {
    const timeline = this.data.timeline
    const currentIndex = Math.max(0, Math.min(index, timeline.length - 1))
    const yearId = yearNumToId(timeline[currentIndex] || 750)
    this.setData({
      currentIndex,
      yearId,
      yearInput: yearId,
      timelineText: `${currentIndex + 1} / ${timeline.length}`,
    })
  },

  loadYear(input, options = {}) {
    const yearId = normalizeYear(input)
    const index = this.nearestTimelineIndex(this.data.timeline, yearId)
    if (!options.keepTimeline) this.updateTimelineUi(index)
    this.setData({
      yearId,
      yearInput: yearId,
      status: `正在加载 ${yearId}`,
    })
    this.renderYear(yearId)
  },

  renderYear(yearId) {
    const patch = renderYear(this.data.renderer, yearId, this.data.manifest)
    if (this.data.renderer === 'vectorCanvas') {
      patch.tilePlanUrl = this.buildVectorTilePlanUrl(yearId, this.data.vectorCenter, this.data.vectorZoom, this.data.vectorRadius)
    }
    this.setData(patch)
    if (this.data.renderer === 'vectorCanvas') this.drawVectorCanvasBase(yearId)
    if (patch.tilePlanUrl) this.loadTilePlan(patch.tilePlanUrl)
  },

  buildVectorTilePlanUrl(yearId, center, zoom, radius) {
    const endpoints = (this.data.manifest && this.data.manifest.endpoints) || {}
    const template = endpoints.tilePlan
    if (!template) return ''
    return String(template)
      .replace('{year}', encodeURIComponent(yearId))
      .replace('{lon}', encodeURIComponent(center[0]))
      .replace('{lat}', encodeURIComponent(center[1]))
      .replace('{z}', encodeURIComponent(zoom))
      .replace('{radius}', encodeURIComponent(radius))
  },

  cacheGet(cache, key) {
    if (!cache || !cache.has(key)) return null
    const value = cache.get(key)
    cache.delete(key)
    cache.set(key, value)
    return value
  },

  cacheSet(cache, key, value, limit) {
    if (!cache) return
    if (cache.has(key)) cache.delete(key)
    cache.set(key, value)
    while (cache.size > limit) {
      const oldest = cache.keys().next().value
      cache.delete(oldest)
    }
  },

  drawVectorCanvasBase(yearId) {
    this.withVectorCanvas((ctx, width, height) => {
      this.paintVectorBackground(ctx, width, height)
      ctx.fillStyle = 'rgba(248,241,218,0.92)'
      ctx.font = '16px sans-serif'
      ctx.fillText(`${yearId} 加载中`, 18, 28)
    })
  },

  loadTilePlan(tilePlanUrl) {
    const token = ++this.vectorRequestToken
    this.setData({
      tilePlanUrl,
      tilePlan: null,
    })
    const cached = this.cacheGet(this.tilePlanCache, tilePlanUrl)
    if (cached) {
      this.handleTilePlanLoaded(cached, token)
      return
    }
    wx.request({
      url: tilePlanUrl,
      success: (res) => {
        const plan = res.data || null
        if (plan) this.cacheSet(this.tilePlanCache, tilePlanUrl, plan, 40)
        this.handleTilePlanLoaded(plan, token)
      },
      fail: () => {
        if (token === this.vectorRequestToken) this.fallbackToSnapshot('tile plan failed')
      },
    })
  },

  handleTilePlanLoaded(plan, token) {
    if (token !== this.vectorRequestToken || this.data.renderer !== 'vectorCanvas') return
    if (!plan || !plan.sources) {
      this.fallbackToSnapshot('tile plan empty')
      return
    }
    this.setData({
      tilePlan: plan,
      status: plan && plan.sources ? `${this.data.yearId} 正在读取瓦片` : this.data.status,
    })
    if (plan) this.loadVectorFeatureTiles(plan, token)
  },

  loadVectorFeatureTiles(plan, token) {
    const center = plan.center || [106, 34]
    const centerTile = lonLatToTile(center[0], center[1], plan.zoom || 2)
    const requests = []

    vectorSourceOrder.forEach((sourceId) => {
      const source = plan.sources && plan.sources[sourceId]
      if (!source || source.type !== 'vector') return
      ;(source.tiles || [])
        .filter((tile) => tile.geojsonUrl)
        .sort((a, b) => {
          const da = Math.abs(a.x - centerTile.x) + Math.abs(a.y - centerTile.y)
          const db = Math.abs(b.x - centerTile.x) + Math.abs(b.y - centerTile.y)
          return da - db
        })
        .slice(0, 9)
        .forEach((tile) => {
          requests.push({
            sourceId,
            tile,
            url: appendQuery(tile.geojsonUrl, {
              geometry: vectorGeometry[sourceId],
              limit: sourceId === 'dlsgis_his_regime_city' ? 180 : 260,
            }),
          })
        })
    })

    if (!requests.length) {
      this.fallbackToSnapshot('no vector tiles')
      return
    }

    const loaded = []
    const maxConcurrent = 6
    let cursor = 0
    let active = 0
    let completed = 0
    this.setData({ vectorFeatureTiles: [] })

    const finishOne = () => {
      completed += 1
      active -= 1
      if (completed === requests.length) {
        this.finishVectorFeatureTiles(plan, loaded, token)
        return
      }
      pump()
    }

    const pump = () => {
      if (token !== this.vectorRequestToken || this.data.renderer !== 'vectorCanvas') return
      while (active < maxConcurrent && cursor < requests.length) {
        const request = requests[cursor]
        cursor += 1
        const cached = this.cacheGet(this.geoJsonCache, request.url)
        if (cached) {
          loaded.push({ sourceId: request.sourceId, tile: request.tile, geojson: cached })
          completed += 1
          continue
        }
        active += 1
        wx.request({
          url: request.url,
          success: (res) => {
            const geojson = res.data || null
            if (geojson && Array.isArray(geojson.features)) {
              this.cacheSet(this.geoJsonCache, request.url, geojson, 180)
              loaded.push({ sourceId: request.sourceId, tile: request.tile, geojson })
            }
          },
          complete: finishOne,
        })
      }
      if (completed === requests.length && active === 0) this.finishVectorFeatureTiles(plan, loaded, token)
    }

    pump()
  },
  finishVectorFeatureTiles(plan, loaded, token) {
    if (token !== this.vectorRequestToken || this.data.renderer !== 'vectorCanvas') return
    const featureCount = loaded.reduce((sum, item) => sum + item.geojson.features.length, 0)
    if (featureCount <= 0) {
      this.fallbackToSnapshot('vector tiles empty')
      return
    }
    this.setData({
      vectorFeatureTiles: loaded,
      status: `${this.data.yearId} 已加载`,
    })
    this.drawVectorFeatureTiles(plan, loaded, token)
  },

  withVectorCanvas(callback) {
    wx.createSelectorQuery()
      .in(this)
      .select('#vector-canvas')
      .fields({ node: true, size: true })
      .exec((res) => {
        const canvas = res && res[0] && res[0].node
        if (!canvas) {
          if (this.data.renderer === 'vectorCanvas') this.fallbackToSnapshot('canvas unavailable')
          return
        }
        const width = this.data.mapWidth
        const height = this.data.mapHeight
        const dpr = this.data.pixelRatio || 1
        canvas.width = width * dpr
        canvas.height = height * dpr
        const ctx = canvas.getContext('2d')
        ctx.scale(dpr, dpr)
        callback(ctx, width, height, canvas)
      })
  },

  drawVectorFeatureTiles(plan, featureTiles, token) {
    this.withVectorCanvas((ctx, width, height, canvas) => {
      if (token !== this.vectorRequestToken || this.data.renderer !== 'vectorCanvas') return
      const project = makeProjector(plan.center || [106, 34], plan.zoom || 2, width, height, plan.radius || 1)
      this.loadRasterImages(canvas, plan, (rasterTiles) => {
        this.loadSpriteAssets(canvas, () => {
          if (token !== this.vectorRequestToken || this.data.renderer !== 'vectorCanvas') return
          this.paintVectorBackground(ctx, width, height)
          this.drawRasterTiles(ctx, plan, rasterTiles, width, height)
          this.drawStyledVectorLayers(ctx, plan, featureTiles, project)
        })
      })
    })
  },

  loadSpriteAssets(canvas, callback) {
    if (this.spriteMeta && this.spriteImage) {
      callback()
      return
    }
    this.spriteCallbacks.push(callback)
    if (this.spriteLoading) return
    this.spriteLoading = true

    const endpoints = (this.data.manifest && this.data.manifest.endpoints) || {}
    const spriteJson = endpoints.spriteJson || `${API_ORIGIN}/api/sprite.json`
    const spritePng = endpoints.spritePng || `${API_ORIGIN}/api/sprite.png`

    wx.request({
      url: spriteJson,
      success: (res) => {
        this.spriteMeta = res.data || {}
      },
      complete: () => {
        if (!canvas || !canvas.createImage) {
          this.finishSpriteLoading()
          return
        }
        const image = canvas.createImage()
        image.onload = () => {
          this.spriteImage = image
          this.finishSpriteLoading()
        }
        image.onerror = () => {
          this.finishSpriteLoading()
        }
        image.src = spritePng
      },
    })
  },

  finishSpriteLoading() {
    this.spriteLoading = false
    const callbacks = this.spriteCallbacks.splice(0)
    callbacks.forEach((callback) => callback())
  },

  loadRasterImages(canvas, plan, callback) {
    const requests = []
    rasterSourceOrder.forEach((sourceId) => {
      const source = plan.sources && plan.sources[sourceId]
      if (!source || source.type !== 'raster') return
      ;(source.tiles || []).forEach((tile) => {
        if (tile.url) requests.push({ sourceId, tile })
      })
    })
    if (!requests.length || !canvas || !canvas.createImage) {
      callback([])
      return
    }

    const loaded = []
    let pending = requests.length
    const done = () => {
      pending -= 1
      if (pending === 0) callback(loaded)
    }

    requests.forEach((request) => {
      const cached = this.cacheGet(this.rasterImageCache, request.tile.url)
      if (cached) {
        loaded.push({ ...request, image: cached })
        done()
        return
      }
      const image = canvas.createImage()
      image.onload = () => {
        this.cacheSet(this.rasterImageCache, request.tile.url, image, 80)
        loaded.push({ ...request, image })
        done()
      }
      image.onerror = done
      image.src = request.tile.url
    })
  },

  drawRasterTiles(ctx, plan, rasterTiles, width, height) {
    rasterSourceOrder.forEach((sourceId) => {
      rasterTiles
        .filter((item) => item.sourceId === sourceId)
        .forEach((item) => {
          const rect = this.tileRect(plan, item.tile, width, height)
          if (!rect) return
          ctx.save()
          if (sourceId === 'texture') ctx.globalAlpha = 0.3
          ctx.drawImage(item.image, rect.x, rect.y, rect.width, rect.height)
          ctx.restore()
        })
    })
  },

  tileRect(plan, tile, width, height) {
    const center = plan.center || [106, 34]
    const zoom = Number(plan.zoom || tile.z || 2)
    const centerPx = lonLatToWorldPixel(center[0], center[1], zoom, TILE_SIZE)
    const span = TILE_SIZE * (Math.max(0, Number(plan.radius) || 1) * 2 + 1)
    const scale = Math.min(width / span, height / span)
    const worldSize = centerPx.worldSize
    let left = Number(tile.x) * TILE_SIZE - centerPx.x
    if (left > worldSize / 2) left -= worldSize
    if (left < -worldSize / 2) left += worldSize
    const top = Number(tile.y) * TILE_SIZE - centerPx.y
    return {
      x: width / 2 + left * scale,
      y: height / 2 + top * scale,
      width: TILE_SIZE * scale,
      height: TILE_SIZE * scale,
    }
  },

  paintVectorBackground(ctx, width, height) {
    ctx.fillStyle = '#4f8cad'
    ctx.fillRect(0, 0, width, height)
  },

  drawStyledVectorLayers(ctx, plan, featureTiles, project) {
    const featuresBySource = {}
    this.labelBoxes = []
    featureTiles.forEach((item) => {
      if (!featuresBySource[item.sourceId]) featuresBySource[item.sourceId] = []
      ;(item.geojson.features || []).forEach((feature) => featuresBySource[item.sourceId].push(feature))
    })

    const drawn = new Set()
    ;(plan.layers || []).forEach((layer) => {
      if (!this.isDrawableStyleLayer(layer, plan.zoom)) return
      const features = featuresBySource[layer.source] || []
      features.forEach((feature, index) => {
        const props = feature.properties || {}
        if (layer.sourceLayer && props._layer !== layer.sourceLayer) return
        if (!this.layerFilterPass(layer.filter, props)) return
        const key = `${props._source}:${props._layer}:${props.oid || index}:${feature.geometry && feature.geometry.type}`
        drawn.add(key)
        this.drawLayerFeature(ctx, layer, feature, project, plan.zoom)
      })
    })

    vectorSourceOrder.forEach((sourceId) => {
      ;(featuresBySource[sourceId] || []).forEach((feature, index) => {
        const props = feature.properties || {}
        const keyPrefix = `${props._source}:${props._layer}:${props.oid || index}:${feature.geometry && feature.geometry.type}`
        if (!drawn.has(keyPrefix)) {
          this.applyFeatureStyle(ctx, sourceId, feature)
          this.drawFeatureGeometry(ctx, feature.geometry, project, sourceId, props)
        }
      })
    })
  },

  isDrawableStyleLayer(layer, zoom) {
    if (!layer || !layer.source || !layer.sourceLayer) return false
    if (layer.layout && layer.layout.visibility === 'none') return false
    if (typeof layer.minzoom === 'number' && zoom < layer.minzoom) return false
    if (typeof layer.maxzoom === 'number' && zoom >= layer.maxzoom) return false
    return layer.type === 'fill' || layer.type === 'line' || layer.type === 'circle' || layer.type === 'symbol'
  },

  layerFilterPass(filter, props) {
    if (!Array.isArray(filter) || !filter.length) return true
    const op = filter[0]
    if (op === 'all') return filter.slice(1).every((item) => this.layerFilterPass(item, props))
    if (op === 'any') return filter.slice(1).some((item) => this.layerFilterPass(item, props))
    if (op === 'none') return !filter.slice(1).some((item) => this.layerFilterPass(item, props))
    const key = filter[1]
    const expected = filter[2]
    const actual = props[key]
    if (op === '==') return actual === expected
    if (op === '!=') return actual !== expected
    if (op === 'in') return filter.slice(2).includes(actual)
    if (op === '!in') return !filter.slice(2).includes(actual)
    if (op === 'has') return Object.prototype.hasOwnProperty.call(props, key)
    if (op === '!has') return !Object.prototype.hasOwnProperty.call(props, key)
    return true
  },

  drawLayerFeature(ctx, layer, feature, project, zoom) {
    const geometry = feature.geometry
    if (!geometry) return
    const props = feature.properties || {}
    ctx.save()
    this.applyLayerPaint(ctx, layer, props, zoom)
    if (layer.type === 'fill') {
      this.drawFillGeometry(ctx, geometry, project)
    } else if (layer.type === 'line') {
      this.drawStrokeGeometry(ctx, geometry, project)
    } else if (layer.type === 'circle') {
      this.drawCircleGeometry(ctx, geometry, project, layer, props, zoom)
    } else if (layer.type === 'symbol') {
      this.drawSymbolGeometry(ctx, geometry, project, layer, props, zoom)
    }
    ctx.restore()
  },

  applyLayerPaint(ctx, layer, props, zoom) {
    const paint = layer.paint || {}
    if (layer.type === 'fill') {
      ctx.fillStyle = this.colorWithAlpha(
        this.resolvePaint(paint['fill-color'], props, props.color || '#d8c99c', zoom),
        this.resolveNumber(paint['fill-opacity'], props, 1, zoom)
      )
      ctx.strokeStyle = 'rgba(73,60,45,0.22)'
      ctx.lineWidth = 0.6
    } else if (layer.type === 'line') {
      ctx.strokeStyle = this.colorWithAlpha(
        this.resolvePaint(paint['line-color'], props, props.bordercolor || props.color || '#3a2d24', zoom),
        this.resolveNumber(paint['line-opacity'], props, props.borderopacity || props.opacity || 1, zoom)
      )
      ctx.lineWidth = Math.max(0.4, this.resolveNumber(paint['line-width'], props, props.width || 1, zoom))
      if (paint['line-dasharray']) ctx.setLineDash(Array.isArray(paint['line-dasharray']) ? paint['line-dasharray'] : [])
    } else if (layer.type === 'circle') {
      ctx.fillStyle = this.colorWithAlpha(
        this.resolvePaint(paint['circle-color'], props, props.color || '#2f241f', zoom),
        this.resolveNumber(paint['circle-opacity'], props, 1, zoom)
      )
      ctx.strokeStyle = this.colorWithAlpha(
        this.resolvePaint(paint['circle-stroke-color'], props, '#f8f1da', zoom),
        this.resolveNumber(paint['circle-stroke-opacity'], props, 1, zoom)
      )
      ctx.lineWidth = this.resolveNumber(paint['circle-stroke-width'], props, 1, zoom)
    } else if (layer.type === 'symbol') {
      ctx.fillStyle = this.colorWithAlpha(
        this.resolvePaint(paint['text-color'], props, props.color || '#2d241f', zoom),
        this.resolveNumber(paint['text-opacity'], props, 1, zoom)
      )
      ctx.strokeStyle = this.colorWithAlpha(
        this.resolvePaint(paint['text-halo-color'], props, '#f8f1da', zoom),
        this.resolveNumber(paint['text-halo-opacity'], props, 0.85, zoom)
      )
      ctx.lineWidth = this.resolveNumber(paint['text-halo-width'], props, props.halo || 1.2, zoom)
    }
  },

  resolvePaint(value, props, fallback, zoom) {
    if (value === undefined || value === null) return fallback
    if (typeof value === 'object' && value.property) {
      const propValue = props[value.property]
      return propValue === undefined || propValue === null || propValue === '' ? fallback : propValue
    }
    if (Array.isArray(value)) return this.resolveExpression(value, props, fallback, zoom)
    return value
  },

  resolveNumber(value, props, fallback, zoom) {
    const resolved = this.resolvePaint(value, props, fallback, zoom)
    const n = Number(resolved)
    return Number.isFinite(n) ? n : fallback
  },

  resolveExpression(expr, props, fallback, zoom) {
    if (!Array.isArray(expr) || !expr.length) return fallback
    const op = expr[0]
    if (op === 'get') return props[expr[1]] ?? fallback
    if (op === 'literal') return expr[1]
    if (op === 'zoom') return Number(zoom || 0)
    if (op === 'interpolate') return this.resolveInterpolate(expr, props, fallback, zoom)
    if (op === 'step') return this.resolveStep(expr, props, fallback, zoom)
    return fallback
  },

  expressionInput(expr, props, zoom) {
    if (Array.isArray(expr)) return this.resolveExpression(expr, props, 0, zoom)
    return Number(expr)
  },

  resolveInterpolate(expr, props, fallback, zoom) {
    const input = Number(this.expressionInput(expr[2], props, zoom))
    const stops = expr.slice(3)
    if (!Number.isFinite(input) || stops.length < 2) return fallback
    let previousStop = Number(stops[0])
    let previousValue = stops[1]
    if (input <= previousStop) return previousValue
    for (let i = 2; i < stops.length; i += 2) {
      const stop = Number(stops[i])
      const value = stops[i + 1]
      if (input <= stop) {
        const a = Number(previousValue)
        const b = Number(value)
        if (!Number.isFinite(a) || !Number.isFinite(b) || stop === previousStop) return value
        const t = (input - previousStop) / (stop - previousStop)
        return a + (b - a) * t
      }
      previousStop = stop
      previousValue = value
    }
    return previousValue
  },

  resolveStep(expr, props, fallback, zoom) {
    const input = Number(this.expressionInput(expr[1], props, zoom))
    if (!Number.isFinite(input)) return fallback
    let value = expr[2]
    for (let i = 3; i < expr.length; i += 2) {
      const stop = Number(expr[i])
      if (input < stop) return value
      value = expr[i + 1]
    }
    return value
  },

  colorWithAlpha(color, alpha) {
    const opacity = Math.max(0, Math.min(1, Number(alpha)))
    const raw = String(color || '').trim()
    const hex = raw.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)
    if (hex) {
      let value = hex[1]
      if (value.length === 3) value = value.split('').map((ch) => ch + ch).join('')
      const r = parseInt(value.slice(0, 2), 16)
      const g = parseInt(value.slice(2, 4), 16)
      const b = parseInt(value.slice(4, 6), 16)
      return `rgba(${r},${g},${b},${opacity})`
    }
    if (/^rgba?\(/i.test(raw)) return raw
    return opacity < 1 ? `rgba(216,201,156,${opacity})` : raw || '#d8c99c'
  },

  drawFillGeometry(ctx, geometry, project) {
    if (geometry.type === 'Polygon') {
      this.drawFillPolygon(ctx, geometry.coordinates.map((ring) => ring.map(project)))
    } else if (geometry.type === 'MultiPolygon') {
      geometry.coordinates.forEach((polygon) => this.drawFillPolygon(ctx, polygon.map((ring) => ring.map(project))))
    }
  },

  drawFillPolygon(ctx, rings) {
    if (!rings.length) return
    ctx.beginPath()
    rings.forEach((ring) => {
      if (!ring.length) return
      ctx.moveTo(ring[0][0], ring[0][1])
      ring.slice(1).forEach((point) => ctx.lineTo(point[0], point[1]))
      ctx.closePath()
    })
    ctx.fill()
  },

  drawStrokeGeometry(ctx, geometry, project) {
    if (geometry.type === 'LineString') {
      this.drawLine(ctx, geometry.coordinates.map(project))
    } else if (geometry.type === 'MultiLineString') {
      geometry.coordinates.forEach((line) => this.drawLine(ctx, line.map(project)))
    } else if (geometry.type === 'Polygon') {
      geometry.coordinates.forEach((ring) => this.drawLine(ctx, ring.map(project)))
    } else if (geometry.type === 'MultiPolygon') {
      geometry.coordinates.forEach((polygon) => polygon.forEach((ring) => this.drawLine(ctx, ring.map(project))))
    }
  },

  drawCircleGeometry(ctx, geometry, project, layer, props, zoom) {
    const paint = layer.paint || {}
    const radius = this.resolveNumber(paint['circle-radius'], props, 3, zoom)
    const draw = (coord) => {
      const point = project(coord)
      ctx.beginPath()
      ctx.arc(point[0], point[1], radius, 0, Math.PI * 2)
      ctx.fill()
      if (ctx.lineWidth > 0) ctx.stroke()
    }
    if (geometry.type === 'Point') draw(geometry.coordinates)
    if (geometry.type === 'MultiPoint') geometry.coordinates.forEach(draw)
  },

  drawSymbolGeometry(ctx, geometry, project, layer, props, zoom) {
    const text = this.resolveText(layer.layout && layer.layout['text-field'], props)
    const iconName = this.resolveText(layer.layout && layer.layout['icon-image'], props)
    if (!text && !iconName) return
    const size = this.resolveNumber(layer.layout && layer.layout['text-size'], props, props.fontsize || 12, zoom)
    const iconSize = this.resolveNumber(layer.layout && layer.layout['icon-size'], props, 1, zoom)
    const offset = this.resolveOffset(layer.layout && layer.layout['text-offset'], props, zoom)
    const iconOverlap = Boolean(layer.layout && (layer.layout['icon-allow-overlap'] || layer.layout['icon-ignore-placement']))
    const textOverlap = Boolean(layer.layout && (layer.layout['text-allow-overlap'] || layer.layout['text-ignore-placement']))
    ctx.font = `${Math.max(10, size)}px sans-serif`
    const draw = (coord) => {
      const point = project(coord)
      const iconBox = this.spriteIconBox(iconName, point[0], point[1], iconSize)
      const textX = point[0] + offset[0] * size
      const textY = point[1] + offset[1] * size
      const textBox = text ? this.textBox(ctx, text, textX, textY, size) : null
      const combinedBox = this.combineBoxes(iconBox, textBox)
      if (combinedBox && !iconOverlap && !textOverlap && this.boxCollides(combinedBox)) return
      if (iconBox && (iconOverlap || !this.boxCollides(iconBox))) {
        this.drawSpriteIcon(ctx, iconName, point[0], point[1], iconSize)
        this.labelBoxes.push(iconBox)
      }
      if (!text) {
        if (combinedBox && !iconBox) this.labelBoxes.push(combinedBox)
        return
      }
      if (textBox && !textOverlap && this.boxCollides(textBox)) return
      if (ctx.lineWidth > 0) ctx.strokeText(text, textX, textY)
      ctx.fillText(text, textX, textY)
      if (textBox) this.labelBoxes.push(textBox)
    }
    if (geometry.type === 'Point') draw(geometry.coordinates)
    if (geometry.type === 'MultiPoint') geometry.coordinates.forEach(draw)
  },

  drawSpriteIcon(ctx, iconName, x, y, iconSize) {
    const name = String(iconName || '').trim()
    if (!name || !this.spriteImage || !this.spriteMeta || !this.spriteMeta[name]) return
    const meta = this.spriteMeta[name]
    const pixelRatio = Number(meta.pixelRatio || 1)
    const srcX = Number(meta.x || 0)
    const srcY = Number(meta.y || 0)
    const srcW = Number(meta.width || 0)
    const srcH = Number(meta.height || 0)
    if (!srcW || !srcH) return
    const drawW = (srcW / pixelRatio) * Math.max(0.2, Number(iconSize) || 1)
    const drawH = (srcH / pixelRatio) * Math.max(0.2, Number(iconSize) || 1)
    ctx.drawImage(this.spriteImage, srcX, srcY, srcW, srcH, x - drawW / 2, y - drawH / 2, drawW, drawH)
  },

  spriteIconBox(iconName, x, y, iconSize) {
    const name = String(iconName || '').trim()
    if (!name || !this.spriteMeta || !this.spriteMeta[name]) return null
    const meta = this.spriteMeta[name]
    const pixelRatio = Number(meta.pixelRatio || 1)
    const width = (Number(meta.width || 0) / pixelRatio) * Math.max(0.2, Number(iconSize) || 1)
    const height = (Number(meta.height || 0) / pixelRatio) * Math.max(0.2, Number(iconSize) || 1)
    if (!width || !height) return null
    return this.padBox({ x1: x - width / 2, y1: y - height / 2, x2: x + width / 2, y2: y + height / 2 }, 2)
  },

  textBox(ctx, text, x, y, size) {
    const metrics = ctx.measureText(String(text))
    const width = metrics.width || String(text).length * size
    const height = Math.max(10, Number(size) || 12)
    return this.padBox({ x1: x, y1: y - height, x2: x + width, y2: y + height * 0.25 }, 2)
  },

  combineBoxes(a, b) {
    if (!a) return b
    if (!b) return a
    return {
      x1: Math.min(a.x1, b.x1),
      y1: Math.min(a.y1, b.y1),
      x2: Math.max(a.x2, b.x2),
      y2: Math.max(a.y2, b.y2),
    }
  },

  padBox(box, pad) {
    return {
      x1: box.x1 - pad,
      y1: box.y1 - pad,
      x2: box.x2 + pad,
      y2: box.y2 + pad,
    }
  },

  boxCollides(box) {
    if (!box) return false
    return (this.labelBoxes || []).some((other) => (
      box.x1 < other.x2 &&
      box.x2 > other.x1 &&
      box.y1 < other.y2 &&
      box.y2 > other.y1
    ))
  },

  resolveText(value, props) {
    if (!value) return props['name:cn'] || props.name || props.title || ''
    if (typeof value === 'string') {
      return value.replace(/\{([^}]+)\}/g, (_, key) => props[key] || '')
    }
    return props['name:cn'] || props.name || props.title || ''
  },

  resolveOffset(value, props, zoom) {
    const resolved = this.resolvePaint(value, props, [0, 0.5], zoom)
    if (Array.isArray(resolved) && resolved.length >= 2) {
      return [Number(resolved[0]) || 0, Number(resolved[1]) || 0]
    }
    if (typeof resolved === 'string') {
      const parts = resolved.split(',').map((item) => Number(item.trim()))
      if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) return [parts[0], parts[1]]
    }
    return [0, 0.5]
  },

  drawVectorFeaturesInContext(ctx, sourceId, geojson, project) {
    ;(geojson.features || []).forEach((feature) => {
      this.applyFeatureStyle(ctx, sourceId, feature)
      this.drawFeatureGeometry(ctx, feature.geometry, project, sourceId, feature.properties || {})
    })
  },

  applyFeatureStyle(ctx, sourceId, feature) {
    const props = feature.properties || {}
    const color = props.color || props.fill || ''
    if (sourceId === 'dlsgis_base') {
      ctx.fillStyle = color || '#d8c99c'
      ctx.strokeStyle = 'rgba(89,78,58,0.28)'
      ctx.lineWidth = 0.8
    } else if (sourceId === 'dlsgis_his_regime_water') {
      ctx.fillStyle = 'rgba(84,139,171,0.88)'
      ctx.strokeStyle = 'rgba(68,119,148,0.62)'
      ctx.lineWidth = 0.8
    } else if (sourceId === 'dlsgis_his_regime') {
      ctx.fillStyle = color || 'rgba(238,196,112,0.58)'
      ctx.strokeStyle = 'rgba(43,34,29,0.62)'
      ctx.lineWidth = 1
    } else if (sourceId === 'dlsgis_his_regime_city') {
      ctx.fillStyle = '#2f241f'
      ctx.strokeStyle = 'rgba(248,241,218,0.88)'
      ctx.lineWidth = 1.2
    } else {
      ctx.fillStyle = 'rgba(248,241,218,0.72)'
      ctx.strokeStyle = 'rgba(54,44,35,0.5)'
      ctx.lineWidth = 0.8
    }
  },

  drawFeatureGeometry(ctx, geometry, project, sourceId, props) {
    if (!geometry) return
    if (geometry.type === 'Point') {
      this.drawPoint(ctx, project(geometry.coordinates), sourceId, props)
    } else if (geometry.type === 'MultiPoint') {
      geometry.coordinates.forEach((point) => this.drawPoint(ctx, project(point), sourceId, props))
    } else if (geometry.type === 'LineString') {
      this.drawLine(ctx, geometry.coordinates.map(project))
    } else if (geometry.type === 'MultiLineString') {
      geometry.coordinates.forEach((line) => this.drawLine(ctx, line.map(project)))
    } else if (geometry.type === 'Polygon') {
      this.drawPolygon(ctx, geometry.coordinates.map((ring) => ring.map(project)))
    } else if (geometry.type === 'MultiPolygon') {
      geometry.coordinates.forEach((polygon) => this.drawPolygon(ctx, polygon.map((ring) => ring.map(project))))
    }
  },

  drawPoint(ctx, point, sourceId, props) {
    const radius = sourceId === 'dlsgis_his_regime_city' ? 3.2 : 2.2
    ctx.beginPath()
    ctx.arc(point[0], point[1], radius, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
    const name = props['name:cn'] || props.name || ''
    if (name && sourceId === 'dlsgis_his_regime_city') {
      ctx.fillStyle = 'rgba(33,28,24,0.86)'
      ctx.font = '12px sans-serif'
      ctx.fillText(String(name).slice(0, 8), point[0] + 5, point[1] - 5)
    }
  },

  drawLine(ctx, points) {
    if (!points.length) return
    ctx.beginPath()
    ctx.moveTo(points[0][0], points[0][1])
    points.slice(1).forEach((point) => ctx.lineTo(point[0], point[1]))
    ctx.stroke()
  },

  drawPolygon(ctx, rings) {
    if (!rings.length) return
    ctx.beginPath()
    rings.forEach((ring) => {
      if (!ring.length) return
      ctx.moveTo(ring[0][0], ring[0][1])
      ring.slice(1).forEach((point) => ctx.lineTo(point[0], point[1]))
      ctx.closePath()
    })
    ctx.fill()
    ctx.stroke()
  },

  handleSnapshotLoad() {
    wx.stopPullDownRefresh()
    this.setData({ status: `${this.data.yearId} 已加载` })
  },

  handleSnapshotError() {
    wx.stopPullDownRefresh()
    this.setData({ status: `${this.data.yearId} 加载失败` })
    wx.showToast({
      title: '地图加载失败',
      icon: 'none',
    })
  },

  fallbackToSnapshot(reason) {
    if (this.data.renderer !== 'vectorCanvas') return
    this.vectorRequestToken += 1
    const patch = renderYear('snapshot', this.data.yearId, this.data.manifest)
    this.setData({
      ...patch,
      renderer: 'snapshot',
      tilePlan: null,
      tilePlanUrl: '',
      status: `${this.data.yearId} 图片模式`,
    })
    if (reason) console.warn && console.warn(`vectorCanvas fallback: ${reason}`)
  },

  handleMapMove(event) {
    if (this.data.renderer !== 'vectorCanvas') return
    const detail = event.detail || {}
    this.setData({
      mapX: Number.isFinite(Number(detail.x)) ? Number(detail.x) : this.data.mapX,
      mapY: Number.isFinite(Number(detail.y)) ? Number(detail.y) : this.data.mapY,
    })
    this.scheduleVectorViewportRefresh()
  },

  handleMapScale(event) {
    if (this.data.renderer !== 'vectorCanvas') return
    const detail = event.detail || {}
    const nextScale = Math.max(1, Math.min(4, Number(detail.scale || this.data.vectorScale || 1)))
    const baseZoom = Number((this.data.manifest && this.data.manifest.renderers && this.data.manifest.renderers.vectorCanvas && this.data.manifest.renderers.vectorCanvas.initialZoom) || 3)
    this.setData({
      vectorScale: nextScale,
      scale: nextScale,
      vectorZoom: Math.max(2, Math.min(6, Math.round(baseZoom + Math.log(nextScale) / Math.log(2)))),
      mapX: Number(detail.x !== undefined ? detail.x : this.data.mapX),
      mapY: Number(detail.y !== undefined ? detail.y : this.data.mapY),
    })
    this.scheduleVectorViewportRefresh()
  },

  scheduleVectorViewportRefresh() {
    if (this.vectorViewportTimer) clearTimeout(this.vectorViewportTimer)
    this.vectorViewportTimer = setTimeout(() => {
      this.refreshVectorViewport()
    }, 650)
  },

  refreshVectorViewport() {
    if (this.data.renderer !== 'vectorCanvas') return
    const center = this.estimateViewportCenter()
    const tilePlanUrl = this.buildVectorTilePlanUrl(this.data.yearId, center, this.data.vectorZoom, this.data.vectorRadius)
    if (!tilePlanUrl || tilePlanUrl === this.data.tilePlanUrl) return
    this.setData({
      vectorCenter: center,
      tilePlanUrl,
      mapX: this.data.restMapX,
      mapY: this.data.restMapY,
      status: `正在加载 ${this.data.yearId} 视野`,
    })
    this.drawVectorCanvasBase(this.data.yearId)
    this.loadTilePlan(tilePlanUrl)
  },

  estimateViewportCenter() {
    const zoom = Number(this.data.vectorZoom || 3)
    const center = this.data.vectorCenter || [106, 34]
    const centerPx = lonLatToWorldPixel(center[0], center[1], zoom, TILE_SIZE)
    const span = TILE_SIZE * (Math.max(0, Number(this.data.vectorRadius) || 1) * 2 + 1)
    const renderScale = Math.min(this.data.mapWidth / span, this.data.mapHeight / span)
    const viewScale = Math.max(1, Number(this.data.vectorScale || 1))
    const canvasCenterX = (this.data.viewportWidth / 2 - this.data.mapX) / viewScale
    const canvasCenterY = (this.data.viewportHeight / 2 - this.data.mapY) / viewScale
    const dx = (canvasCenterX - this.data.mapWidth / 2) / renderScale
    const dy = (canvasCenterY - this.data.mapHeight / 2) / renderScale
    const next = worldPixelToLonLat(centerPx.x + dx, centerPx.y + dy, zoom, TILE_SIZE)
    return [Number(next[0].toFixed(6)), Number(next[1].toFixed(6))]
  },

  handleSubmit(event) {
    const value = event.detail.value && event.detail.value.year
    this.commitYearInput(value)
  },

  handleYearConfirm(event) {
    this.commitYearInput(event.detail.value)
  },

  handleYearBlur(event) {
    this.commitYearInput(event.detail.value)
  },

  commitYearInput(value) {
    const yearId = normalizeYear(value)
    if (this.lastCommittedYear === yearId && yearId === this.data.yearId) return
    this.lastCommittedYear = yearId
    if (yearId !== this.data.yearId) this.loadYear(yearId)
    else this.setData({ yearInput: yearId })
  },

  handleSliderChanging(event) {
    this.updateTimelineUi(Number(event.detail.value))
  },

  handleSliderChange(event) {
    const index = Number(event.detail.value)
    this.updateTimelineUi(index)
    this.loadYear(yearNumToId(this.data.timeline[index]), { keepTimeline: true })
  },

  handlePrev() {
    const index = Math.max(0, this.data.currentIndex - 1)
    this.updateTimelineUi(index)
    this.loadYear(yearNumToId(this.data.timeline[index]), { keepTimeline: true })
  },

  handleNext() {
    const index = Math.min(this.data.timeline.length - 1, this.data.currentIndex + 1)
    this.updateTimelineUi(index)
    this.loadYear(yearNumToId(this.data.timeline[index]), { keepTimeline: true })
  },
})
