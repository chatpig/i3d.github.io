// image-to-3d — the mesh editor. An ES module, imported by script.js the first
// time "Edit" is opened. It turns the model in the viewer into one editable
// mesh, selects parts of it with the pointer, runs the operations of
// meshops.js on it, and writes it out as a new .glb.

import * as THREE from 'three';
import * as ops from './meshops.js';

const MR = '_metallic_roughness'; // as in viewer.js
const SEL = '_sel';
const U16 = 65535;
const UNDO_STEPS = 12;
const UNDO_BYTES = 600 * 1024 * 1024;
const KEYS = ['position', 'normal', 'color', 'mr', 'index', 'sel'];

// The model's material: colour, metallic and roughness per vertex, and the
// selection drawn over it.
function editMaterial() {
  const material = new THREE.MeshStandardMaterial({ vertexColors: true, side: THREE.DoubleSide });
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec2 ${MR};\nattribute float ${SEL};\nvarying vec2 vVertexMR;\nvarying float vSel;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvVertexMR = ${MR};\nvSel = ${SEL};`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vVertexMR;\nvarying float vSel;')
      .replace('#include <color_fragment>', '#include <color_fragment>\ndiffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.33, 0.04), vSel * 0.6);')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vVertexMR.x * (1.0 - vSel * 0.7);')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = max(vVertexMR.y, 0.04);')
      .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vec3(0.30, 0.09, 0.0) * vSel;');
  };
  material.customProgramCacheKey = () => 'edit-pbr';
  return material;
}

// Draws where on the surface every pixel is, in the mesh's own coordinates.
function pickMaterial() {
  return new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: 'varying vec3 vAt; void main() { vAt = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
    fragmentShader: 'varying vec3 vAt; void main() { gl_FragColor = vec4(vAt, 1.0); }',
  });
}

// Everything under `root` as one mesh in root's coordinates: the transforms of
// the parts are applied, the colour and material of each part go to its vertices.
function gather(root) {
  const parts = [];
  root.updateMatrixWorld(true);
  const toRoot = new THREE.Matrix4().copy(root.matrixWorld).invert();
  root.traverse((child) => {
    if (child.isMesh && child.geometry.getAttribute('position')) parts.push(child);
  });
  let vertices = 0, corners = 0;
  for (const part of parts) {
    const count = part.geometry.getAttribute('position').count;
    vertices += count;
    corners += part.geometry.index ? part.geometry.index.count : count;
  }
  corners -= corners % 3;
  const m = {
    position: new Float32Array(vertices * 3),
    normal: new Float32Array(vertices * 3),
    color: new Uint16Array(vertices * 4),
    mr: new Uint16Array(vertices * 2),
    index: new Uint32Array(corners),
  };
  const v = new THREE.Vector3();
  const u16 = (x) => Math.round(Math.min(1, Math.max(0, x)) * U16);
  let base = 0, corner = 0, needNormals = false;
  for (const part of parts) {
    const g = part.geometry;
    const material = part.userData.material || part.material;
    const one = Array.isArray(material) ? material[0] : material;
    const position = g.getAttribute('position'), normal = g.getAttribute('normal'), color = g.getAttribute('color'), mr = g.getAttribute(MR);
    const count = position.count;
    const matrix = new THREE.Matrix4().multiplyMatrices(toRoot, part.matrixWorld);
    const normalMatrix = new THREE.Matrix3().getNormalMatrix(matrix);
    const plain = (attr, Type, size) => attr.array instanceof Type && attr.itemSize === size && !attr.isInterleavedBufferAttribute && attr.array.length === count * size;
    const still = matrix.equals(new THREE.Matrix4());

    if (still && plain(position, Float32Array, 3)) m.position.set(position.array, base * 3);
    else for (let i = 0; i < count; i++) v.fromBufferAttribute(position, i).applyMatrix4(matrix).toArray(m.position, (base + i) * 3);

    if (!normal) needNormals = true;
    else if (still && plain(normal, Float32Array, 3)) m.normal.set(normal.array, base * 3);
    else for (let i = 0; i < count; i++) v.fromBufferAttribute(normal, i).applyMatrix3(normalMatrix).normalize().toArray(m.normal, (base + i) * 3);

    // the material's own colour is white for a generated model; any other is baked in
    const tint = one && one.color ? one.color : new THREE.Color(1, 1, 1);
    const white = tint.r === 1 && tint.g === 1 && tint.b === 1;
    if (color && white && color.normalized && plain(color, Uint16Array, 4)) m.color.set(color.array, base * 4);
    else {
      for (let i = 0; i < count; i++) {
        const o = (base + i) * 4;
        m.color[o] = u16((color ? color.getX(i) : 1) * tint.r);
        m.color[o + 1] = u16((color ? color.getY(i) : 1) * tint.g);
        m.color[o + 2] = u16((color ? color.getZ(i) : 1) * tint.b);
        m.color[o + 3] = color && color.itemSize === 4 ? u16(color.getW(i)) : U16;
      }
    }

    if (mr && mr.normalized && plain(mr, Uint16Array, 2)) m.mr.set(mr.array, base * 2);
    else {
      const metallic = one && one.metalness !== undefined ? one.metalness : 0;
      const roughness = one && one.roughness !== undefined ? one.roughness : 0.6;
      for (let i = 0; i < count; i++) {
        m.mr[(base + i) * 2] = u16(mr ? mr.getX(i) : metallic);
        m.mr[(base + i) * 2 + 1] = u16(mr ? mr.getY(i) : roughness);
      }
    }

    const n = Math.min(g.index ? g.index.count : count, corners - corner);
    if (g.index) for (let i = 0; i < n; i++) m.index[corner + i] = base + g.index.getX(i);
    else for (let i = 0; i < n; i++) m.index[corner + i] = base + i;
    corner += n;
    base += count;
  }
  if (needNormals) ops.computeNormals(m);
  return m;
}

export class Editor {
  // viewer: the Viewer showing the model; onChange(state) is called whenever
  // the counts, the selection or the undo history change.
  constructor(viewer, onChange) {
    this.viewer = viewer;
    this.onChange = onChange || (() => {});
    this.canvas = viewer.renderer.domElement;
    this.stage = viewer.container;
    this.tool = 'orbit';
    this.brushSize = 24; // radius, CSS pixels
    this.tolerance = 0.2; // the wand's
    this.visibleOnly = true; // the box takes only what faces the camera
    this.mesh = null;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false; // edited since the model was opened
    this.material = editMaterial();
    this.pickMaterial = pickMaterial();
    this.pickTarget = null;
    this.pickStale = true;
    this.stroke = null;

    this.ring = document.createElement('div');
    this.ring.className = 'ed-ring';
    this.ring.hidden = true;
    this.box = document.createElement('div');
    this.box.className = 'ed-box';
    this.box.hidden = true;
    this.stage.append(this.ring, this.box);

    this.orbitButtons = { ...viewer.controls.mouseButtons };
    this.orbitTouches = { ...viewer.controls.touches };
    this.onCamera = () => (this.pickStale = true);
    viewer.controls.addEventListener('change', this.onCamera);
    this.handlers = {
      pointerdown: (e) => this.pointerDown(e),
      pointermove: (e) => this.pointerMove(e),
      pointerup: (e) => this.pointerUp(e),
      pointercancel: (e) => this.pointerUp(e),
      pointerleave: () => (this.ring.hidden = true),
    };
    for (const [type, fn] of Object.entries(this.handlers)) this.canvas.addEventListener(type, fn);
  }

  // ───────────── the model

  // Takes over the model the viewer is showing.
  open() {
    const pivot = this.viewer.model;
    if (!pivot) return false;
    const root = pivot.children[0];
    if (root === this.mesh) return true;
    // in the pivot's coordinates: those of the file, y-up, whatever the format was
    const data = gather(pivot);
    if (!data.index.length) return false;
    this.data = data;
    this.sel = new Uint8Array(data.position.length / 3);
    this.selected = 0;
    this.undoStack = [];
    this.redoStack = [];
    this.dirty = false;
    // the size of the model, for amounts given as a part of it
    const box = new THREE.Box3().setFromArray(data.position);
    this.size = Math.max(...box.getSize(new THREE.Vector3()).toArray(), 1e-9);

    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), this.material);
    mesh.frustumCulled = false;
    this.viewer.swap(mesh);
    this.mesh = mesh;
    this.rebuild();
    return true;
  }

  // Is the editor's mesh still the one in the viewer?
  get active() {
    return !!this.mesh && !!this.viewer.model && this.viewer.model.children[0] === this.mesh;
  }

  // new buffers for the GPU, after vertices or triangles were added or removed
  rebuild() {
    const d = this.data;
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(d.position, 3));
    g.setAttribute('normal', new THREE.BufferAttribute(d.normal, 3));
    g.setAttribute('color', new THREE.BufferAttribute(d.color, 4, true));
    g.setAttribute(MR, new THREE.BufferAttribute(d.mr, 2, true));
    g.setAttribute(SEL, new THREE.BufferAttribute(this.sel, 1, true));
    g.setIndex(new THREE.BufferAttribute(d.index, 1));
    this.mesh.geometry.dispose();
    this.mesh.geometry = g;
    this.changed();
  }

  // the arrays were changed in place
  refresh(...names) {
    const g = this.mesh.geometry;
    for (const name of names) g.getAttribute(name === 'mr' ? MR : name).needsUpdate = true;
    this.changed();
  }

  changed() {
    this.pickStale = true;
    this.viewer.dirty = true;
    this.report();
  }

  report() {
    this.onChange({
      vertices: this.data.position.length / 3,
      triangles: this.data.index.length / 3,
      selected: this.selected,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
      dirty: this.dirty,
    });
  }

  // ───────────── undo

  // Remembers the arrays an operation is about to change. `copy` is for the
  // ones it changes in place; the others it replaces, so they are kept as they are.
  remember(keys, copy) {
    const entry = { bytes: 0 };
    for (const key of keys) {
      const array = key === 'sel' ? this.sel : this.data[key];
      entry[key] = copy ? array.slice() : array;
      entry.bytes += array.byteLength;
    }
    this.undoStack.push(entry);
    this.redoStack = [];
    let bytes = 0;
    for (const e of this.undoStack) bytes += e.bytes;
    while (this.undoStack.length > UNDO_STEPS || (bytes > UNDO_BYTES && this.undoStack.length > 1)) bytes -= this.undoStack.shift().bytes;
    this.dirty = true;
  }

  // an operation that turned out to change nothing
  forget() {
    this.undoStack.pop();
    this.report();
  }

  swapState(from, to) {
    const entry = from.pop();
    if (!entry) return;
    const back = { bytes: entry.bytes };
    for (const key of KEYS) {
      if (!entry[key]) continue;
      if (key === 'sel') {
        back.sel = this.sel;
        this.sel = entry.sel;
      } else {
        back[key] = this.data[key];
        this.data[key] = entry[key];
      }
    }
    to.push(back);
    ops.touch(this.data);
    this.dirty = true;
    this.countSelected();
    this.rebuild();
  }

  undo() {
    this.swapState(this.undoStack, this.redoStack);
  }

  redo() {
    this.swapState(this.redoStack, this.undoStack);
  }

  // ───────────── selection

  // what an operation works on: the selection, or everything when there is none
  get scope() {
    return this.selected ? this.sel : null;
  }

  countSelected() {
    let count = 0;
    for (let i = 0; i < this.sel.length; i++) count += this.sel[i] ? 1 : 0;
    this.selected = count;
  }

  selectionChanged() {
    this.countSelected();
    this.mesh.geometry.getAttribute(SEL).needsUpdate = true;
    this.viewer.dirty = true;
    this.report();
  }

  selectAll() {
    this.sel.fill(255);
    this.selectionChanged();
  }

  selectNone() {
    this.sel.fill(0);
    this.selectionChanged();
  }

  invertSelection() {
    for (let i = 0; i < this.sel.length; i++) this.sel[i] = this.sel[i] ? 0 : 255;
    this.selectionChanged();
  }

  growSelection() {
    ops.growSelection(this.data, this.sel);
    for (let i = 0; i < this.sel.length; i++) if (this.sel[i]) this.sel[i] = 255;
    this.selectionChanged();
  }

  setTool(tool) {
    this.tool = tool;
    const controls = this.viewer.controls;
    if (tool === 'orbit') {
      controls.mouseButtons = { ...this.orbitButtons };
      controls.touches = { ...this.orbitTouches };
    } else {
      // the left button and one finger select; the right button and two fingers turn the model
      controls.mouseButtons = { LEFT: null, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.ROTATE };
      controls.touches = { ONE: null, TWO: THREE.TOUCH.DOLLY_ROTATE };
    }
    this.stage.classList.toggle('selecting', tool !== 'orbit');
    this.ring.hidden = true;
    this.box.hidden = true;
  }

  // ───────────── picking

  // The surface under every pixel, read back once per camera position.
  pickBuffer() {
    const { renderer, scene, camera } = this.viewer;
    const cssW = this.canvas.clientWidth || 1, cssH = this.canvas.clientHeight || 1;
    const w = Math.max(1, Math.min(1024, Math.round(cssW)));
    const h = Math.max(1, Math.round((w * cssH) / cssW));
    if (!this.pickTarget || this.pickTarget.width !== w || this.pickTarget.height !== h) {
      if (this.pickTarget) this.pickTarget.dispose();
      this.pickTarget = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      this.pickPixels = new Float32Array(w * h * 4);
      this.pickStale = true;
    }
    if (this.pickStale) {
      const clear = renderer.getClearColor(new THREE.Color());
      const alpha = renderer.getClearAlpha();
      scene.overrideMaterial = this.pickMaterial;
      renderer.setRenderTarget(this.pickTarget);
      renderer.setClearColor(0x000000, 0);
      renderer.clear();
      renderer.render(scene, camera);
      renderer.readRenderTargetPixels(this.pickTarget, 0, 0, w, h, this.pickPixels);
      renderer.setRenderTarget(null);
      renderer.setClearColor(clear, alpha);
      scene.overrideMaterial = null;
      this.pickStale = false;
      this.viewer.dirty = true;
    }
    return { pixels: this.pickPixels, w, h, cssW, cssH };
  }

  // The point of the surface under a place on the canvas (CSS pixels), in the
  // mesh's coordinates, or null where there is none.
  pick(x, y) {
    const { pixels, w, h, cssW, cssH } = this.pickBuffer();
    const px = Math.floor((x / cssW) * w), py = Math.floor((1 - y / cssH) * h);
    if (px < 0 || py < 0 || px >= w || py >= h) return null;
    const o = (py * w + px) * 4;
    return pixels[o + 3] ? new THREE.Vector3(pixels[o], pixels[o + 1], pixels[o + 2]) : null;
  }

  // how long one CSS pixel is on the surface at `point`, in the mesh's units
  pixelSize(point) {
    const { camera } = this.viewer;
    const depth = -point.clone().applyMatrix4(this.mesh.matrixWorld).applyMatrix4(camera.matrixWorldInverse).z;
    const world = (2 * depth * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / (this.canvas.clientHeight || 1);
    return world / this.viewer.model.scale.x;
  }

  local(e) {
    const rect = this.canvas.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  // ───────────── the pointer

  pointerDown(e) {
    if (this.tool === 'orbit' || !this.active || e.button !== 0 || this.stroke) return;
    if (e.pointerType === 'touch' && !e.isPrimary) return;
    const at = this.local(e);
    const value = e.shiftKey ? 0 : 255; // Shift takes away
    this.viewer.controls.autoRotate = false;
    this.viewer.camera.updateMatrixWorld();
    this.mesh.updateMatrixWorld();
    if (this.tool === 'wand') {
      const point = this.pick(at.x, at.y);
      if (!point) return;
      const seed = ops.nearestVertex(this.data, point.x, point.y, point.z);
      ops.selectSimilar(this.data, this.sel, seed, this.tolerance, value);
      this.selectionChanged();
      return;
    }
    this.stroke = { id: e.pointerId, start: at, last: at, value };
    this.canvas.setPointerCapture(e.pointerId);
    if (this.tool === 'brush') this.dab(at, at);
    e.preventDefault();
  }

  pointerMove(e) {
    const at = this.local(e);
    if (this.tool === 'brush' && this.active) {
      const s = this.ring.style;
      s.width = s.height = this.brushSize * 2 + 'px';
      s.left = at.x - this.brushSize + 'px';
      s.top = at.y - this.brushSize + 'px';
      this.ring.hidden = false;
    }
    const stroke = this.stroke;
    if (!stroke || stroke.id !== e.pointerId) return;
    if (this.tool === 'brush') {
      this.dab(stroke.last, at);
      stroke.last = at;
    } else if (this.tool === 'box') {
      const s = this.box.style;
      s.left = Math.min(stroke.start.x, at.x) + 'px';
      s.top = Math.min(stroke.start.y, at.y) + 'px';
      s.width = Math.abs(at.x - stroke.start.x) + 'px';
      s.height = Math.abs(at.y - stroke.start.y) + 'px';
      this.box.hidden = false;
      stroke.last = at;
    }
  }

  pointerUp(e) {
    const stroke = this.stroke;
    if (!stroke || stroke.id !== e.pointerId) return;
    this.stroke = null;
    this.box.hidden = true;
    if (this.tool === 'box' && e.type === 'pointerup') this.selectBox(stroke.start, stroke.last, stroke.value);
  }

  // The brush: every vertex within the brush's radius of the surface under the
  // pointer, along the way from one pointer position to the next.
  dab(from, to) {
    const steps = Math.max(1, Math.min(12, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / (this.brushSize * 0.5))));
    const p = this.data.position, sel = this.sel, n = sel.length;
    let any = false;
    for (let s = 1; s <= steps; s++) {
      const point = this.pick(from.x + ((to.x - from.x) * s) / steps, from.y + ((to.y - from.y) * s) / steps);
      if (!point) continue;
      const r2 = (this.brushSize * this.pixelSize(point)) ** 2;
      const { x, y, z } = point;
      for (let i = 0; i < n; i++) {
        const dx = p[i * 3] - x, dy = p[i * 3 + 1] - y, dz = p[i * 3 + 2] - z;
        if (dx * dx + dy * dy + dz * dz <= r2) sel[i] = this.stroke.value;
      }
      any = true;
    }
    if (any) this.selectionChanged();
  }

  // The box: every vertex drawn inside the rectangle and, unless the far side
  // is wanted too, lying on the surface that is visible there.
  selectBox(a, b, value) {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y);
    if (x1 - x0 < 3 && y1 - y0 < 3) return; // a click, not a box
    const { pixels, w, h, cssW, cssH } = this.pickBuffer();
    const { camera } = this.viewer;
    const e = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).multiply(this.mesh.matrixWorld).elements;
    // the length of one pixel of the pick buffer at distance 1, in the mesh's units
    const unit = (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / h / this.viewer.model.scale.x;
    const p = this.data.position, sel = this.sel, n = sel.length;
    for (let i = 0; i < n; i++) {
      const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
      const cw = e[3] * x + e[7] * y + e[11] * z + e[15];
      if (cw <= 0) continue;
      const sx = ((e[0] * x + e[4] * y + e[8] * z + e[12]) / cw + 1) / 2;
      const sy = (1 - (e[1] * x + e[5] * y + e[9] * z + e[13]) / cw) / 2;
      if (sx * cssW < x0 || sx * cssW > x1 || sy * cssH < y0 || sy * cssH > y1) continue;
      if (this.visibleOnly) {
        // visible: the surface drawn at its pixel, or right next to it, is the vertex itself
        const px = Math.floor(sx * w), py = Math.floor((1 - sy) * h);
        const reach = (4 * unit * cw) ** 2;
        let seen = false;
        for (let oy = -1; oy <= 1 && !seen; oy++) {
          for (let ox = -1; ox <= 1 && !seen; ox++) {
            const qx = px + ox, qy = py + oy;
            if (qx < 0 || qy < 0 || qx >= w || qy >= h) continue;
            const o = (qy * w + qx) * 4;
            if (!pixels[o + 3]) continue;
            seen = (pixels[o] - x) ** 2 + (pixels[o + 1] - y) ** 2 + (pixels[o + 2] - z) ** 2 <= reach;
          }
        }
        if (!seen) continue;
      }
      sel[i] = value;
    }
    this.selectionChanged();
  }

  // ───────────── operations. Each returns a sentence about what it did.

  smooth(iterations) {
    this.remember(['position', 'normal'], true);
    ops.smooth(this.data, this.scope, iterations);
    this.refresh('position', 'normal');
    return this.selected ? 'Smoothed the selection.' : 'Smoothed the surface.';
  }

  // amount: a part of the model's size, negative to slim it
  inflate(amount) {
    this.remember(['position', 'normal'], true);
    ops.inflate(this.data, this.scope, amount * this.size);
    this.refresh('position', 'normal');
    return amount < 0 ? 'Slimmed.' : 'Filled out.';
  }

  setMaterial(metallic, roughness, name) {
    this.remember(['mr'], true);
    ops.setMaterial(this.data, this.scope, metallic, roughness);
    this.refresh('mr');
    return `${name} ${this.selected ? 'on the selection' : 'on the whole model'}.`;
  }

  // hex: a CSS colour, #rrggbb
  paint(hex) {
    const c = new THREE.Color(hex); // sRGB in, linear out
    this.remember(['color'], true);
    ops.paint(this.data, this.scope, c.r, c.g, c.b);
    this.refresh('color');
    return this.selected ? 'Coloured the selection.' : 'Coloured the whole model.';
  }

  // keeps the selection in step with the vertices after some were removed
  moveSelection(place) {
    const old = this.sel;
    const sel = new Uint8Array(this.data.position.length / 3);
    for (let i = 0; i < old.length; i++) if (place[i] >= 0) sel[place[i]] = old[i];
    this.sel = sel;
  }

  crop() {
    if (!this.selected) return 'Select the part to keep first.';
    this.remember(KEYS, false);
    const before = this.data.index.length / 3;
    ops.cropTo(this.data, this.sel);
    if (!this.data.index.length) {
      this.undo();
      this.redoStack = [];
      this.report();
      return 'The selection holds no whole triangle: nothing to crop to.';
    }
    this.sel = new Uint8Array(this.data.position.length / 3);
    this.selected = 0;
    this.rebuild();
    return `Cropped to the selection: ${(before - this.data.index.length / 3).toLocaleString()} triangles removed.`;
  }

  remove() {
    if (!this.selected) return 'Select the part to delete first.';
    this.remember(KEYS, false);
    const before = this.data.index.length / 3;
    ops.removeSelected(this.data, this.sel);
    if (!this.data.index.length) {
      this.undo();
      this.redoStack = [];
      this.report();
      return 'That would delete the whole model.';
    }
    this.sel = new Uint8Array(this.data.position.length / 3);
    this.selected = 0;
    this.rebuild();
    return `Deleted ${(before - this.data.index.length / 3).toLocaleString()} triangles.`;
  }

  // Patches over the open borders. largest: the widest gap to close, as a part
  // of the model's size; 1 or more closes them all.
  fillGaps(largest) {
    this.remember(KEYS, false);
    const maxLength = largest >= 1 ? Infinity : largest * this.size * Math.PI;
    let filled = 0, left = 0;
    // a patch can close one side of a border that touched another: look again
    for (let pass = 0; pass < 3; pass++) {
      const r = ops.fillGaps(this.data, this.scope && this.grown(), maxLength);
      filled += r.filled;
      left = r.gaps - r.filled;
      if (!r.filled) break;
    }
    if (!filled) {
      this.forget();
      return left ? `No gap small enough to fill (${left.toLocaleString()} larger ${left === 1 ? 'one' : 'ones'}): raise "up to".` : 'No gaps: the surface is closed.';
    }
    this.sel = this.grown();
    this.rebuild();
    return `Filled ${filled.toLocaleString()} ${filled === 1 ? 'gap' : 'gaps'}.`;
  }

  // the selection, as long as the mesh has become
  grown() {
    const n = this.data.position.length / 3;
    if (this.sel.length === n) return this.sel;
    const sel = new Uint8Array(n);
    sel.set(this.sel);
    return sel;
  }

  // Makes the model one closed outer surface: every gap is patched, and what
  // is left inside (inner shells, loose bits in the hollow) is removed.
  fillCentre() {
    this.remember(KEYS, false);
    const d = this.data;
    let filled = 0, removed = 0;
    for (let pass = 0; pass < 3; pass++) {
      const r = ops.fillGaps(d, null);
      filled += r.filled;
      this.sel = this.grown();
      const { hidden, count } = ops.hiddenTriangles(d);
      if (count && count < d.index.length / 3) {
        this.moveSelection(ops.keepTriangles(d, (t) => !hidden[t]));
        removed += count;
      } else if (!r.filled) break;
    }
    // removing the inside can open the surface where it met the outside
    filled += ops.fillGaps(d, null).filled;
    if (!filled && !removed) {
      this.forget();
      return 'Nothing to fill: the model is already one closed surface.';
    }
    this.sel = this.grown();
    this.countSelected();
    ops.computeNormals(d);
    this.rebuild();
    const parts = [];
    if (filled) parts.push(`closed ${filled.toLocaleString()} ${filled === 1 ? 'gap' : 'gaps'}`);
    if (removed) parts.push(`removed ${removed.toLocaleString()} hidden triangles from the inside`);
    const text = parts.join(' and ');
    return text[0].toUpperCase() + text.slice(1) + '.';
  }

  // ───────────── saving

  // The edited model as a .glb file.
  exportBlob() {
    return new Blob(ops.writeGlb(this.data), { type: 'model/gltf-binary' });
  }

  dispose() {
    for (const [type, fn] of Object.entries(this.handlers)) this.canvas.removeEventListener(type, fn);
    this.viewer.controls.removeEventListener('change', this.onCamera);
    this.setTool('orbit');
    this.ring.remove();
    this.box.remove();
    if (this.pickTarget) this.pickTarget.dispose();
    this.pickMaterial.dispose();
  }
}
