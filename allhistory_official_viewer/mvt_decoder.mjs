function readVarint(reader) {
  let val = 0n;
  let shift = 0n;
  while (true) {
    if (reader.pos >= reader.end) throw new Error("EOF varint");
    const b = reader.buf[reader.pos++];
    val |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return val;
    shift += 7n;
  }
}

function makeReader(buf) {
  return {
    buf,
    pos: 0,
    end: buf.length,
    readVarint() { return readVarint(this); },
    readBytes(len) {
      const start = this.pos;
      this.pos += len;
      return this.buf.subarray(start, start + len);
    },
    readString(len) { return this.readBytes(len).toString("utf8"); },
    readFloat() {
      const value = this.buf.readFloatLE(this.pos);
      this.pos += 4;
      return value;
    },
    readDouble() {
      const value = this.buf.readDoubleLE(this.pos);
      this.pos += 8;
      return value;
    },
    skip(wireType) {
      if (wireType === 0) this.readVarint();
      else if (wireType === 1) this.pos += 8;
      else if (wireType === 2) this.pos += Number(this.readVarint());
      else if (wireType === 5) this.pos += 4;
      else throw new Error(`unsupported wire type ${wireType}`);
    },
  };
}

function zigzag(n) {
  n = BigInt(n);
  return Number((n >> 1n) ^ (-(n & 1n)));
}

function parsePackedVarints(bytes) {
  const reader = makeReader(bytes);
  const values = [];
  while (reader.pos < reader.end) values.push(Number(reader.readVarint()));
  return values;
}

function parseValue(bytes) {
  const reader = makeReader(bytes);
  let value = null;
  while (reader.pos < reader.end) {
    const tag = Number(reader.readVarint());
    const field = tag >> 3;
    const wireType = tag & 7;
    if (field === 1) value = reader.readString(Number(reader.readVarint()));
    else if (field === 2) value = reader.readFloat();
    else if (field === 3) value = reader.readDouble();
    else if (field === 4) value = Number(reader.readVarint());
    else if (field === 5) value = Number(BigInt.asIntN(64, reader.readVarint()));
    else if (field === 6) value = zigzag(reader.readVarint());
    else if (field === 7) value = Boolean(Number(reader.readVarint()));
    else reader.skip(wireType);
  }
  return value;
}

function parseFeature(bytes) {
  const reader = makeReader(bytes);
  const feature = { id: null, tags: [], type: null, geometry: [] };
  while (reader.pos < reader.end) {
    const tag = Number(reader.readVarint());
    const field = tag >> 3;
    const wireType = tag & 7;
    if (field === 1) feature.id = Number(reader.readVarint());
    else if (field === 2) feature.tags = parsePackedVarints(reader.readBytes(Number(reader.readVarint())));
    else if (field === 3) feature.type = Number(reader.readVarint());
    else if (field === 4) feature.geometry = parsePackedVarints(reader.readBytes(Number(reader.readVarint())));
    else reader.skip(wireType);
  }
  return feature;
}

function parseLayer(bytes) {
  const reader = makeReader(bytes);
  const layer = { version: null, name: null, features: [], keys: [], values: [], extent: 4096 };
  while (reader.pos < reader.end) {
    const tag = Number(reader.readVarint());
    const field = tag >> 3;
    const wireType = tag & 7;
    if (field === 15) layer.version = Number(reader.readVarint());
    else if (field === 1) layer.name = reader.readString(Number(reader.readVarint()));
    else if (field === 2) layer.features.push(parseFeature(reader.readBytes(Number(reader.readVarint()))));
    else if (field === 3) layer.keys.push(reader.readString(Number(reader.readVarint())));
    else if (field === 4) layer.values.push(parseValue(reader.readBytes(Number(reader.readVarint()))));
    else if (field === 5) layer.extent = Number(reader.readVarint());
    else reader.skip(wireType);
  }
  return layer;
}

function parseTile(buf) {
  const reader = makeReader(buf);
  const layers = [];
  while (reader.pos < reader.end) {
    const tag = Number(reader.readVarint());
    const field = tag >> 3;
    const wireType = tag & 7;
    if (field === 3) layers.push(parseLayer(reader.readBytes(Number(reader.readVarint()))));
    else reader.skip(wireType);
  }
  return layers;
}

function featureProps(layer, feature) {
  const props = {};
  for (let i = 0; i < feature.tags.length; i += 2) {
    props[layer.keys[feature.tags[i]]] = layer.values[feature.tags[i + 1]];
  }
  return props;
}

function tilePointToLonLat(point, job, extent) {
  const [x, y] = point;
  const n = 2 ** job.z;
  const lon = ((job.x + x / extent) / n) * 360 - 180;
  const t = Math.PI * (1 - (2 * (job.y + y / extent)) / n);
  const lat = (180 / Math.PI) * Math.atan(Math.sinh(t));
  return [Number(lon.toFixed(6)), Number(lat.toFixed(6))];
}

function decodeGeometry(feature) {
  let x = 0;
  let y = 0;
  let i = 0;
  const lines = [];
  let current = [];

  while (i < feature.geometry.length) {
    const cmd = feature.geometry[i++];
    const id = cmd & 7;
    const count = cmd >> 3;

    if (id === 1 || id === 2) {
      if (id === 1 && current.length) {
        lines.push(current);
        current = [];
      }
      for (let c = 0; c < count; c++) {
        x += zigzag(feature.geometry[i++]);
        y += zigzag(feature.geometry[i++]);
        current.push([x, y]);
      }
    } else if (id === 7) {
      if (current.length) {
        current.push(current[0]);
        lines.push(current);
        current = [];
      }
    } else {
      throw new Error(`unknown geometry command ${id}`);
    }
  }

  if (current.length) lines.push(current);

  if (feature.type === 1) {
    const points = lines.flat();
    return points.length === 1
      ? { type: "Point", coordinates: points[0] }
      : { type: "MultiPoint", coordinates: points };
  }
  if (feature.type === 2) {
    return lines.length === 1
      ? { type: "LineString", coordinates: lines[0] }
      : { type: "MultiLineString", coordinates: lines };
  }
  if (feature.type === 3) return { type: "Polygon", coordinates: lines };
  return null;
}

function transformGeometry(geometry, job, extent) {
  if (!geometry) return null;
  const convert = (point) => tilePointToLonLat(point, job, extent);

  if (geometry.type === "Point") return { ...geometry, coordinates: convert(geometry.coordinates) };
  if (geometry.type === "MultiPoint" || geometry.type === "LineString") {
    return { ...geometry, coordinates: geometry.coordinates.map(convert) };
  }
  if (geometry.type === "MultiLineString" || geometry.type === "Polygon") {
    return { ...geometry, coordinates: geometry.coordinates.map((line) => line.map(convert)) };
  }
  return geometry;
}

export function decodeTileToGeoJSON(buf, job, options = {}) {
  const features = [];
  const featureLimit = Number(options.featureLimit || 0);
  for (const layer of parseTile(buf)) {
    for (const feature of layer.features) {
      const geometry = transformGeometry(decodeGeometry(feature), job, layer.extent);
      if (!geometry) continue;
      features.push({
        type: "Feature",
        properties: {
          _source: job.source,
          _year: job.year,
          _z: job.z,
          _x: job.x,
          _y: job.y,
          _layer: layer.name,
          ...featureProps(layer, feature),
        },
        geometry,
      });
      if (featureLimit > 0 && features.length >= featureLimit) break;
    }
    if (featureLimit > 0 && features.length >= featureLimit) break;
  }
  return { type: "FeatureCollection", features };
}

export function inspectTileLayers(buf) {
  return parseTile(buf).map((layer) => ({
    name: layer.name,
    extent: layer.extent,
    features: layer.features.length,
    keys: layer.keys,
  }));
}
