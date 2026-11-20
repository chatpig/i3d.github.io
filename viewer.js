// image-to-3d — the 3D viewer. An ES module, imported by script.js the first
// time a model has to be shown; three.js comes from vendor/three (see the
// import map in index.html).

import * as THREE from 'three';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { RoomEnvironment } from './vendor/three/RoomEnvironment.js';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';

// The per-vertex metallic and roughness of a TRELLIS.2 mesh: the glTF
// application attribute _METALLIC_ROUGHNESS (GLTFLoader lower-cases the name)
// and the PLY properties `metallic`, `roughness`, mapped to the same name.
const MR = '_metallic_roughness';

// A standard material that reads metalness and roughness from that attribute
// instead of using one value for the whole mesh.
function withVertexPbr(material) {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\nattribute vec2 ${MR};\nvarying vec2 vVertexMR;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>\nvVertexMR = ${MR};`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vVertexMR;')
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vVertexMR.x;')
      .replace('#include <roughnessmap_fragment>', 'float roughnessFactor = max(vVertexMR.y, 0.04);');
  };
  material.customProgramCacheKey = () => 'vertex-pbr';
  return material;
}

function standardMaterial(geometry) {
  const colored = !!geometry.getAttribute('color');
  const material = new THREE.MeshStandardMaterial({
    color: colored ? 0xffffff : 0xc9ccd4,
    vertexColors: colored,
    metalness: 0,
    roughness: 0.6,
    side: THREE.DoubleSide,
  });
  return geometry.getAttribute(MR) ? withVertexPbr(material) : material;
}

// .ply and .obj come z-up, as generated; glTF is y-up
function zUpToYUp(object) {
  object.rotation.x = -Math.PI / 2;
  return object;
}

async function parseModel(buffer, format) {
  if (format === 'ply') {
    const { PLYLoader } = await import('./vendor/three/PLYLoader.js');
    const loader = new PLYLoader();
    loader.setCustomPropertyNameMapping({ [MR]: ['metallic', 'roughness'] });
    const geometry = loader.parse(buffer);
    if (!geometry.getAttribute('normal')) geometry.computeVertexNormals();
    return zUpToYUp(new THREE.Mesh(geometry, standardMaterial(geometry)));
  }
  if (format === 'obj') {
    const { OBJLoader } = await import('./vendor/three/OBJLoader.js');
    const object = new OBJLoader().parse(new TextDecoder().decode(buffer));
    object.traverse((child) => {
      if (child.isMesh) child.material = standardMaterial(child.geometry);
    });
    return zUpToYUp(object);
  }
  const gltf = await new GLTFLoader().parseAsync(buffer, '');
  const scene = gltf.scene || gltf.scenes[0];
  scene.traverse((child) => {
    if (child.isMesh && child.geometry.getAttribute(MR)) withVertexPbr(child.material);
  });
  return scene;
}

function dispose(root) {
  root.traverse((child) => {
    if (child.geometry) child.geometry.dispose();
    // the model's own material, whichever one is on the mesh right now
    for (const material of [].concat(child.userData.material || [])) material.dispose();
  });
}

export class Viewer {
  constructor(container) {
    this.container = container;
    this.model = null;
    this.radius = 1;
    this.dirty = true;
    this.wireframe = false;
    this.clay = false;

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer = renderer;
    container.prepend(renderer.domElement);

    this.scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    this.environment = pmrem.fromScene(new RoomEnvironment(), 0.04);
    this.scene.environment = this.environment.texture;
    pmrem.dispose();
    const key = new THREE.DirectionalLight(0xffffff, 1.2);
    key.position.set(3, 5, 4);
    this.scene.add(key);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);
    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 1.6;
    this.controls.addEventListener('change', () => (this.dirty = true));

    this.clayMaterial = new THREE.MeshStandardMaterial({ color: 0xb9bcc6, metalness: 0, roughness: 0.75, side: THREE.DoubleSide });

    this.resizer = new ResizeObserver(() => this.resize());
    this.resizer.observe(container);
    this.resize();

    // draws only when something moved: a 1.6M-triangle mesh is not redrawn 60 times a second for nothing
    const tick = () => {
      this.frame = requestAnimationFrame(tick);
      this.controls.update();
      if (this.dirty) {
        this.dirty = false;
        renderer.render(this.scene, this.camera);
      }
    };
    tick();
  }

  resize() {
    const w = this.container.clientWidth || 1;
    const h = this.container.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.dirty = true;
  }

  clear() {
    if (!this.model) return;
    this.scene.remove(this.model);
    dispose(this.model);
    this.model = null;
    this.dirty = true;
  }

  // buffer: the bytes of the mesh file; format: glb | ply | obj.
  // Returns { vertices, triangles } as the viewer counted them.
  async show(buffer, format) {
    const object = await parseModel(buffer, format);
    this.clear();

    // centre it on the origin and scale it to a unit-ish size
    const pivot = new THREE.Group();
    pivot.add(object);
    pivot.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(pivot);
    const size = box.getSize(new THREE.Vector3());
    const scale = 2 / Math.max(size.x, size.y, size.z, 1e-6);
    pivot.scale.setScalar(scale);
    pivot.position.copy(box.getCenter(new THREE.Vector3())).multiplyScalar(-scale);
    this.radius = size.length() * scale * 0.5;

    let vertices = 0;
    let triangles = 0;
    object.traverse((child) => {
      if (!child.isMesh) return;
      child.userData.material = child.material;
      const position = child.geometry.getAttribute('position');
      vertices += position.count;
      triangles += (child.geometry.index ? child.geometry.index.count : position.count) / 3;
    });

    this.model = pivot;
    this.scene.add(pivot);
    this.applyMaterials();
    this.resetView();
    return { vertices, triangles: Math.floor(triangles) };
  }

  applyMaterials() {
    if (!this.model) return;
    this.clayMaterial.wireframe = this.wireframe;
    this.model.traverse((child) => {
      if (!child.isMesh) return;
      child.material = this.clay ? this.clayMaterial : child.userData.material;
      child.material.wireframe = this.wireframe;
    });
    this.dirty = true;
  }

  resetView() {
    const distance = (this.radius / Math.sin(THREE.MathUtils.degToRad(this.camera.fov / 2))) * 1.05;
    this.camera.position.set(0.62, 0.42, 0.66).normalize().multiplyScalar(distance);
    this.camera.near = distance / 100;
    this.camera.far = distance * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.set(0, 0, 0);
    this.controls.minDistance = distance * 0.08;
    this.controls.maxDistance = distance * 6;
    this.controls.update();
    this.dirty = true;
  }

  setAutoRotate(on) {
    this.controls.autoRotate = on;
  }

  setWireframe(on) {
    this.wireframe = on;
    this.applyMaterials();
  }

  // the shape alone, without the generated colours
  setClay(on) {
    this.clay = on;
    this.applyMaterials();
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.resizer.disconnect();
    this.clear();
    this.controls.dispose();
    this.environment.dispose();
    this.clayMaterial.dispose();
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
