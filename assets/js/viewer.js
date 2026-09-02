/* ============================================================
   WorldSculpt — interactive compositional scene viewer
   Multi-instance: every element with class .ws-viewer becomes an
   independent viewer. Which scene list it shows is set by its
   data-scenes attribute (a key into window.WS_CONFIG).
   - Loads per-scene GLB files; falls back to a procedural
     placeholder scene when a GLB is missing, so the page is
     fully demoable before assets land
   - Object-level interaction: hover-highlight, click-isolate,
     explode-view slider, auto-rotate
   ============================================================ */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { DRACOLoader } from "three/addons/loaders/DRACOLoader.js";
import { DropInViewer } from "../vendor/gsplat/gaussian-splats-3d.module.js";

const dracoLoader = new DRACOLoader();
dracoLoader.setDecoderPath("assets/vendor/three/addons/libs/draco/gltf/");
const gltfLoader = new GLTFLoader();
gltfLoader.setDRACOLoader(dracoLoader);

document.querySelectorAll(".ws-viewer").forEach((el) => initWhenVisible(el));

function initWhenVisible(container) {
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) {
      io.disconnect();
      const kind = container.dataset.kind;
      new (kind === "dataset" ? DatasetViewer : kind === "marble" ? MarbleViewer : Viewer)(container);
    }
  }, { rootMargin: "300px" });
  io.observe(container);
}

/* -------------------- seeded RNG (per-scene deterministic placeholder) -------------------- */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

/* clay material with a distinct per-object base color (golden-angle hues) */
function clayMaterial(i) {
  const hue = (i * 137.508) % 360;
  const color = new THREE.Color().setHSL(hue / 360, 0.58, 0.62);
  return new THREE.MeshStandardMaterial({ color, roughness: 0.88, metalness: 0.0 });
}

class Viewer {
  constructor(container) {
    this.container = container;
    this.canvas = container.querySelector(".ws-canvas");
    this.tooltip = container.querySelector(".ws-tooltip");
    this.hudCount = container.querySelector(".hud-count");
    this.hudPh = container.querySelector(".hud-ph");
    this.loaderEl = container.querySelector(".ws-loader");

    this.objects = [];          // interactive meshes
    this.hovered = null;
    this.isolated = null;
    this.explodeT = 0;
    // dark opaque silhouette for non-isolated objects — deliberately NOT
    // wireframe/transparent: on multi-million-face scenes wireframe turns
    // every triangle into 3 blended lines and destroys the frame rate
    this.ghostMat = new THREE.MeshBasicMaterial({ color: 0x2a2c33 });
    this.hoverColor = new THREE.Color(0xffffff);

    this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.05, 500);

    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.06;
    this.controls.autoRotate = true;
    this.controls.autoRotateSpeed = 0.7;
    this.controls.maxPolarAngle = Math.PI * 0.55;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2(-10, -10);

    // clay-style lighting
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x3c3f48, 1.15));
    const keyLight = new THREE.DirectionalLight(0xffffff, 1.6);
    keyLight.position.set(3, 6, 4);
    this.scene.add(keyLight);
    const rim = new THREE.DirectionalLight(0x88aaff, 0.5);
    rim.position.set(-4, 3, -5);
    this.scene.add(rim);

    this.root = new THREE.Group();
    this.scene.add(this.root);

    this._bindUI();
    this._bindPointer();
    this._resize();
    window.addEventListener("resize", () => this._resize());

    const key = container.dataset.scenes || "scenes";
    const scenes = (window.WS_CONFIG && window.WS_CONFIG[key]) || [{ id: "demo", label: "Demo", glb: null }];
    this._buildTabs(scenes);
    this.loadScene(scenes[0]);

    this.renderer.setAnimationLoop(() => this._tick());
  }

  /* -------------------- loading overlay -------------------- */
  _loaderShow(label) {
    if (!this.loaderEl) return;
    this.loaderEl.classList.add("show");
    this.loaderEl.classList.remove("indeterminate");
    this.loaderEl.querySelector(".ws-loader-label").textContent = label || "Loading…";
    this.loaderEl.querySelector(".ws-loader-fill").style.width = "0%";
  }
  _loaderProgress(evt, name) {
    if (!this.loaderEl || !this.loaderEl.classList.contains("show")) return;
    const label = this.loaderEl.querySelector(".ws-loader-label");
    const mb = (b) => (b / 1048576).toFixed(1);
    if (evt.total > 0) {
      const f = Math.min(1, evt.loaded / evt.total);
      this.loaderEl.querySelector(".ws-loader-fill").style.width = (f * 100).toFixed(1) + "%";
      if (f >= 1) { // downloaded, now decoding (no events during parse)
        this.loaderEl.classList.add("indeterminate");
        label.textContent = "Decoding " + name + "…";
      } else {
        label.textContent = "Loading " + name + " — " + mb(evt.loaded) + " / " + mb(evt.total) + " MB";
      }
    } else {
      label.textContent = "Loading " + name + " — " + mb(evt.loaded) + " MB";
    }
  }
  _loaderHide() {
    if (this.loaderEl) this.loaderEl.classList.remove("show", "indeterminate");
  }

  /* -------------------- UI wiring (scoped to this container) -------------------- */
  _buildTabs(scenes) {
    const holder = this.container.querySelector(".scene-tabs");
    if (!holder) return;
    scenes.forEach((s, i) => {
      const b = document.createElement("button");
      b.className = "scene-tab" + (i === 0 ? " active" : "");
      b.textContent = s.label;
      b.addEventListener("click", () => {
        holder.querySelectorAll(".scene-tab").forEach((t) => t.classList.remove("active"));
        b.classList.add("active");
        this.loadScene(s);
      });
      holder.appendChild(b);
    });
  }

  _bindUI() {
    this.slider = this.container.querySelector(".explode");
    if (this.slider) this.slider.addEventListener("input", () => {
      this.explodeT = this.slider.value / 100;
      this._applyExplode();
    });

    const rot = this.container.querySelector(".btn-rotate");
    if (rot) {
      rot.classList.add("on");
      rot.addEventListener("click", () => {
        this.controls.autoRotate = !this.controls.autoRotate;
        rot.classList.toggle("on", this.controls.autoRotate);
      });
    }
    const reset = this.container.querySelector(".btn-reset");
    if (reset) reset.addEventListener("click", () => {
      this._clearIsolate();
      this.explodeT = 0;
      if (this.slider) this.slider.value = 0;
      this._applyExplode();
      this._frameScene(true);
    });
  }

  _bindPointer() {
    const rectPos = (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
      this._mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    this.canvas.addEventListener("pointermove", rectPos);
    this.canvas.addEventListener("pointerleave", () => { this.pointer.set(-10, -10); });
    let downAt = null;
    this.canvas.addEventListener("pointerdown", (e) => { downAt = [e.clientX, e.clientY]; });
    this.canvas.addEventListener("pointerup", (e) => {
      if (!downAt) return;
      const moved = Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]);
      downAt = null;
      if (moved > 6) return; // it was a drag, not a click
      rectPos(e);
      this._pick();
      if (this.hovered) this._isolate(this.hovered);
      else this._clearIsolate();
    });
  }

  /* -------------------- scene loading -------------------- */
  loadScene(cfg) {
    this.cfg = cfg;
    this._clearIsolate();
    this.hovered = null;
    this.explodeT = 0;
    if (this.slider) this.slider.value = 0;

    // dispose previous
    this.root.traverse((o) => {
      if (o.isMesh) {
        o.geometry.dispose();
        if (o.material !== this.ghostMat) o.material.dispose && o.material.dispose();
      }
    });
    this.root.clear();
    this.objects = [];

    const done = (isPlaceholder) => {
      this._loaderHide();
      if (this.hudPh) this.hudPh.style.display = isPlaceholder ? "" : "none";
      this._prepareObjects();
      this._frameScene(true);
      if (this.hudCount) this.hudCount.textContent = this.objects.length.toLocaleString("en-US") + " objects";
    };

    if (cfg.glb) {
      this._loaderShow("Loading " + (cfg.label || "scene") + "…");
      gltfLoader.load(
        cfg.glb,
        (gltf) => {
          gltf.scene.traverse((o) => {
            if (o.isMesh) {
              if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
              o.material = clayMaterial(this.objects.length); // per-object base color
              this.objects.push(o);
            }
          });
          this.root.add(gltf.scene);
          done(false);
        },
        (evt) => this._loaderProgress(evt, cfg.label || "scene"),
        () => { this._buildPlaceholder(cfg.id); done(true); } // missing file -> placeholder
      );
    } else {
      this._buildPlaceholder(cfg.id || "demo");
      done(true);
    }
  }

  /* -------------------- procedural placeholder scene -------------------- */
  _buildPlaceholder(seedStr) {
    const rnd = mulberry32(hashStr(seedStr));
    const mat = () => clayMaterial(this.objects.length);
    const add = (geo, x, y, z, ry, name) => {
      const m = new THREE.Mesh(geo, mat());
      m.position.set(x, y, z);
      m.rotation.y = ry;
      m.name = name;
      this.root.add(m);
      this.objects.push(m);
      return m;
    };

    // floor slab
    const floor = add(new THREE.BoxGeometry(16, 0.18, 12), 0, -0.09, 0, 0, "floor");

    let id = 1;
    // tables with clutter on top
    const nTables = 3 + Math.floor(rnd() * 2);
    for (let t = 0; t < nTables; t++) {
      const tx = (rnd() - 0.5) * 10, tz = (rnd() - 0.5) * 7;
      const tw = 2.2 + rnd() * 1.6, td = 1.2 + rnd() * 0.9, th = 0.9 + rnd() * 0.25;
      add(new THREE.BoxGeometry(tw, 0.09, td), tx, th, tz, 0, "table_" + id++);
      for (const [sx, sz] of [[-1, -1], [1, -1], [-1, 1], [1, 1]])
        add(new THREE.BoxGeometry(0.09, th, 0.09), tx + sx * (tw / 2 - 0.1), th / 2, tz + sz * (td / 2 - 0.1), 0, "leg_" + id++);
      // clutter on the table
      const n = 4 + Math.floor(rnd() * 5);
      for (let i = 0; i < n; i++) {
        const kind = rnd();
        const ox = tx + (rnd() - 0.5) * (tw - 0.5), oz = tz + (rnd() - 0.5) * (td - 0.4);
        const s = 0.12 + rnd() * 0.22;
        let g, oy = th + 0.045 + s;
        if (kind < 0.28) g = new THREE.BoxGeometry(s * 2, s * 2, s * 2);
        else if (kind < 0.52) g = new THREE.CylinderGeometry(s * 0.8, s * 0.8, s * 2.4, 20);
        else if (kind < 0.72) g = new THREE.ConeGeometry(s, s * 2.6, 20);
        else if (kind < 0.88) g = new THREE.SphereGeometry(s * 1.1, 20, 16);
        else { g = new THREE.TorusKnotGeometry(s * 0.9, s * 0.3, 60, 10); oy = th + 0.045 + s * 1.3; }
        add(g, ox, oy, oz, rnd() * Math.PI, "object_" + id++);
      }
    }
    // shelves against the "wall"
    const nSh = 2 + Math.floor(rnd() * 2);
    for (let sIdx = 0; sIdx < nSh; sIdx++) {
      const sx = (rnd() - 0.5) * 11, sz = -5 + rnd() * 0.8;
      for (let lvl = 0; lvl < 3; lvl++) {
        add(new THREE.BoxGeometry(2.4, 0.07, 0.8), sx, 0.5 + lvl * 0.72, sz, 0, "shelf_" + id++);
        const n = 2 + Math.floor(rnd() * 3);
        for (let i = 0; i < n; i++) {
          const s = 0.1 + rnd() * 0.16;
          const g = rnd() < 0.5
            ? new THREE.BoxGeometry(s * 1.6, s * 2.6, s * 1.2)
            : new THREE.CylinderGeometry(s * 0.7, s * 0.7, s * 2.4, 16);
          add(g, sx + (rnd() - 0.5) * 2, 0.5 + lvl * 0.72 + 0.035 + s * 1.3, sz + (rnd() - 0.5) * 0.4, rnd() * Math.PI, "item_" + id++);
        }
      }
    }
    // scattered floor objects
    const nFloor = 10 + Math.floor(rnd() * 8);
    for (let i = 0; i < nFloor; i++) {
      const s = 0.16 + rnd() * 0.34;
      const kind = rnd();
      let g, oy = s;
      if (kind < 0.3) g = new THREE.BoxGeometry(s * 2, s * 2, s * 2);
      else if (kind < 0.55) g = new THREE.CylinderGeometry(s, s, s * 2, 18);
      else if (kind < 0.75) { g = new THREE.IcosahedronGeometry(s, 0); oy = s * 0.9; }
      else if (kind < 0.9) g = new THREE.ConeGeometry(s, s * 2.2, 18);
      else { g = new THREE.TorusGeometry(s, s * 0.35, 14, 32); oy = s * 0.38; g.rotateX(Math.PI / 2); }
      add(g, (rnd() - 0.5) * 13, oy, (rnd() - 0.5) * 9, rnd() * Math.PI, "object_" + id++);
    }
    // a "statue" centerpiece
    add(new THREE.BoxGeometry(1, 0.5, 1), 0, 0.25, 0, 0, "pedestal");
    add(new THREE.CapsuleGeometry(0.32, 1.1, 6, 16), 0, 1.35, 0, 0, "statue");

    floor.userData.noExplode = true;
  }

  /* -------------------- object bookkeeping -------------------- */
  _prepareObjects() {
    // explode radially from the centroid of all object centers
    const center = new THREE.Vector3();
    const wp = new THREE.Vector3();
    let n = 0;
    for (const o of this.objects) {
      if (o.userData.noExplode) continue;
      o.getWorldPosition(wp);
      center.add(wp); n++;
    }
    if (n) center.divideScalar(n);

    const box = new THREE.Box3().setFromObject(this.root);
    this.sceneRadius = box.getSize(new THREE.Vector3()).length() * 0.5 || 1;

    for (const o of this.objects) {
      o.userData.homePos = o.position.clone();
      o.getWorldPosition(wp);
      const dir = wp.clone().sub(center);
      if (dir.lengthSq() < 1e-6) dir.set(0, 1, 0);
      dir.normalize();
      o.userData.explodeDir = dir;
      o.userData.baseMat = o.material;
    }
  }

  _applyExplode() {
    const d = this.explodeT * this.sceneRadius * 0.55;
    for (const o of this.objects) {
      if (!o.userData.homePos) continue;
      if (o.userData.noExplode) continue;
      o.position.copy(o.userData.homePos).addScaledVector(o.userData.explodeDir, d);
    }
  }

  /* -------------------- hover / isolate -------------------- */
  _pick() {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.objects, false);
    const hit = hits.length ? hits[0].object : null;
    if (hit !== this.hovered) {
      if (this.hovered) this._setHover(this.hovered, false);
      this.hovered = hit;
      if (hit) this._setHover(hit, true);
      this.canvas.style.cursor = hit ? "pointer" : "grab";
    }
  }

  _setHover(obj, on) {
    if (this.isolated && obj !== this.isolated && on) return;
    if (on) {
      if (!obj.userData.hoverMat) {
        obj.userData.hoverMat = new THREE.MeshStandardMaterial({
          color: this.hoverColor, emissive: this.hoverColor, emissiveIntensity: 0.55,
          metalness: 0.1, roughness: 0.35
        });
      }
      if (obj.material !== this.ghostMat) obj.material = obj.userData.hoverMat;
    } else {
      obj.material = (this.isolated && obj !== this.isolated) ? this.ghostMat : obj.userData.baseMat;
    }
  }

  _isolate(obj) {
    this.isolated = obj;
    for (const o of this.objects) o.material = o === obj ? o.userData.baseMat : this.ghostMat;
    if (this.hudCount) this.hudCount.textContent = "isolated: " + (obj.name || "object") + " — click background to show all";
  }

  _clearIsolate() {
    if (!this.isolated) return;
    this.isolated = null;
    for (const o of this.objects) o.material = o.userData.baseMat || o.material;
    if (this.hudCount) this.hudCount.textContent = this.objects.length.toLocaleString("en-US") + " objects";
  }

  /* -------------------- camera framing -------------------- */
  _frameScene() {
    const box = new THREE.Box3().setFromObject(this.root);
    const center = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3()).length();
    // camera distance = bbox diagonal x factor; per-scene cfg.dist overrides
    // the viewer default (Viewer 0.62, MarbleViewer 0.3 for interiors)
    const dist = size * ((this.cfg && this.cfg.dist) || this.distFactor || 0.62);
    this.controls.target.copy(center);
    // optional per-scene initial heading: cfg.yaw in degrees rotates the
    // start position horizontally around the scene center
    const yaw = ((this.cfg && this.cfg.yaw) || 0) * Math.PI / 180;
    const ox = dist * 0.72, oz = dist * 0.78;
    const rx = ox * Math.cos(yaw) + oz * Math.sin(yaw);
    const rz = -ox * Math.sin(yaw) + oz * Math.cos(yaw);
    this.camera.position.set(center.x + rx, center.y + dist * 0.5, center.z + rz);
    this.camera.near = size / 200;
    this.camera.far = size * 20;
    this.camera.updateProjectionMatrix();
    this.controls.update();
  }

  /* -------------------- loop -------------------- */
  _tick() {
    this.controls.update();
    this._pick();

    if (this.tooltip) {
      if (this.hovered && this._mouse && (!this.isolated || this.hovered === this.isolated)) {
        this.tooltip.style.display = "block";
        this.tooltip.style.left = this._mouse.x + "px";
        this.tooltip.style.top = this._mouse.y + "px";
        this.tooltip.textContent = this.hovered.name || "object";
      } else {
        this.tooltip.style.display = "none";
      }
    }
    this.renderer.render(this.scene, this.camera);
  }

  _resize() {
    const w = this.canvas.clientWidth, h = this.canvas.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }
}

/* ============================================================
   DatasetViewer — UE-MeshyScene benchmark explorer.
   Per-scene layers, each individually toggleable:
     mesh   ground-truth meshes (clay, per-object colors)
     boxes  oriented 3D bounding boxes
     cams   camera frusta + capture trajectory
     points colored point cloud sampled from the GT surfaces
   Scene config entries: { id, label, base } where files are
   `${base}_mesh.glb`, `${base}_extras.json`, `${base}_points.bin`.
   ============================================================ */
class DatasetViewer extends Viewer {

  _bindUI() {
    super._bindUI();
    this.layerState = { mesh: true, boxes: true, cams: true, points: true };
    this.container.querySelectorAll(".layer-toggle").forEach((btn) => {
      const layer = btn.dataset.layer;
      btn.classList.toggle("on", !!this.layerState[layer]);
      btn.addEventListener("click", () => {
        this.layerState[layer] = !this.layerState[layer];
        btn.classList.toggle("on", this.layerState[layer]);
        this._applyLayerState();
        if (layer === "points" && this.layerState.points) this._ensurePoints();
      });
    });
  }

  _applyLayerState() {
    if (!this.aux) return;
    if (this.meshRoot) this.meshRoot.visible = this.layerState.mesh;
    if (this.aux.boxes) this.aux.boxes.visible = this.layerState.boxes;
    if (this.aux.cams) this.aux.cams.visible = this.layerState.cams;
    if (this.aux.points) this.aux.points.visible = this.layerState.points;
  }

  loadScene(cfg) {
    this.cfg = cfg;
    this._clearIsolate();
    this.hovered = null;
    this.root.traverse((o) => {
      if ((o.isMesh || o.isLineSegments || o.isLine || o.isPoints) && o.geometry) {
        o.geometry.dispose();
        if (o.material && o.material !== this.ghostMat) o.material.dispose && o.material.dispose();
      }
    });
    this.root.clear();
    this.objects = [];
    this.aux = { boxes: null, cams: null, points: null };
    this.meshRoot = null;
    this.pointsUrl = cfg.base + "_points.bin";
    this.pointsLoaded = false;

    this._loaderShow("Loading " + (cfg.label || "scene") + "…");
    const meshP = new Promise((resolve) => {
      gltfLoader.load(cfg.base + "_mesh.glb", (gltf) => {
        gltf.scene.traverse((o) => {
          if (o.isMesh) {
            if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
            o.material = clayMaterial(this.objects.length);
            this.objects.push(o);
          }
        });
        this.meshRoot = gltf.scene;
        this.root.add(gltf.scene);
        resolve(true);
      }, (evt) => this._loaderProgress(evt, cfg.label || "scene"), () => resolve(false));
    });
    const extrasP = fetch(cfg.base + "_extras.json").then((r) => r.ok ? r.json() : null).catch(() => null);

    Promise.all([meshP, extrasP]).then(([meshOk, extras]) => {
      this._loaderHide();
      const phBadge = this.container.querySelector(".hud-ph");
      if (!meshOk) {
        this._buildPlaceholder(cfg.id || "ds");
        if (phBadge) phBadge.style.display = "";
      } else {
        if (phBadge) phBadge.style.display = "none";
      }
      if (extras) {
        this.aux.boxes = this._buildBoxes(extras);
        this.aux.cams = this._buildCameras(extras);
        this.root.add(this.aux.boxes, this.aux.cams);
      }
      this._applyLayerState();
      this._prepareObjects();
      this._frameScene(true);
      if (this.hudCount) {
        this.hudCount.textContent = this.objects.length.toLocaleString("en-US") + " objects" +
          (extras ? " · " + (extras.cams.length * (extras.stride || 1)).toLocaleString("en-US") + " views" : "");
      }
      if (this.layerState.points) this._ensurePoints();
    });
  }

  _buildBoxes(extras) {
    // unit cube edges
    const C = [[-.5,-.5,-.5],[.5,-.5,-.5],[.5,.5,-.5],[-.5,.5,-.5],[-.5,-.5,.5],[.5,-.5,.5],[.5,.5,.5],[-.5,.5,.5]];
    const E = [[0,1],[1,2],[2,3],[3,0],[4,5],[5,6],[6,7],[7,4],[0,4],[1,5],[2,6],[3,7]];
    const pos = new Float32Array(extras.boxes.length * 24 * 3);
    const col = new Float32Array(extras.boxes.length * 24 * 3);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), v = new THREE.Vector3(), s = new THREE.Vector3();
    const tmp = new THREE.Vector3(), cc = new THREE.Color();
    let w = 0;
    extras.boxes.forEach((b, i) => {
      q.set(b.q[0], b.q[1], b.q[2], b.q[3]);
      v.set(b.c[0], b.c[1], b.c[2]);
      s.set(Math.max(b.s[0], 1e-5), Math.max(b.s[1], 1e-5), Math.max(b.s[2], 1e-5));
      m.compose(v, q, s);
      cc.setHSL(((i * 137.508) % 360) / 360, 0.7, 0.72);
      for (const e of E) for (const idx of e) {
        tmp.set(C[idx][0], C[idx][1], C[idx][2]).applyMatrix4(m);
        pos[w] = tmp.x; col[w++] = cc.r;
        pos[w] = tmp.y; col[w++] = cc.g;
        pos[w] = tmp.z; col[w++] = cc.b;
      }
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    g.setAttribute("color", new THREE.BufferAttribute(col, 3));
    return new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.85
    }));
  }

  _buildCameras(extras) {
    const group = new THREE.Group();
    const d = 0.012; // frustum size, in normalized scene units
    const hw = d * Math.tan((extras.fovx || 1.2) / 2), hh = hw / (extras.aspect || 1.78);
    // frustum wireframe: apex -> 4 corners + far rectangle
    const cor = [[-hw,-hh,-d],[hw,-hh,-d],[hw,hh,-d],[-hw,hh,-d]];
    const segs = [];
    for (const c of cor) segs.push([0,0,0], c);
    for (let i = 0; i < 4; i++) { segs.push(cor[i], cor[(i+1)%4]); }
    segs.push(cor[3], [0, hh*1.6, -d]); segs.push([0, hh*1.6, -d], cor[2]); // "up" tick
    const drawCams = extras.cams.filter((_, i) => i % 8 === 0); // show every 8th frustum
    const n = drawCams.length;
    const pos = new Float32Array(n * segs.length * 3);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), one = new THREE.Vector3(1,1,1);
    const tmp = new THREE.Vector3();
    let w = 0;
    for (const cam of drawCams) {
      q.set(cam.q[0], cam.q[1], cam.q[2], cam.q[3]);
      p.set(cam.p[0], cam.p[1], cam.p[2]);
      m.compose(p, q, one);
      for (const sgm of segs) {
        tmp.set(sgm[0], sgm[1], sgm[2]).applyMatrix4(m);
        pos[w++] = tmp.x; pos[w++] = tmp.y; pos[w++] = tmp.z;
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    group.add(new THREE.LineSegments(g, new THREE.LineBasicMaterial({
      color: 0xb9bdc6, transparent: true, opacity: 0.55
    })));
    // trajectory line through camera centers (full set, keeps the path smooth)
    const tp = new Float32Array(extras.cams.length * 3);
    extras.cams.forEach((cam, i) => { tp[i*3] = cam.p[0]; tp[i*3+1] = cam.p[1]; tp[i*3+2] = cam.p[2]; });
    const tg = new THREE.BufferGeometry();
    tg.setAttribute("position", new THREE.BufferAttribute(tp, 3));
    group.add(new THREE.Line(tg, new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.6
    })));
    return group;
  }

  _ensurePoints() {
    if (this.pointsLoaded || !this.pointsUrl) return;
    this.pointsLoaded = true;
    const url = this.pointsUrl;
    fetch(url).then((r) => r.ok ? r.arrayBuffer() : null).then((buf) => {
      if (!buf || url !== this.pointsUrl) return; // scene switched meanwhile
      const count = new DataView(buf).getUint32(0, true);
      const pos = new Float32Array(buf, 4, count * 3);
      const col = new Uint8Array(buf, 4 + count * 12, count * 3);
      const g = new THREE.BufferGeometry();
      g.setAttribute("position", new THREE.BufferAttribute(pos, 3));
      g.setAttribute("color", new THREE.BufferAttribute(col, 3, true));
      const pts = new THREE.Points(g, new THREE.PointsMaterial({
        vertexColors: true, size: (this.sceneRadius || 1) * 0.0035, sizeAttenuation: true
      }));
      this.aux.points = pts;
      this.root.add(pts);
      this._applyLayerState();
    }).catch(() => {});
  }
}

/* ============================================================
   MarbleViewer — WorldSculpt on generated 3DGS worlds (Marble).
   Two layers: the source 3D Gaussian Splatting scene (.splat,
   rendered via gaussian-splats-3d) and the reconstructed
   per-part meshes (.glb). Mesh interactions (hover / isolate /
   explode) work as usual; the splat layer is display-only.
   Scene config entries: { id, label, base } where files are
   `${base}.glb` and `${base}.splat`.
   ============================================================ */
class MarbleViewer extends Viewer {

  /* Split-screen: one canvas, one camera, two scissored render passes —
     3DGS on the left half, part meshes on the right half. The shared
     camera keeps both views perfectly synchronized. */

  _bindUI() {
    super._bindUI();
    this.distFactor = 0.1; // interiors: start much closer than the outdoor scenes
    // draggable wipe divider
    this.split = 0.5;
    const div = this.container.querySelector(".duo-divider");
    this.dividerEl = div;
    if (div) {
      let dragging = false;
      div.addEventListener("pointerdown", (e) => { dragging = true; div.setPointerCapture(e.pointerId); e.preventDefault(); });
      div.addEventListener("pointermove", (e) => {
        if (!dragging) return;
        const r = this.canvas.getBoundingClientRect();
        this.split = Math.min(0.92, Math.max(0.08, (e.clientX - r.left) / r.width));
        div.style.left = (this.split * 100).toFixed(2) + "%";
      });
      const stop = () => { dragging = false; };
      div.addEventListener("pointerup", stop);
      div.addEventListener("pointercancel", stop);
    }
  }

  _applyLayerState() { /* split view: per-pass visibility handled in _tick */ }

  /* both passes share the full-canvas camera (a true "wipe"), so picking
     uses normal NDC — but only where the mesh side is actually visible */
  _pick() {
    if (this.pointer.x < this.split * 2 - 1) { // pointer on the splat side
      if (this.hovered) { this._setHover(this.hovered, false); this.hovered = null; this.canvas.style.cursor = "grab"; }
      return;
    }
    super._pick();
  }

  _tick() {
    this.controls.update();
    this._pick();
    if (this.tooltip) {
      if (this.hovered && this._mouse && (!this.isolated || this.hovered === this.isolated)) {
        this.tooltip.style.display = "block";
        this.tooltip.style.left = this._mouse.x + "px";
        this.tooltip.style.top = this._mouse.y + "px";
        this.tooltip.textContent = this.hovered.name || "object";
      } else {
        this.tooltip.style.display = "none";
      }
    }
    const size = this.renderer.getSize(new THREE.Vector2());
    const splitPx = Math.round(size.x * this.split);
    this.renderer.setViewport(0, 0, size.x, size.y); // full frame for both passes
    this.renderer.setScissorTest(true);
    // left of the divider: 3DGS
    if (this.splatViewer) {
      this.splatViewer.visible = true;
      this.root.visible = false;
      this.renderer.setScissor(0, 0, splitPx, size.y);
      this.renderer.render(this.scene, this.camera);
      this.splatViewer.visible = false;
    }
    // right of the divider: part meshes
    this.root.visible = true;
    if (this.meshRoot) this.meshRoot.visible = true;
    this.renderer.setScissor(splitPx, 0, size.x - splitPx, size.y);
    this.renderer.render(this.scene, this.camera);
    this.renderer.setScissorTest(false);
  }

  loadScene(cfg) {
    this.cfg = cfg;
    this._clearIsolate();
    this.hovered = null;
    this.explodeT = 0;
    if (this.slider) this.slider.value = 0;

    // dispose previous meshes
    this.root.traverse((o) => {
      if (o.isMesh && o.geometry) {
        o.geometry.dispose();
        if (o.material && o.material !== this.ghostMat) o.material.dispose && o.material.dispose();
      }
    });
    this.root.clear();
    this.objects = [];
    this.meshRoot = null;

    // dispose previous splat viewer
    if (this.splatViewer) {
      const old = this.splatViewer;
      this.splatViewer = null;
      this.scene.remove(old);
      try { old.viewer.dispose(); } catch (e) { /* mid-load dispose can throw; ignore */ }
    }

    this._loaderShow("Loading " + (cfg.label || "scene") + "…");

    // part meshes
    gltfLoader.load(
      cfg.base + ".glb",
      (gltf) => {
        gltf.scene.traverse((o) => {
          if (o.isMesh) {
            if (!o.geometry.attributes.normal) o.geometry.computeVertexNormals();
            o.material = clayMaterial(this.objects.length);
            this.objects.push(o);
          }
        });
        this.meshRoot = gltf.scene;
        this.root.add(gltf.scene);
        this._prepareObjects();
        this._frameScene(true);
        if (this.hudCount) this.hudCount.textContent = this.objects.length + " part meshes · 400k gaussians";
        this._applyLayerState();
      },
      undefined,
      () => { this._loaderHide(); }
    );

    // 3DGS scene
    const dv = new DropInViewer({ sharedMemoryForWorkers: false });
    this.splatViewer = dv;
    this.scene.add(dv);
    dv.addSplatScene(cfg.base + ".splat", {
      showLoadingUI: false,
      splatAlphaRemovalThreshold: 5,
      progressiveLoad: false,
      onProgress: (pct) => {
        if (dv !== this.splatViewer || !this.loaderEl || !this.loaderEl.classList.contains("show")) return;
        const label = this.loaderEl.querySelector(".ws-loader-label");
        this.loaderEl.querySelector(".ws-loader-fill").style.width = pct.toFixed(1) + "%";
        if (pct >= 100) {
          this.loaderEl.classList.add("indeterminate");
          label.textContent = "Preparing gaussians…";
        } else {
          label.textContent = "Loading " + (cfg.label || "scene") + " — " + pct.toFixed(0) + "%";
        }
      }
    }).then(() => {
      if (dv !== this.splatViewer) return;
      this._loaderHide();
      this._applyLayerState();
    }).catch(() => { if (dv === this.splatViewer) this._loaderHide(); });
  }
}
