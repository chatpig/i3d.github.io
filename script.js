// image-to-3d — playground and page behaviour. No dependencies; the 3D viewer
// (viewer.js + vendor/three) is loaded the first time a model has to be shown.
'use strict';

const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ───────────────────────────── settings

const DEFAULTS = {
  endpoint: 'http://127.0.0.1:8888/v1/images/edits',
  apiKey: '',
  model: '',
  pipeline: '',
  format: 'glb',
  seed: '',
  steps: '',
  guidance: '',
  background: 'auto',
  texture: true,
};
const STORE = 'i3d-settings';

function loadSettings() {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORE) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}
let settings = loadSettings();

function saveSettings(next) {
  settings = { ...DEFAULTS, ...next };
  try {
    localStorage.setItem(STORE, JSON.stringify(settings));
  } catch {}
}

// http://host:8888/v1/images/edits -> http://host:8888/v1 (the model list lives next to it)
function apiBase(endpoint) {
  const trimmed = endpoint.replace(/\/+$/, '');
  if (/\/images\/edits$/.test(trimmed)) return trimmed.replace(/\/images\/edits$/, '');
  try {
    return new URL(endpoint).origin + '/v1';
  } catch {
    return trimmed;
  }
}

function authHeaders(s = settings) {
  return s.apiKey ? { Authorization: 'Bearer ' + s.apiKey } : {};
}

function toast(message) {
  const t = $('toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
}

async function copyText(text, label) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast(label || 'Copied');
}

// ───────────────────────────── connection status

async function fetchJson(url, s, timeoutMs = 4000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: authHeaders(s), signal: ctl.signal });
    const data = await res.json().catch(() => null);
    return { res, data };
  } finally {
    clearTimeout(timer);
  }
}

// Why a request to the endpoint cannot even leave the browser, in words.
function unreachableReason(endpoint) {
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    return 'That endpoint is not a valid URL. Open Settings to fix it.';
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (location.protocol === 'https:' && url.protocol === 'http:' && !local) {
    return 'This page is served over HTTPS, and browsers block plain http:// requests to other machines. Use an https:// endpoint (a tunnel or gateway), or open this page from your own machine.';
  }
  if (local) {
    return 'If the server is running, your browser may be asking for permission to reach devices on your local network: allow it for this site. Safari blocks local servers from HTTPS pages altogether.';
  }
  return 'Check the address, that the server is running, and that it allows requests from web pages (CORS).';
}

// { ok, label, detail }
async function probe(s = settings) {
  const base = apiBase(s.endpoint);
  try {
    const { res, data } = await fetchJson(base + '/models', s);
    if (res.status === 401 || res.status === 403) return { ok: false, label: 'key rejected', detail: 'The server answered, but refused the API key. Set it in Settings.' };
    if (!res.ok) return { ok: false, label: 'error ' + res.status, detail: `The server answered ${res.status} for ${base}/models.` };
    const models = data && Array.isArray(data.data) ? data.data : [];
    const model = models.find((m) => m && m.meta && m.meta.type === 'image-to-3d') || (s.model && models.find((m) => m && m.id === s.model)) || models[0] || null;
    const is3d = !!(model && model.meta && model.meta.type === 'image-to-3d');
    return {
      ok: true,
      label: model ? String(model.id) : 'connected',
      // a gateway lists many models and says nothing of their kind: only a lone model of another kind is worth a remark
      detail: models.length === 1 && model.meta && !is3d ? 'Connected, but the model there does not look like an image-to-3D model.' : '',
    };
  } catch {
    return { ok: false, label: 'offline', detail: unreachableReason(s.endpoint) };
  }
}

async function refreshConnection() {
  $('endpoint-label').textContent = settings.endpoint;
  const conn = $('conn');
  conn.className = 'conn';
  $('conn-text').textContent = 'checking';
  const state = await probe();
  conn.className = 'conn ' + (state.ok ? 'ok' : 'bad');
  $('conn-text').textContent = state.label.length > 28 ? state.label.slice(0, 27) + '…' : state.label;
  conn.title = state.ok ? `Connected to ${settings.endpoint}` : `Cannot reach ${settings.endpoint}`;
  $('offline').hidden = state.ok;
  $('offline-detail').textContent = state.ok ? '' : state.detail;
  return state;
}

// ───────────────────────────── settings dialog

const dlg = $('dlg-settings');
const form = $('settings-form');

function fillSettingsForm(s) {
  form.endpoint.value = s.endpoint;
  form.apiKey.value = s.apiKey;
  form.model.value = s.model;
  form.pipeline.value = s.pipeline;
  form.format.value = s.format;
  form.seed.value = s.seed;
  form.steps.value = s.steps;
  form.guidance.value = s.guidance;
  form.background.value = s.background;
  form.texture.checked = !!s.texture;
  $('test-result').textContent = '';
  $('test-result').className = 'status';
}

function readSettingsForm() {
  return {
    endpoint: form.endpoint.value.trim() || DEFAULTS.endpoint,
    apiKey: form.apiKey.value.trim(),
    model: form.model.value.trim(),
    pipeline: form.pipeline.value,
    format: form.format.value,
    seed: form.seed.value.trim(),
    steps: form.steps.value.trim(),
    guidance: form.guidance.value.trim(),
    background: form.background.value,
    texture: form.texture.checked,
  };
}

function openSettings() {
  fillSettingsForm(settings);
  dlg.showModal();
}
$('btn-settings').addEventListener('click', openSettings);
$$('[data-open-settings]').forEach((b) => b.addEventListener('click', openSettings));
$$('[data-close]', dlg).forEach((b) => b.addEventListener('click', () => dlg.close()));
dlg.addEventListener('click', (e) => {
  if (e.target === dlg) dlg.close(); // click on the backdrop
});

$('btn-reset').addEventListener('click', () => fillSettingsForm(DEFAULTS));

$('btn-test').addEventListener('click', async () => {
  const out = $('test-result');
  out.className = 'status spin';
  out.textContent = 'Connecting…';
  const state = await probe(readSettingsForm());
  out.className = 'status ' + (state.ok ? 'ok' : 'bad');
  out.textContent = state.ok ? `Connected: ${state.label}${state.detail ? ' — ' + state.detail : ''}` : state.detail;
});

form.addEventListener('submit', (e) => {
  e.preventDefault();
  const next = readSettingsForm();
  try {
    new URL(next.endpoint);
  } catch {
    $('test-result').className = 'status bad';
    $('test-result').textContent = 'The endpoint is not a valid URL.';
    return;
  }
  saveSettings(next);
  dlg.close();
  toast('Settings saved');
  refreshConnection();
});

// ───────────────────────────── formatting

function fmtClock(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
function fmtSeconds(s) {
  return s < 60 ? s.toFixed(s < 10 ? 1 : 0) + ' s' : Math.floor(s / 60) + ' min ' + Math.round(s % 60) + ' s';
}
function fmtBytes(n) {
  return n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB';
}
function fmtCount(n) {
  return n >= 1e6 ? (n / 1e6).toFixed(2) + ' M' : n >= 1e3 ? Math.round(n / 1e3) + ' k' : String(n);
}

// ───────────────────────────── the request

const IMAGE_TYPES = /^image\/(png|jpeg|webp|bmp)$/;
const IMAGE_NAMES = /\.(png|jpe?g|webp|bmp)$/i;
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
// a model from disk is not generated: it is opened in the viewer, to look at or to edit
const MODEL_NAMES = /\.(glb|ply|obj)$/i;

// The form fields of a request, as the settings describe it. The picture itself is the `image` file part.
function buildFields() {
  const fields = {};
  if (settings.model) fields.model = settings.model;
  if (settings.pipeline) fields.pipeline = settings.pipeline;
  if (settings.format !== 'glb') fields.output_format = settings.format;
  if ($('opt-random').checked) fields.seed = -1;
  else if (settings.seed !== '') fields.seed = Number(settings.seed);
  if (settings.steps !== '') fields.steps = Number(settings.steps);
  if (settings.guidance !== '') fields.guidance = Number(settings.guidance);
  if (settings.background !== 'auto') fields.background = settings.background;
  if (!settings.texture) fields.texture = false;
  return fields;
}

const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

function asCurl(job) {
  const lines = [`curl -f ${shq(job.endpoint)}`];
  if (job.keyed) lines.push('  -H "Authorization: Bearer $API_KEY"');
  lines.push(`  -F ${shq('image=@' + job.file.name)}`);
  for (const [k, v] of Object.entries(job.fields)) lines.push(`  -F ${shq(k + '=' + v)}`);
  lines.push(`  --output ${shq(job.stem + '.' + job.format)}`);
  return lines.join(' \\\n');
}

// base64 -> bytes, for a gateway that answers with OpenAI's images object instead of the file
function decodeBase64(text) {
  const bin = atob(text.replace(/^data:[^,]*,/, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

// Sends one picture and resolves to { blob, format, headers } once the mesh has arrived.
async function requestMesh(job, signal, onProgress) {
  const body = new FormData();
  body.append('image', job.file, job.file.name);
  for (const [k, v] of Object.entries(job.fields)) body.append(k, String(v));

  const res = await fetch(job.endpoint, { method: 'POST', headers: authHeaders(), body, signal });
  if (!res.ok) {
    let message = `The server answered ${res.status}.`;
    try {
      const err = await res.json();
      if (err && err.error && err.error.message) message = err.error.message;
    } catch {}
    if (res.status === 401 || res.status === 403) message += ' Check the API key in Settings.';
    throw new Error(message);
  }

  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress(received, total);
  }

  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  const info = {
    vertices: Number(res.headers.get('x-mesh-vertices')) || 0,
    triangles: Number(res.headers.get('x-mesh-triangles')) || 0,
    resolution: Number(res.headers.get('x-mesh-resolution')) || 0,
    seed: res.headers.get('x-seed'),
    cost: res.headers.get('x-gateway-cost-usd'),
  };
  if (type === 'application/json') {
    const data = JSON.parse(await new Blob(chunks).text());
    const b64 = data && data.data && data.data[0] && data.data[0].b64_json;
    if (!b64) throw new Error('The server answered with JSON that holds no mesh (data[0].b64_json).');
    const mesh = data.mesh || {};
    return {
      blob: new Blob([decodeBase64(b64)]),
      format: data.output_format || job.format,
      info: { ...info, vertices: mesh.vertices || 0, triangles: mesh.triangles || 0, resolution: mesh.resolution || 0, seed: mesh.seed ?? info.seed },
    };
  }
  const format = type === 'model/obj' ? 'obj' : type === 'model/gltf-binary' ? 'glb' : job.format;
  return { blob: new Blob(chunks, { type: type || 'application/octet-stream' }), format, info };
}

// ───────────────────────────── the queue: one picture, one model, one at a time

const jobs = []; // { id, file, thumb, stem, status, error, fields, endpoint, keyed, format, result, took }
let nextId = 1;
let running = null; // { job, controller, t0, timer }
let shownId = 0;

function setStatus(text, cls = '') {
  const el = $('status');
  el.className = 'status ' + cls;
  el.textContent = text;
}

function renderQueue() {
  const list = $('queue');
  list.textContent = '';
  for (const job of jobs) {
    const li = document.createElement('li');
    if (job.id === shownId) li.className = 'current';

    const img = document.createElement('img');
    img.src = job.thumb;
    img.alt = '';

    const text = document.createElement('div');
    const name = document.createElement('div');
    name.className = 'q-name';
    name.textContent = job.file.name;
    const state = document.createElement('div');
    state.className = 'q-state';
    if (job.status === 'queued') state.textContent = 'waiting';
    else if (job.status === 'running') state.textContent = 'generating…';
    else if (job.status === 'stopped') state.textContent = 'stopped';
    else if (job.status === 'error') {
      state.textContent = job.error;
      state.classList.add('bad');
    } else {
      const r = job.result;
      state.textContent = [r.info.triangles ? fmtCount(r.info.triangles) + ' triangles' : '', fmtBytes(r.blob.size), job.local ? 'opened from disk' : fmtSeconds(job.took)].filter(Boolean).join(' · ');
      state.classList.add('ok');
    }
    text.append(name, state);

    const btns = document.createElement('div');
    btns.className = 'q-btns';
    const button = (label, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      btns.append(b);
    };
    if (job.status === 'done' && job.id !== shownId) button('View', 'Show this model in the viewer', () => showJob(job));
    if (job.status === 'error' || job.status === 'stopped') button('Retry', 'Send this picture again', () => retryJob(job));
    if (job.status !== 'running') button('✕', 'Remove', () => removeJob(job));

    li.append(img, text, btns);
    list.append(li);
  }
}

function addFiles(files) {
  let added = 0;
  let skipped = '';
  let opened = null;
  for (const file of files) {
    if (MODEL_NAMES.test(file.name)) {
      const format = file.name.split('.').pop().toLowerCase();
      opened = {
        id: nextId++,
        file,
        thumb: 'logo.svg',
        stem: file.name.replace(/\.[^.]+$/, '') || 'model',
        status: 'done',
        local: true,
        format,
        result: { blob: file, format, info: {}, url: URL.createObjectURL(file) },
      };
      jobs.push(opened);
      continue;
    }
    if (!IMAGE_TYPES.test(file.type) && !IMAGE_NAMES.test(file.name)) {
      skipped = `${file.name || 'That file'} is not a PNG, JPEG, WebP or BMP picture, nor a .glb, .ply or .obj model.`;
      continue;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      skipped = `${file.name} is over 50 MB.`;
      continue;
    }
    const name = file.name || `pasted-${nextId}.png`;
    jobs.push({
      id: nextId++,
      file: file.name ? file : new File([file], name, { type: file.type }),
      thumb: URL.createObjectURL(file),
      stem: name.replace(/\.[^.]+$/, '') || 'model',
      status: 'queued',
    });
    added++;
  }
  if (skipped) setStatus(skipped, 'bad');
  else if (added || opened) setStatus('');
  if (added) {
    renderQueue();
    pump();
  }
  if (opened) showJob(opened);
}

function removeJob(job) {
  const i = jobs.indexOf(job);
  if (i < 0) return;
  jobs.splice(i, 1);
  URL.revokeObjectURL(job.thumb);
  if (job.result) URL.revokeObjectURL(job.result.url);
  if (job.id === shownId) {
    shownId = 0;
    const other = [...jobs].reverse().find((j) => j.status === 'done');
    if (other) showJob(other);
    else clearViewer();
  }
  renderQueue();
}

function retryJob(job) {
  job.status = 'queued';
  job.error = '';
  renderQueue();
  pump();
}

// Starts the next waiting picture, if nothing is being generated.
async function pump() {
  if (running) return;
  const job = jobs.find((j) => j.status === 'queued');
  if (!job) return;

  // the request is fixed when it starts, so "copy as curl" shows what was really sent
  job.fields = buildFields();
  job.endpoint = settings.endpoint;
  job.keyed = !!settings.apiKey;
  job.format = settings.format;
  job.status = 'running';

  const controller = new AbortController();
  const t0 = performance.now();
  running = { job, controller };
  const waiting = jobs.filter((j) => j.status === 'queued').length;
  $('btn-stop').hidden = false;
  $('stage-empty').hidden = true;
  $('stage-busy').hidden = false;
  $('busy-bar').className = 'bar';
  $('busy-text').textContent = `Generating ${job.file.name}…`;
  $('busy-hint').textContent = waiting ? `${waiting} more waiting` : 'The model arrives in one piece when it is done.';
  $('busy-time').textContent = '0:00';
  running.timer = setInterval(() => ($('busy-time').textContent = fmtClock(performance.now() - t0)), 500);
  setStatus('Generating…', 'spin');
  renderQueue();

  try {
    const result = await requestMesh(job, controller.signal, (received, total) => {
      $('busy-text').textContent = total ? `Receiving the model… ${fmtBytes(received)} of ${fmtBytes(total)}` : `Receiving the model… ${fmtBytes(received)}`;
      if (total) {
        $('busy-bar').className = 'bar known';
        $('busy-bar').firstElementChild.style.width = Math.round((received / total) * 100) + '%';
      }
    });
    job.took = (performance.now() - t0) / 1000;
    job.result = { ...result, url: URL.createObjectURL(result.blob) };
    job.format = result.format;
    job.status = 'done';
    setStatus(`Done in ${fmtSeconds(job.took)}`, 'ok');
    stopRunning();
    await showJob(job);
  } catch (e) {
    stopRunning();
    if (e.name === 'AbortError') {
      job.status = 'stopped';
      setStatus('Stopped waiting. The server still finishes the model it started before it takes the next picture.');
    } else if (e instanceof TypeError) {
      // fetch() itself failed: the request never got an answer
      job.status = 'error';
      job.error = 'Could not reach the server.';
      setStatus('Could not reach the server. ' + unreachableReason(job.endpoint), 'bad');
      refreshConnection();
    } else {
      job.status = 'error';
      job.error = e.message;
      setStatus(e.message, 'bad');
    }
  }
  renderQueue();
  // a server that cannot be reached will not take the next picture either
  if (job.status === 'done' || (job.status === 'error' && job.error !== 'Could not reach the server.')) pump();
}

function stopRunning() {
  if (!running) return;
  clearInterval(running.timer);
  running = null;
  $('btn-stop').hidden = true;
  $('stage-busy').hidden = true;
  $('busy-bar').firstElementChild.style.width = '';
  if (!shownId) $('stage-empty').hidden = false;
}

$('btn-stop').addEventListener('click', () => {
  if (!running) return;
  // Stop means stop: the pictures still waiting are not sent either
  for (const j of jobs) if (j.status === 'queued') j.status = 'stopped';
  running.controller.abort();
});

// ───────────────────────────── the upload box

const drop = $('drop');
$('file-input').addEventListener('change', (e) => {
  addFiles([...e.target.files]);
  e.target.value = ''; // the same picture can be chosen again
});
['dragenter', 'dragover'].forEach((type) =>
  drop.addEventListener(type, (e) => {
    e.preventDefault();
    drop.classList.add('over');
  })
);
['dragleave', 'drop'].forEach((type) => drop.addEventListener(type, () => drop.classList.remove('over')));
drop.addEventListener('drop', (e) => {
  e.preventDefault();
  addFiles([...e.dataTransfer.files]);
});
// a picture dropped beside the box should not replace the page
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  if (!e.defaultPrevented) {
    e.preventDefault();
    if (e.dataTransfer && e.dataTransfer.files.length) addFiles([...e.dataTransfer.files]);
  }
});
document.addEventListener('paste', (e) => {
  if (e.target.closest && e.target.closest('input, textarea')) return;
  const files = [...((e.clipboardData && e.clipboardData.files) || [])];
  if (files.length) {
    e.preventDefault();
    addFiles(files);
  }
});

// ───────────────────────────── the viewer

let viewer = null;
let viewerFailed = '';

async function getViewer() {
  if (viewer) return viewer;
  const { Viewer } = await import('./viewer.js');
  viewer = new Viewer($('stage'));
  viewer.setAutoRotate($('tog-rotate').getAttribute('aria-pressed') === 'true');
  viewer.setWireframe($('tog-wire').getAttribute('aria-pressed') === 'true');
  viewer.setClay($('tog-clay').getAttribute('aria-pressed') === 'true');
  return viewer;
}

function clearViewer() {
  if (viewer) viewer.clear();
  $('out').hidden = true;
  $('stage-empty').hidden = !!running;
}

function showMeta(items) {
  const meta = $('meta');
  meta.textContent = '';
  for (const [k, v] of items) {
    const div = document.createElement('div');
    const dt = document.createElement('dt');
    const dd = document.createElement('dd');
    dt.textContent = k;
    dd.textContent = v;
    dd.title = v;
    div.append(dt, dd);
    meta.append(div);
  }
}

async function showJob(job) {
  const r = job.result;
  keepEdits();
  setEditStatus('');
  shownId = job.id;
  renderQueue();

  $('download').href = r.url;
  $('download').download = `${job.stem}.${r.format}`;
  $('download').textContent = `Download .${r.format}`;
  document.querySelector('.req').hidden = !!job.local; // no request was made for a model from disk
  $('req-view').textContent = job.local ? '' : asCurl(job);
  $('out').hidden = false;
  $('stage-empty').hidden = true;
  $('out').scrollIntoView({ block: 'nearest', behavior: 'smooth' });

  const meta = (counted) => {
    const vertices = r.info.vertices || (counted && r.format !== 'obj' && counted.vertices) || 0;
    const triangles = r.info.triangles || (counted && counted.triangles) || 0;
    const items = [];
    if (vertices) items.push(['vertices', fmtCount(vertices)]);
    if (triangles) items.push(['triangles', fmtCount(triangles)]);
    if (r.info.resolution) items.push(['grid', r.info.resolution + '³']);
    items.push(['size', fmtBytes(r.blob.size)]);
    if (!job.local) items.push(['took', fmtSeconds(job.took)]);
    if (r.info.seed !== null && r.info.seed !== undefined) items.push(['seed', String(r.info.seed)]);
    if (r.info.cost !== null && r.info.cost !== undefined) items.push(['cost', '$' + r.info.cost]);
    showMeta(items);
  };
  meta(null);

  if (viewerFailed) return;
  const busy = !running;
  if (busy) {
    $('stage-busy').hidden = false;
    $('busy-time').textContent = '';
    $('busy-text').textContent = 'Opening the model…';
    $('busy-hint').textContent = '';
    $('busy-bar').className = 'bar';
  }
  try {
    const v = await getViewer();
    // a model that was edited comes back as it was left
    const counted = job.edited ? await v.show(await job.edited.arrayBuffer(), 'glb') : await v.show(await r.blob.arrayBuffer(), r.format);
    if (shownId === job.id) {
      if (!job.edited) meta(counted);
      if (editing) await getEditor();
    }
  } catch (e) {
    console.error(e);
    // the model is fine either way: it can still be downloaded
    const hint = location.protocol === 'file:' ? 'The 3D preview needs this page served over http(s): run "python -m http.server" in its folder. ' : 'The 3D preview could not start in this browser (WebGL is needed). ';
    if (!viewer) viewerFailed = hint;
    setStatus((viewer ? 'This model could not be displayed. ' : hint) + 'The download works regardless.', 'bad');
  } finally {
    if (busy && !running) $('stage-busy').hidden = true;
  }
}

function toggle(id, apply) {
  $(id).addEventListener('click', () => {
    const on = $(id).getAttribute('aria-pressed') !== 'true';
    $(id).setAttribute('aria-pressed', String(on));
    if (viewer) apply(viewer, on);
  });
}
toggle('tog-rotate', (v, on) => v.setAutoRotate(on));
toggle('tog-wire', (v, on) => v.setWireframe(on));
toggle('tog-clay', (v, on) => v.setClay(on));
$('btn-reset-view').addEventListener('click', () => viewer && viewer.resetView());
$('btn-copy-curl').addEventListener('click', (e) => {
  e.preventDefault(); // it sits in the <summary>: copying should not fold the details
  copyText($('req-view').textContent, 'curl command copied');
});
$('btn-retry').addEventListener('click', async () => {
  const state = await refreshConnection();
  if (state.ok) {
    for (const j of jobs) if (j.status === 'error' && j.error === 'Could not reach the server.') j.status = 'queued';
    renderQueue();
    pump();
  }
});

// ───────────────────────────── the editor: changes to the model in the viewer

let editor = null; // editor.js, loaded the first time Edit is opened
let editing = false; // the Edit panel is open
let editBusy = false;

const shownJob = () => jobs.find((j) => j.id === shownId);

function setEditStatus(text, cls = '') {
  const el = $('ed-status');
  el.className = 'status ' + cls;
  el.textContent = text;
}

function showEditState(state) {
  const none = !state.selected;
  $('ed-hint').textContent =
    `${fmtCount(state.vertices)} vertices, ${fmtCount(state.triangles)} triangles. ` +
    (none ? 'Nothing selected: Surface and Fill work on the whole model.' : `${state.selected.toLocaleString()} vertices selected: Region, Surface and Fill work on them.`);
  $('ed-crop').disabled = $('ed-delete').disabled = $('ed-grow').disabled = none;
  $('ed-undo').disabled = !state.canUndo;
  $('ed-redo').disabled = !state.canRedo;
  const job = shownJob();
  $('ed-reset').disabled = !state.dirty && !(job && job.edited);
}

// The editor, holding the model the viewer shows; null when there is none.
async function getEditor() {
  if (!viewer || !viewer.model) return null;
  if (!editor) {
    const { Editor } = await import('./editor.js');
    if (!editor) editor = new Editor(viewer, showEditState);
    editor.brushSize = Number($('ed-brush').value);
    editor.tolerance = Number($('ed-tolerance').value) / 100;
    editor.visibleOnly = $('ed-visible').checked;
  }
  if (!viewer.model) return null;
  if (!editor.active) {
    if (!editor.open()) return null;
    setTool(currentTool());
  }
  return editor;
}

// Before another model takes the viewer: the edits made to this one stay with it.
function keepEdits() {
  const job = shownJob();
  if (job && editor && editor.active && editor.dirty) job.edited = editor.exportBlob();
}

// Runs one operation of the editor, with a word in the status line before and after.
async function edit(label, fn) {
  if (editBusy) return;
  editBusy = true;
  try {
    const ed = await getEditor();
    if (!ed) {
      setEditStatus('There is no model in the viewer to edit.', 'bad');
      return;
    }
    if (label) {
      setEditStatus(label, 'spin');
      await new Promise((done) => requestAnimationFrame(() => setTimeout(done, 0))); // let the label show
    }
    const said = fn(ed);
    if (said !== undefined) setEditStatus(said, 'ok');
  } catch (e) {
    console.error(e);
    setEditStatus(e instanceof RangeError ? 'Not enough memory for that on this model.' : 'That did not work: ' + e.message, 'bad');
  } finally {
    editBusy = false;
  }
}

const currentTool = () => (document.querySelector('#editor [data-tool][aria-pressed="true"]') || {}).dataset.tool || 'orbit';

function setTool(tool) {
  $$('#editor [data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === tool)));
  $('ed-brush-opt').hidden = tool !== 'brush';
  $('ed-box-opt').hidden = tool !== 'box';
  $('ed-wand-opt').hidden = tool !== 'wand';
  if (tool !== 'orbit') {
    // a model that turns by itself cannot be drawn on
    $('tog-rotate').setAttribute('aria-pressed', 'false');
    if (viewer) viewer.setAutoRotate(false);
    setEditStatus(
      tool === 'brush' ? 'Drag over the model to select. Shift-drag takes away. The right button turns the model.'
        : tool === 'box' ? 'Drag a rectangle to select. Shift-drag takes away. The right button turns the model.'
          : 'Click a colour to select its area. Shift-click takes away. The right button turns the model.'
    );
  } else if (/right button/.test($('ed-status').textContent)) setEditStatus('');
  if (editor) editor.setTool(tool);
}

$('tog-edit').addEventListener('click', async () => {
  editing = $('tog-edit').getAttribute('aria-pressed') !== 'true';
  $('tog-edit').setAttribute('aria-pressed', String(editing));
  $('editor').hidden = !editing;
  if (!editing) {
    // the edits stay; only the selecting stops
    setTool('orbit');
    return;
  }
  if (viewerFailed) {
    setEditStatus('The editor needs the 3D preview, which could not start in this browser.', 'bad');
    return;
  }
  setEditStatus('Preparing the model…', 'spin');
  await edit('', () => '');
  $('editor').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
});

$$('#editor [data-tool]').forEach((b) =>
  b.addEventListener('click', async () => {
    await getEditor();
    setTool(b.dataset.tool);
  })
);
$('ed-brush').addEventListener('input', (e) => editor && (editor.brushSize = Number(e.target.value)));
$('ed-tolerance').addEventListener('input', (e) => editor && (editor.tolerance = Number(e.target.value) / 100));
$('ed-visible').addEventListener('change', (e) => editor && (editor.visibleOnly = e.target.checked));

$('ed-all').addEventListener('click', () => edit('', (ed) => ed.selectAll()));
$('ed-none').addEventListener('click', () => edit('', (ed) => ed.selectNone()));
$('ed-invert').addEventListener('click', () => edit('', (ed) => ed.invertSelection()));
$('ed-grow').addEventListener('click', () => edit('', (ed) => ed.growSelection()));

$('ed-crop').addEventListener('click', () => edit('Cropping…', (ed) => ed.crop()));
$('ed-delete').addEventListener('click', () => edit('Deleting…', (ed) => ed.remove()));
$('ed-paint').addEventListener('click', () => edit('Colouring…', (ed) => ed.paint($('ed-color').value)));
$('ed-smooth').addEventListener('click', () => edit('Smoothing…', (ed) => ed.smooth(Number($('ed-smooth-n').value))));

// metallic, roughness: what the look is made of
const STYLES = { plastic: [0, 0.3, 'Plastic'], metal: [1, 0.25, 'Metal'], matte: [0, 0.9, 'Matte'] };
$$('#editor [data-style]').forEach((b) =>
  b.addEventListener('click', () => edit('Changing the material…', (ed) => ed.setMaterial(...STYLES[b.dataset.style])))
);

// one press moves the surface by 0.4 % of the model's size
$('ed-fill-out').addEventListener('click', () => edit('Filling out…', (ed) => ed.inflate(0.004)));
$('ed-slim').addEventListener('click', () => edit('Slimming…', (ed) => ed.inflate(-0.004)));
$('ed-fill-gaps').addEventListener('click', () => edit('Filling the gaps…', (ed) => ed.fillGaps(Number($('ed-gap-size').value))));
$('ed-fill-centre').addEventListener('click', () => edit('Filling the centre…', (ed) => ed.fillCentre()));

$('ed-undo').addEventListener('click', () => edit('', (ed) => (ed.undo(), 'Undone.')));
$('ed-redo').addEventListener('click', () => edit('', (ed) => (ed.redo(), 'Redone.')));
$('ed-reset').addEventListener('click', () => {
  const job = shownJob();
  if (!job || editBusy || !confirm('Discard every edit and go back to the model as it was?')) return;
  job.edited = null;
  if (editor) editor.dirty = false;
  showJob(job).then(() => setEditStatus('Back to the original.', 'ok'));
});

$('ed-save').addEventListener('click', () =>
  edit('Writing the file…', (ed) => {
    const job = shownJob();
    const blob = ed.exportBlob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${job ? job.stem : 'model'}-edited.glb`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
    return `Saved ${a.download}, ${fmtBytes(blob.size)}.`;
  })
);

document.addEventListener('keydown', (e) => {
  if (!editing || !(e.ctrlKey || e.metaKey) || e.altKey || e.target.closest('input, textarea, select, dialog')) return;
  const key = e.key.toLowerCase();
  if (key !== 'z' && key !== 'y') return;
  e.preventDefault();
  $(key === 'y' || e.shiftKey ? 'ed-redo' : 'ed-undo').click();
});

// ───────────────────────────── docs: runtime switch, tabs, copy buttons

function setRuntime(rt) {
  $$('.rt').forEach((el) => (el.textContent = rt));
  $$('.pkg').forEach((el) => (el.textContent = rt === 'gguf' ? 'gguf-core' : 'ggk'));
  const radio = document.querySelector(`input[name="runtime"][value="${rt}"]`);
  if (radio) radio.checked = true;
  try {
    localStorage.setItem('i3d-runtime', rt);
  } catch {}
}
$$('input[name="runtime"]').forEach((r) => r.addEventListener('change', () => setRuntime(r.value)));
try {
  if (localStorage.getItem('i3d-runtime') === 'gguf') setRuntime('gguf');
} catch {}

$$('.tabs button').forEach((tab) =>
  tab.addEventListener('click', () => {
    $$('.tabs button').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    $$('.examples [role="tabpanel"]').forEach((p) => (p.hidden = p.id !== tab.dataset.tab));
  })
);

$$('main pre').forEach((pre) => {
  if (pre.closest('.req') || pre.closest('.prompt-card')) return;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'copy';
  btn.textContent = 'copy';
  btn.addEventListener('click', () => copyText(pre.querySelector('code').textContent, 'Copied'));
  pre.append(btn);
});

// ───────────────────────────── for agents

const guideUrl = new URL('llms-full.txt', location.href).href;
if (/^https?:/.test(location.protocol)) $$('.abs-guide').forEach((el) => (el.textContent = guideUrl));

$('btn-copy-prompt').addEventListener('click', () => copyText($('agent-prompt').textContent, 'Prompt copied'));
$('btn-copy-guide').addEventListener('click', async () => {
  try {
    const res = await fetch(guideUrl);
    if (!res.ok) throw new Error();
    await copyText(await res.text(), 'Guide copied: paste it into your agent');
  } catch {
    window.open(guideUrl, '_blank', 'noopener');
  }
});

// ───────────────────────────── theme

$('btn-theme').addEventListener('click', () => {
  const root = document.documentElement;
  const dark = root.dataset.theme ? root.dataset.theme === 'dark' : matchMedia('(prefers-color-scheme: dark)').matches;
  root.dataset.theme = dark ? 'light' : 'dark';
  try {
    localStorage.setItem('i3d-theme', root.dataset.theme);
  } catch {}
});

refreshConnection();
