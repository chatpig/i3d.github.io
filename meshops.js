// image-to-3d — mesh editing on plain typed arrays. No dependencies: the same
// file runs in the page (editor.js) and in Node.
//
// A mesh is { position, normal: Float32Array (xyz), color: Uint16Array (rgba,
// linear, 0..65535), mr: Uint16Array (metallic, roughness, 0..65535),
// index: Uint32Array }, the layout of the .glb the server writes. Operations
// that move vertices change the arrays in place; operations that add or remove
// vertices replace them and end with touch(mesh).
//
// A selection is a Uint8Array with one flag per vertex, or null for "all".

const U16 = 65535;

// forget what was derived from the triangles, after they changed
export function touch(m) {
  m._canon = null;
  m._edges = null;
}

// For every vertex, the first vertex at exactly the same position. Meshes with
// split vertices (an .obj, a flat-shaded .ply) are stitched this way, so that
// smoothing does not tear them and a gap is only where the surface really ends.
export function weld(m) {
  if (m._canon) return m._canon;
  const n = m.position.length / 3;
  const bits = new Uint32Array(m.position.buffer, m.position.byteOffset, n * 3);
  let size = 16;
  while (size < n * 2) size *= 2;
  const mask = size - 1;
  const table = new Int32Array(size).fill(-1);
  const canon = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    const x = bits[i * 3], y = bits[i * 3 + 1], z = bits[i * 3 + 2];
    let h = Math.imul(x, 73856093) ^ Math.imul(y, 19349663) ^ Math.imul(z, 83492791);
    h = (h ^ (h >>> 15)) & mask;
    for (;;) {
      const j = table[h];
      if (j < 0) {
        table[h] = i;
        canon[i] = i;
        break;
      }
      if (bits[j * 3] === x && bits[j * 3 + 1] === y && bits[j * 3 + 2] === z) {
        canon[i] = j;
        break;
      }
      h = (h + 1) & mask;
    }
  }
  return (m._canon = canon);
}

// The directed edges of the triangles, grouped by the vertex they leave:
// the edges out of v are to[start[v] .. start[v + 1]).
function edges(m) {
  if (m._edges) return m._edges;
  const canon = weld(m), idx = m.index, n = canon.length;
  const start = new Uint32Array(n + 1);
  for (let t = 0; t < idx.length; t += 3) {
    const a = canon[idx[t]], b = canon[idx[t + 1]], c = canon[idx[t + 2]];
    if (a === b || b === c || c === a) continue;
    start[a + 1]++;
    start[b + 1]++;
    start[c + 1]++;
  }
  for (let v = 0; v < n; v++) start[v + 1] += start[v];
  const to = new Uint32Array(start[n]);
  const fill = start.slice(0, n);
  for (let t = 0; t < idx.length; t += 3) {
    const a = canon[idx[t]], b = canon[idx[t + 1]], c = canon[idx[t + 2]];
    if (a === b || b === c || c === a) continue;
    to[fill[a]++] = b;
    to[fill[b]++] = c;
    to[fill[c]++] = a;
  }
  return (m._edges = { start, to });
}

// Smooth vertex normals from the triangles, area weighted.
export function computeNormals(m) {
  const canon = weld(m), p = m.position, idx = m.index, n = canon.length;
  const acc = new Float32Array(n * 3);
  for (let t = 0; t < idx.length; t += 3) {
    const a = canon[idx[t]] * 3, b = canon[idx[t + 1]] * 3, c = canon[idx[t + 2]] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const x = uy * vz - uz * vy, y = uz * vx - ux * vz, z = ux * vy - uy * vx;
    acc[a] += x; acc[a + 1] += y; acc[a + 2] += z;
    acc[b] += x; acc[b + 1] += y; acc[b + 2] += z;
    acc[c] += x; acc[c + 1] += y; acc[c + 2] += z;
  }
  const out = m.normal;
  for (let i = 0; i < n; i++) {
    const j = canon[i] * 3;
    const x = acc[j], y = acc[j + 1], z = acc[j + 2];
    const len = Math.hypot(x, y, z) || 1;
    out[i * 3] = x / len;
    out[i * 3 + 1] = y / len;
    out[i * 3 + 2] = z / len;
  }
}

// Taubin smoothing: a pass that relaxes every vertex towards its neighbours,
// then one that pushes back, so bumps go and the volume stays.
export function smooth(m, sel, iterations) {
  const canon = weld(m), p = m.position, idx = m.index, n = canon.length;
  const sum = new Float32Array(n * 3);
  const count = new Uint32Array(n);
  for (let t = 0; t < idx.length; t++) count[canon[idx[t]]] += 2;
  for (let pass = 0; pass < iterations * 2; pass++) {
    const factor = pass % 2 ? -0.53 : 0.5;
    sum.fill(0);
    for (let t = 0; t < idx.length; t += 3) {
      const a = canon[idx[t]] * 3, b = canon[idx[t + 1]] * 3, c = canon[idx[t + 2]] * 3;
      const ax = p[a], ay = p[a + 1], az = p[a + 2];
      const bx = p[b], by = p[b + 1], bz = p[b + 2];
      const cx = p[c], cy = p[c + 1], cz = p[c + 2];
      sum[a] += bx + cx; sum[a + 1] += by + cy; sum[a + 2] += bz + cz;
      sum[b] += ax + cx; sum[b + 1] += ay + cy; sum[b + 2] += az + cz;
      sum[c] += ax + bx; sum[c + 1] += ay + by; sum[c + 2] += az + bz;
    }
    for (let v = 0; v < n; v++) {
      if (canon[v] !== v || !count[v] || (sel && !sel[v])) continue;
      const k = factor / count[v], j = v * 3;
      p[j] += sum[j] * k - p[j] * factor;
      p[j + 1] += sum[j + 1] * k - p[j + 1] * factor;
      p[j + 2] += sum[j + 2] * k - p[j + 2] * factor;
    }
  }
  for (let i = 0; i < n; i++) {
    const j = canon[i];
    if (j === i) continue;
    p[i * 3] = p[j * 3];
    p[i * 3 + 1] = p[j * 3 + 1];
    p[i * 3 + 2] = p[j * 3 + 2];
  }
  touch(m); // positions moved: vertices that shared one may no longer
  computeNormals(m);
}

// Moves the surface outwards (or inwards, distance < 0) along its normals.
export function inflate(m, sel, distance) {
  computeNormals(m);
  const p = m.position, nrm = m.normal, idx = m.index, n = p.length / 3;
  // triangles wound the other way round have normals that point inwards
  let volume = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    volume += p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      + p[a + 1] * (p[b + 2] * p[c] - p[b] * p[c + 2])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  const d = volume < 0 ? -distance : distance;
  for (let i = 0; i < n; i++) {
    if (sel && !sel[i]) continue;
    p[i * 3] += nrm[i * 3] * d;
    p[i * 3 + 1] += nrm[i * 3 + 1] * d;
    p[i * 3 + 2] += nrm[i * 3 + 2] * d;
  }
  touch(m);
  computeNormals(m);
}

// The open borders of the surface: closed loops of vertices, each in the order
// that a patch over it needs to face the same way as the surface around it.
export function boundaryLoops(m) {
  const canon = weld(m), idx = m.index;
  const { start, to } = edges(m);
  const has = (a, b) => {
    for (let k = start[a]; k < start[a + 1]; k++) if (to[k] === b) return true;
    return false;
  };
  // an edge with no triangle on its other side is a border edge
  const next = new Map(); // vertex -> the vertices its border edges lead to
  for (let t = 0; t < idx.length; t += 3) {
    const a = canon[idx[t]], b = canon[idx[t + 1]], c = canon[idx[t + 2]];
    if (a === b || b === c || c === a) continue;
    for (const [u, v] of [[a, b], [b, c], [c, a]]) {
      if (has(v, u)) continue;
      const list = next.get(u);
      if (list) list.push(v);
      else next.set(u, [v]);
    }
  }
  const loops = [];
  for (const first of next.keys()) {
    for (;;) {
      const list = next.get(first);
      if (!list || !list.length) break;
      // walk along the border; where it touches itself, a loop is cut off
      const path = [first];
      const at = new Map([[first, 0]]);
      let v = list.pop();
      for (;;) {
        const seen = at.get(v);
        if (seen !== undefined) {
          const loop = path.splice(seen);
          for (const u of loop) at.delete(u);
          if (loop.length >= 3) loops.push(loop.reverse());
          if (!path.length) break;
          // v is path's branching point again
          path.push(v);
          at.set(v, path.length - 1);
        } else {
          at.set(v, path.length);
          path.push(v);
        }
        const out = next.get(v);
        if (!out || !out.length) break; // a border that leads nowhere: left alone
        v = out.pop();
      }
    }
  }
  return loops;
}

function loopLength(m, loop) {
  const p = m.position;
  let length = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i] * 3, b = loop[(i + 1) % loop.length] * 3;
    length += Math.hypot(p[b] - p[a], p[b + 1] - p[a + 1], p[b + 2] - p[a + 2]);
  }
  return length;
}

// Closes the gaps in the surface: every open border whose length is at most
// maxLength (and, with a selection, that touches it) gets a patch of new
// triangles. Returns { gaps, filled, vertices }.
export function fillGaps(m, sel, maxLength = Infinity) {
  const all = boundaryLoops(m);
  const loops = all.filter((loop) => (!sel || loop.some((v) => sel[v])) && loopLength(m, loop) <= maxLength);
  if (!loops.length) return { gaps: all.length, filled: 0, vertices: 0 };

  const n = m.position.length / 3;
  const P = [], C = [], M = [], T = []; // the new vertices and triangles
  const STRIDE = 9; // position 3, colour 4, metallic-roughness 2
  const vertex = (v) => {
    P.push(v[0], v[1], v[2]);
    C.push(v[3], v[4], v[5], v[6]);
    M.push(v[7], v[8]);
    return n + P.length / 3 - 1;
  };

  for (const loop of loops) {
    const k = loop.length;
    if (k === 3) {
      T.push(loop[0], loop[1], loop[2]);
      continue;
    }
    // what each border vertex carries, and the average: the middle of the patch
    let base = new Float64Array(k * STRIDE);
    const mid = new Float64Array(STRIDE);
    for (let i = 0; i < k; i++) {
      const v = loop[i], o = i * STRIDE;
      for (let j = 0; j < 3; j++) base[o + j] = m.position[v * 3 + j];
      for (let j = 0; j < 4; j++) base[o + 3 + j] = m.color[v * 4 + j];
      for (let j = 0; j < 2; j++) base[o + 7 + j] = m.mr[v * 2 + j];
      for (let j = 0; j < STRIDE; j++) mid[j] += base[o + j] / k;
    }
    let radius = 0;
    for (let i = 0; i < k; i++) radius += Math.hypot(base[i * STRIDE] - mid[0], base[i * STRIDE + 1] - mid[1], base[i * STRIDE + 2] - mid[2]) / k;
    // rings of triangles from the border to the middle, about as deep as the
    // border edges are long, with fewer vertices as the rings get smaller
    const rings = Math.max(1, Math.min(48, Math.round(radius / (loopLength(m, loop) / k))));
    let ids = loop, count = k;
    const point = new Float64Array(STRIDE);
    for (let r = 1; r < rings; r++) {
      const t = 1 - r / rings;
      const halve = count >= 8 && count > 1.5 * k * t;
      const inner = halve ? Math.ceil(count / 2) : count;
      let innerBase = base;
      if (halve) {
        innerBase = new Float64Array(inner * STRIDE);
        for (let j = 0; j < inner; j++) {
          const a = 2 * j * STRIDE, b = Math.min(2 * j + 1, count - 1) * STRIDE;
          for (let s = 0; s < STRIDE; s++) innerBase[j * STRIDE + s] = (base[a + s] + base[b + s]) / 2;
        }
      }
      const innerIds = new Array(inner);
      for (let j = 0; j < inner; j++) {
        for (let s = 0; s < STRIDE; s++) point[s] = mid[s] + (innerBase[j * STRIDE + s] - mid[s]) * t;
        innerIds[j] = vertex(point);
      }
      for (let i = 0; i < count; i++) {
        const i1 = (i + 1) % count;
        const f = halve ? i >> 1 : i;
        const f1 = i + 1 === count ? 0 : halve ? (i + 1) >> 1 : i + 1;
        T.push(ids[i], ids[i1], innerIds[f]);
        if (f1 !== f) T.push(ids[i1], innerIds[f1], innerIds[f]);
      }
      ids = innerIds;
      base = innerBase;
      count = inner;
    }
    const centre = vertex(mid);
    for (let i = 0; i < count; i++) T.push(ids[i], ids[(i + 1) % count], centre);
  }

  const grow = (old, extra, Type) => {
    const out = new Type(old.length + extra.length);
    out.set(old);
    out.set(extra, old.length);
    return out;
  };
  m.position = grow(m.position, P, Float32Array);
  m.normal = grow(m.normal, new Array(P.length).fill(0), Float32Array);
  m.color = grow(m.color, C.map(Math.round), Uint16Array);
  m.mr = grow(m.mr, M.map(Math.round), Uint16Array);
  m.index = grow(m.index, T, Uint32Array);
  touch(m);
  computeNormals(m);
  return { gaps: all.length, filled: loops.length, vertices: P.length / 3 };
}

// grid | its neighbours along x, y and z: every set cell grows by one cell
function dilate(grid, nx, ny, nz) {
  const strides = [1, nx, nx * ny], sizes = [nx, ny, nz];
  let src = grid;
  for (let axis = 0; axis < 3; axis++) {
    const s = strides[axis], dst = new Uint8Array(src.length);
    for (let i = 0; i < src.length; i++) {
      if (!src[i]) continue;
      dst[i] = 1;
      const at = Math.floor(i / s) % sizes[axis];
      if (at > 0) dst[i - s] = 1;
      if (at < sizes[axis] - 1) dst[i + s] = 1;
    }
    src = dst;
  }
  return src;
}

// The triangles that cannot be reached from outside: inner shells and whatever
// else sits inside a closed surface. The mesh is drawn into a grid of cells,
// the cells around it are flooded from a corner, and a triangle with no vertex
// near a flooded cell is hidden. Returns a Uint8Array, 1 = hidden, and how many.
export function hiddenTriangles(m, resolution = 128) {
  const p = m.position, idx = m.index, n = p.length / 3;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n * 3; i++) {
    if (p[i] < min[i % 3]) min[i % 3] = p[i];
    if (p[i] > max[i % 3]) max[i % 3] = p[i];
  }
  const cell = Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2], 1e-9) / resolution;
  const PAD = 3;
  const nx = Math.floor((max[0] - min[0]) / cell) + 1 + 2 * PAD;
  const ny = Math.floor((max[1] - min[1]) / cell) + 1 + 2 * PAD;
  const nz = Math.floor((max[2] - min[2]) / cell) + 1 + 2 * PAD;
  const cellOf = (x, y, z) =>
    Math.floor((x - min[0]) / cell) + PAD + nx * (Math.floor((y - min[1]) / cell) + PAD + ny * (Math.floor((z - min[2]) / cell) + PAD));

  const wall = new Uint8Array(nx * ny * nz);
  const home = new Uint32Array(n); // the cell of every vertex
  for (let i = 0; i < n; i++) wall[(home[i] = cellOf(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]))] = 1;
  // triangles larger than a cell are drawn point by point
  const limit = (cell * 0.5) ** 2;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const longest = Math.max(ux * ux + uy * uy + uz * uz, vx * vx + vy * vy + vz * vz, (ux - vx) ** 2 + (uy - vy) ** 2 + (uz - vz) ** 2);
    if (longest <= limit) continue;
    const steps = Math.min(512, Math.ceil(Math.sqrt(longest) / (cell * 0.5)));
    for (let i = 0; i <= steps; i++) {
      for (let j = 0; j <= steps - i; j++) {
        const s = i / steps, r = j / steps;
        wall[cellOf(p[a] + ux * s + vx * r, p[a + 1] + uy * s + vy * r, p[a + 2] + uz * s + vz * r)] = 1;
      }
    }
  }
  // walls one cell thicker: the flood does not leak through a pinhole
  const solid = dilate(wall, nx, ny, nz);

  const outside = new Uint8Array(solid.length);
  const queue = new Uint32Array(solid.length);
  let head = 0, tail = 0;
  outside[0] = 1;
  queue[tail++] = 0;
  const visit = (i) => {
    if (!solid[i] && !outside[i]) {
      outside[i] = 1;
      queue[tail++] = i;
    }
  };
  while (head < tail) {
    const i = queue[head++];
    const x = i % nx, y = Math.floor(i / nx) % ny, z = Math.floor(i / (nx * ny));
    if (x > 0) visit(i - 1);
    if (x < nx - 1) visit(i + 1);
    if (y > 0) visit(i - nx);
    if (y < ny - 1) visit(i + nx);
    if (z > 0) visit(i - nx * ny);
    if (z < nz - 1) visit(i + nx * ny);
  }
  // a wall cell of the outer surface is at most two cells from the flood
  const reached = dilate(dilate(outside, nx, ny, nz), nx, ny, nz);

  const hidden = new Uint8Array(idx.length / 3);
  let count = 0;
  for (let t = 0; t < idx.length; t += 3) {
    if (reached[home[idx[t]]] || reached[home[idx[t + 1]]] || reached[home[idx[t + 2]]]) continue;
    hidden[t / 3] = 1;
    count++;
  }
  return { hidden, count };
}

// Keeps the triangles where keep(t) is true and drops the vertices that are
// left without one. Returns the new place of every old vertex, -1 for dropped.
export function keepTriangles(m, keep) {
  const idx = m.index, n = m.position.length / 3;
  const place = new Int32Array(n).fill(-1);
  const kept = new Uint32Array(idx.length);
  let triangles = 0, vertices = 0;
  for (let t = 0; t < idx.length; t += 3) {
    if (!keep(t / 3)) continue;
    for (let k = 0; k < 3; k++) {
      const v = idx[t + k];
      if (place[v] < 0) place[v] = vertices++;
      kept[triangles * 3 + k] = place[v];
    }
    triangles++;
  }
  const pick = (old, size) => {
    const out = new old.constructor(vertices * size);
    for (let v = 0; v < n; v++) {
      const to = place[v];
      if (to >= 0) for (let k = 0; k < size; k++) out[to * size + k] = old[v * size + k];
    }
    return out;
  };
  m.position = pick(m.position, 3);
  m.normal = pick(m.normal, 3);
  m.color = pick(m.color, 4);
  m.mr = pick(m.mr, 2);
  m.index = kept.slice(0, triangles * 3);
  touch(m);
  return place;
}

// Crop: keeps the triangles whose corners are all selected.
export function cropTo(m, sel) {
  const idx = m.index;
  return keepTriangles(m, (t) => sel[idx[t * 3]] && sel[idx[t * 3 + 1]] && sel[idx[t * 3 + 2]]);
}

// Delete: drops the triangles whose corners are all selected.
export function removeSelected(m, sel) {
  const idx = m.index;
  return keepTriangles(m, (t) => !(sel[idx[t * 3]] && sel[idx[t * 3 + 1]] && sel[idx[t * 3 + 2]]));
}

// One step outwards: every triangle that touches the selection joins it.
export function growSelection(m, sel) {
  const canon = weld(m), idx = m.index, n = canon.length;
  const mark = new Uint8Array(n);
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (sel[a] || sel[b] || sel[c]) mark[canon[a]] = mark[canon[b]] = mark[canon[c]] = 1;
  }
  for (let i = 0; i < n; i++) if (mark[canon[i]]) sel[i] = 1;
}

// The vertex closest to a point.
export function nearestVertex(m, x, y, z) {
  const p = m.position;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const d = (p[i] - x) ** 2 + (p[i + 1] - y) ** 2 + (p[i + 2] - z) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i / 3;
    }
  }
  return best;
}

// The magic wand: from a vertex, across the surface, for as long as the colour
// stays within `tolerance` (0..1) of the colour where it started. Tolerance 1
// takes the whole connected piece. Sets or clears those vertices in sel.
export function selectSimilar(m, sel, seed, tolerance, value = 1) {
  const canon = weld(m), col = m.color, n = canon.length;
  const { start, to } = edges(m);
  // colours are linear: compared as the eye sees them, roughly
  const tone = (v, k) => Math.sqrt(col[v * 4 + k] / U16);
  const r = tone(seed, 0), g = tone(seed, 1), b = tone(seed, 2);
  const limit = tolerance >= 1 ? Infinity : tolerance * tolerance * 3;
  const mark = new Uint8Array(n);
  const queue = new Uint32Array(n);
  let head = 0, tail = 0;
  mark[canon[seed]] = 1;
  queue[tail++] = canon[seed];
  while (head < tail) {
    const v = queue[head++];
    for (let k = start[v]; k < start[v + 1]; k++) {
      const w = to[k];
      if (mark[w]) continue;
      if ((tone(w, 0) - r) ** 2 + (tone(w, 1) - g) ** 2 + (tone(w, 2) - b) ** 2 > limit) continue;
      mark[w] = 1;
      queue[tail++] = w;
    }
  }
  for (let i = 0; i < n; i++) if (mark[canon[i]]) sel[i] = value;
}

// One colour (linear r, g, b in 0..1) for the selected vertices.
export function paint(m, sel, r, g, b) {
  const col = m.color, n = col.length / 4;
  const R = Math.round(r * U16), G = Math.round(g * U16), B = Math.round(b * U16);
  for (let i = 0; i < n; i++) {
    if (sel && !sel[i]) continue;
    col[i * 4] = R;
    col[i * 4 + 1] = G;
    col[i * 4 + 2] = B;
  }
}

// One metallic and roughness (0..1) for the selected vertices: the material.
export function setMaterial(m, sel, metallic, roughness) {
  const mr = m.mr, n = mr.length / 2;
  const M = Math.round(metallic * U16), R = Math.round(roughness * U16);
  for (let i = 0; i < n; i++) {
    if (sel && !sel[i]) continue;
    mr[i * 2] = M;
    mr[i * 2 + 1] = R;
  }
}

// The mesh as a binary glTF 2.0 file, laid out like the server's: returns the
// parts of the file, for new Blob(parts, { type: 'model/gltf-binary' }).
export function writeGlb(m, { name = 'mesh', generator = 'image-to-3d editor' } = {}) {
  const p = m.position, n = p.length / 3;
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < n * 3; i++) {
    if (p[i] < min[i % 3]) min[i % 3] = p[i];
    if (p[i] > max[i % 3]) max[i % 3] = p[i];
  }
  // Programs that do not read the per-vertex attribute use one metallic and
  // roughness for the whole mesh: the average says the most about it.
  let metallic = 0, roughness = 0;
  for (let i = 0; i < n; i++) {
    metallic += m.mr[i * 2];
    roughness += m.mr[i * 2 + 1];
  }
  const factor = (sum) => (n ? Math.round((sum / n / U16) * 10000) / 10000 : 0);

  const arrays = [m.position, m.normal, m.color, m.mr, m.index];
  const bufferViews = [];
  let length = 0;
  for (const a of arrays) {
    bufferViews.push({ buffer: 0, byteOffset: length, byteLength: a.byteLength, target: a === m.index ? 34963 : 34962 });
    length += a.byteLength; // every array is a multiple of 4 bytes long
  }
  const json = {
    asset: { version: '2.0', generator },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name }],
    meshes: [{ name, primitives: [{ attributes: { POSITION: 0, NORMAL: 1, COLOR_0: 2, _METALLIC_ROUGHNESS: 3 }, indices: 4, material: 0, mode: 4 }] }],
    materials: [{ name: 'material', pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: factor(metallic), roughnessFactor: factor(roughness) }, doubleSided: true }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: n, type: 'VEC3', min: min.map(Math.fround), max: max.map(Math.fround) },
      { bufferView: 1, componentType: 5126, count: n, type: 'VEC3' },
      { bufferView: 2, componentType: 5123, normalized: true, count: n, type: 'VEC4' },
      { bufferView: 3, componentType: 5123, normalized: true, count: n, type: 'VEC2' },
      { bufferView: 4, componentType: 5125, count: m.index.length, type: 'SCALAR' },
    ],
    bufferViews,
    buffers: [{ byteLength: length }],
  };
  let text = JSON.stringify(json);
  while (text.length % 4) text += ' ';
  const jsonBytes = new TextEncoder().encode(text);
  const header = new Uint32Array([0x46546c67, 2, 12 + 8 + jsonBytes.length + 8 + length, jsonBytes.length, 0x4e4f534a]);
  const binHeader = new Uint32Array([length, 0x004e4942]);
  return [header, jsonBytes, binHeader, ...arrays];
}
