// "Complexity, made operational." — particle lattice behind the hero and #approach.
// Loaded lazily from index.html. three.js is fetched only when hardware-accelerated WebGL2
// is available; otherwise (no WebGL, software rendering) a static frame of the final lattice
// is drawn with Canvas 2D. prefers-reduced-motion also gets a single static frame.

const INK = [241 / 255, 241 / 255, 236 / 255]; // --ink  #f1f1ec
const LIME = [200 / 255, 240 / 255, 0];        // --lime #c8f000
const ACCENT_RATIO = 0.04;                     // ≤5% of particles in the brand accent
const DPR_CAP = 1.5;
const MORPH_MS = 2500;
const FOV = 40;
const CAM_Z = 5;
const VIEW_H = 2 * CAM_Z * Math.tan((FOV * Math.PI) / 360); // world units across the canvas height at z = 0

const VERTEX = /* glsl */ `
  attribute vec3 aNoise;
  attribute float aSeed;
  attribute float aAccent;
  uniform float uProgress;
  uniform float uTime;
  uniform float uJitter;
  uniform float uSize;
  uniform float uPixelRatio;
  varying float vAccent;
  varying float vSettled;
  void main() {
    float t = clamp(uProgress * 1.35 - aSeed * 0.35, 0.0, 1.0);
    t = t * t * (3.0 - 2.0 * t);
    vec3 p = mix(aNoise, position, t);
    vec3 w = sin(vec3(uTime * 0.55, uTime * 0.47, uTime * 0.61) + aSeed * vec3(41.0, 57.0, 73.0));
    p += w * (0.01 + uJitter);
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uSize * uPixelRatio * (1.0 + aAccent * 0.5) * (${CAM_Z.toFixed(1)} / -mv.z);
    vAccent = aAccent;
    vSettled = t;
  }
`;

const FRAGMENT = /* glsl */ `
  uniform vec3 uInk;
  uniform vec3 uLime;
  uniform float uOpacity;
  uniform float uAccentOpacity;
  varying float vAccent;
  varying float vSettled;
  void main() {
    float d = length(gl_PointCoord - 0.5);
    if (d > 0.5) discard;
    float edge = smoothstep(0.5, 0.12, d);
    float o = mix(uOpacity, uAccentOpacity, vAccent) * mix(0.55, 1.0, vSettled);
    gl_FragColor = vec4(mix(uInk, uLime, vAccent), edge * o);
  }
`;

// Deterministic PRNG so the lattice, cloud and accent picks are identical on every load.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Lattice spans are normalised so the x span is 1; placement() scales it to pixels.
function buildParticles(target, seed, spans) {
  const [sx, sy, sz] = spans;
  const k = Math.cbrt(target / (sx * sy * sz));
  const nx = Math.max(2, Math.round(sx * k));
  const ny = Math.max(2, Math.round(sy * k));
  const nz = Math.max(2, Math.round(target / (nx * ny)));
  const count = nx * ny * nz;
  const rand = mulberry32(seed);
  const lattice = new Float32Array(count * 3);
  const noise = new Float32Array(count * 3);
  const seeds = new Float32Array(count);
  const accent = new Float32Array(count);
  const gauss = () => Math.sqrt(-2 * Math.log(rand() || 1e-6)) * Math.cos(2 * Math.PI * rand());
  let i = 0;
  for (let x = 0; x < nx; x++) {
    for (let y = 0; y < ny; y++) {
      for (let z = 0; z < nz; z++, i++) {
        lattice[i * 3] = (x / (nx - 1) - 0.5) * sx;
        lattice[i * 3 + 1] = (y / (ny - 1) - 0.5) * sy;
        lattice[i * 3 + 2] = (z / (nz - 1) - 0.5) * sz;
        noise[i * 3] = gauss() * (sx * 0.55 + 0.15);
        noise[i * 3 + 1] = gauss() * (sy * 0.45 + 0.1);
        noise[i * 3 + 2] = gauss() * (sz * 0.5 + 0.15);
        seeds[i] = rand();
        accent[i] = rand() < ACCENT_RATIO ? 1 : 0;
      }
    }
  }
  return { count, lattice, noise, seeds, accent };
}

function sectionProgress(el) {
  const r = el.getBoundingClientRect();
  const vh = window.innerHeight || 1;
  return Math.min(1, Math.max(0, (vh - r.top) / (r.height + vh)));
}

// Scattered → structured → locked, matching Frame / Build / Embed.
const STAGES = [
  { progress: 0, jitter: 0, lock: 0 },
  { progress: 1, jitter: 0.02, lock: 0 },
  { progress: 1, jitter: 0, lock: 1 },
];
const stageFor = p => (p < 0.3 ? 0 : p < 0.5 ? 1 : 2);
const easeInOutCubic = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

function createCanvas(section) {
  const canvas = document.createElement('canvas');
  canvas.className = 'fx-canvas';
  canvas.setAttribute('aria-hidden', 'true');
  section.insertBefore(canvas, section.firstChild);
  return canvas;
}

function sizeOf(el) {
  return { w: Math.max(1, el.clientWidth), h: Math.max(1, el.clientHeight) };
}

// Where the lattice sits in the section (px) and how wide its x span is drawn (px).
const LAYOUTS = {
  hero: (w, h) => (w > 980
    ? { cx: w * 0.73, cy: h * 0.5, size: Math.min(h * 0.62, w * 0.3) }
    : { cx: w * 0.5, cy: Math.min(h * 0.5, 400), size: Math.min(w * 0.82, 440) }),
  stages: (w, h) => ({ cx: w * 0.5, cy: h * 0.52, size: Math.min(w * 0.84, h * 1.9) }),
};

// Convert a pixel layout into group scale and position for a canvas of w × h.
function placement(mode, w, h) {
  const { cx, cy, size } = LAYOUTS[mode](w, h);
  const unit = VIEW_H / h;
  return { scale: size * unit, x: (cx - w / 2) * unit, y: -(cy - h / 2) * unit };
}

// The hero is a cube; #approach is a shallow slab shaped to its section.
function spansFor(mode, section) {
  if (mode === 'hero') return [1, 1, 1];
  const { w, h } = sizeOf(section);
  return [1, Math.min(2.5, Math.max(0.3, h / w)) * 0.9, 0.08];
}

class GLView {
  constructor(THREE, section, { target, seed, mode, size, opacity, tilt }) {
    this.section = section;
    this.mode = mode;
    this.tilt = tilt;
    this.opacity = opacity;
    this.canvas = createCanvas(section);
    try {
      this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, alpha: true, antialias: false, powerPreference: 'low-power', failIfMajorPerformanceCaveat: true });
    } catch (e) {
      this.canvas.remove();
      throw e;
    }
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_CAP));
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 50);
    this.camera.position.z = CAM_Z;

    const p = buildParticles(target, seed, spansFor(mode, section));
    this.geometry = new THREE.BufferGeometry();
    this.geometry.setAttribute('position', new THREE.BufferAttribute(p.lattice, 3));
    this.geometry.setAttribute('aNoise', new THREE.BufferAttribute(p.noise, 3));
    this.geometry.setAttribute('aSeed', new THREE.BufferAttribute(p.seeds, 1));
    this.geometry.setAttribute('aAccent', new THREE.BufferAttribute(p.accent, 1));
    this.material = new THREE.ShaderMaterial({
      vertexShader: VERTEX,
      fragmentShader: FRAGMENT,
      transparent: true,
      depthWrite: false,
      uniforms: {
        uProgress: { value: 0 }, uTime: { value: 0 }, uJitter: { value: 0 },
        uSize: { value: size }, uPixelRatio: { value: this.renderer.getPixelRatio() },
        uInk: { value: new THREE.Color().setRGB(...INK) }, uLime: { value: new THREE.Color().setRGB(...LIME) },
        uOpacity: { value: opacity }, uAccentOpacity: { value: 0.7 },
      },
    });
    this.group = new THREE.Group();
    this.group.add(new THREE.Points(this.geometry, this.material));
    this.group.rotation.set(tilt[0], tilt[1], 0);
    this.scene.add(this.group);

    this.state = { progress: 0, jitter: 0, lock: 0, spin: 0 };
    this.start = 0;
    this.lost = false;
    this.onLost = e => { e.preventDefault(); this.lost = true; };
    this.onRestored = () => { this.lost = false; this.renderFrame(performance.now(), 0); };
    this.canvas.addEventListener('webglcontextlost', this.onLost);
    this.canvas.addEventListener('webglcontextrestored', this.onRestored);
    this.resize();
  }

  resize() {
    const { w, h } = sizeOf(this.canvas);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, DPR_CAP));
    this.material.uniforms.uPixelRatio.value = this.renderer.getPixelRatio();
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const { scale, x, y } = placement(this.mode, w, h);
    this.group.scale.setScalar(scale);
    this.group.position.set(x, y, 0);
  }

  // Final lattice, no motion — used for prefers-reduced-motion.
  renderStatic() {
    const u = this.material.uniforms;
    u.uProgress.value = 1; u.uJitter.value = 0; u.uTime.value = 0;
    u.uOpacity.value = this.opacity * (this.mode === 'stages' ? 1.5 : 1);
    this.group.rotation.y = this.tilt[1];
    if (!this.lost) this.renderer.render(this.scene, this.camera);
  }

  renderFrame(now, dt) {
    if (this.lost) return;
    const u = this.material.uniforms;
    const s = this.state;
    if (this.mode === 'hero') {
      if (!this.start) this.start = now;
      s.progress = easeInOutCubic(Math.min(1, (now - this.start) / MORPH_MS));
      s.spin += dt * 0.025;
    } else {
      const target = STAGES[stageFor(sectionProgress(this.section))];
      const k = 1 - Math.exp(-dt / 0.45);
      s.progress += (target.progress - s.progress) * k;
      s.jitter += (target.jitter - s.jitter) * k;
      s.lock += (target.lock - s.lock) * k;
      s.spin += dt * 0.35;
    }
    u.uProgress.value = s.progress;
    u.uJitter.value = s.jitter;
    u.uTime.value = now / 1000;
    u.uOpacity.value = this.opacity * (1 + 0.5 * s.lock);
    u.uAccentOpacity.value = 0.7 + 0.25 * s.lock;
    // Hero drifts continuously; the #approach slab sways and comes to rest when locked.
    this.group.rotation.y = this.tilt[1] + (this.mode === 'hero' ? s.spin : 0.12 * Math.sin(s.spin) * (1 - s.lock));
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    this.canvas.removeEventListener('webglcontextlost', this.onLost);
    this.canvas.removeEventListener('webglcontextrestored', this.onRestored);
    this.geometry.dispose();
    this.material.dispose();
    this.renderer.dispose();
    this.renderer.forceContextLoss();
    this.canvas.remove();
  }
}

// Canvas 2D fallback when WebGL2 is unavailable: one static frame of the final lattice,
// projected with the same camera and rotation as the WebGL view.
class StaticView {
  constructor(section, { target, seed, mode, size, opacity, tilt }) {
    this.section = section;
    this.mode = mode;
    this.tilt = tilt;
    this.canvas = createCanvas(section);
    this.particles = buildParticles(target, seed, spansFor(mode, section));
    this.size = size;
    this.opacity = opacity;
  }

  resize() {
    const { w, h } = sizeOf(this.canvas);
    const dpr = Math.min(window.devicePixelRatio || 1, DPR_CAP);
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
    this.dpr = dpr;
  }

  renderStatic() {
    const ctx = this.canvas.getContext('2d');
    if (!ctx) return;
    const { width: W, height: H } = this.canvas;
    const { count, lattice, accent } = this.particles;
    const f = 1 / Math.tan((FOV * Math.PI) / 360);
    const aspect = W / H;
    const [tx, ty] = this.tilt;
    const cx = Math.cos(tx), sx = Math.sin(tx), cy = Math.cos(ty), sy = Math.sin(ty);
    const { scale, x: ox, y: oy } = placement(this.mode, W / this.dpr, H / this.dpr);
    const ink = INK.map(c => Math.round(c * 255)).join(',');
    const lime = LIME.map(c => Math.round(c * 255)).join(',');
    const inkOpacity = this.opacity * (this.mode === 'stages' ? 1.5 : 1); // locked stage
    const paths = [new Path2D(), new Path2D()]; // [ink, accent] — two fills instead of one per particle
    ctx.clearRect(0, 0, W, H);
    for (let i = 0; i < count; i++) {
      const x = lattice[i * 3] * scale, y = lattice[i * 3 + 1] * scale, z = lattice[i * 3 + 2] * scale;
      const x1 = cy * x + sy * z, z1 = -sy * x + cy * z;     // rotate Y
      const y2 = cx * y - sx * z1, z2 = sx * y + cx * z1;    // rotate X
      const depth = CAM_Z - z2;
      const px = ((x1 + ox) * f / aspect / depth + 1) * 0.5 * W;
      const py = (1 - ((y2 + oy) * f) / depth) * 0.5 * H;
      const a = accent[i];
      const r = (this.size * this.dpr * (1 + a * 0.5) * (CAM_Z / depth)) * 0.32;
      paths[a].moveTo(px + r, py);
      paths[a].arc(px, py, r, 0, Math.PI * 2);
    }
    ctx.fillStyle = `rgba(${ink},${inkOpacity})`;
    ctx.fill(paths[0]);
    ctx.fillStyle = `rgba(${lime},0.7)`;
    ctx.fill(paths[1]);
  }

  renderFrame() {}

  dispose() { this.canvas.remove(); }
}

// Software-rendered WebGL (e.g. SwiftShader on GPU-less machines) is treated as unavailable:
// a continuous particle loop on the CPU costs far more than it is worth.
function supportsWebGL2() {
  try {
    const gl = document.createElement('canvas').getContext('webgl2', { failIfMajorPerformanceCaveat: true });
    if (!gl) return false;
    // Firefox reports the real renderer via RENDERER; Chrome and Safari need the debug extension.
    let renderer = String(gl.getParameter(gl.RENDERER) || '');
    if (/^webkit webgl$/i.test(renderer)) {
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      if (info) renderer = String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL));
    }
    return !/swiftshader|llvmpipe|softpipe|software|basic render/i.test(renderer);
  } catch (e) {
    return false;
  }
}

// Split start-up work into separate tasks so it doesn't block input as one long task.
const yieldToMain = () => new Promise(resolve => setTimeout(resolve, 0));

let current = null;

export function mount() {
  if (current) return current;
  const hero = document.getElementById('top');
  const approach = document.getElementById('approach');
  if (!hero) return null;

  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const small = window.matchMedia('(max-width: 760px), (pointer: coarse)').matches;
  const configs = [
    { section: hero, mode: 'hero', target: small ? 1200 : 3000, seed: 7, size: 2.4, opacity: 0.26, tilt: [0.42, -0.62] },
    approach && { section: approach, mode: 'stages', target: small ? 800 : 1800, seed: 11, size: 2.8, opacity: 0.24, tilt: [1.0, -0.12] },
  ].filter(Boolean);

  const views = new Map();
  const visible = new Set();
  let destroyed = false;
  let raf = 0;
  let last = 0;
  let THREE = null;

  const animating = () => !reduced && THREE && !document.hidden && visible.size > 0;

  const frame = now => {
    raf = 0;
    if (!animating()) return;
    const dt = last ? Math.min(0.1, (now - last) / 1000) : 0;
    last = now;
    visible.forEach(section => { const v = views.get(section); if (v) v.renderFrame(now, dt); });
    raf = requestAnimationFrame(frame);
  };
  const play = () => { if (!raf && animating()) { last = 0; raf = requestAnimationFrame(frame); } };
  const pause = () => { if (raf) cancelAnimationFrame(raf); raf = 0; };

  const ensureView = cfg => {
    if (views.has(cfg.section) || destroyed) return views.get(cfg.section);
    let view;
    try {
      view = THREE ? new GLView(THREE, cfg.section, cfg) : new StaticView(cfg.section, cfg);
    } catch (e) {
      view = new StaticView(cfg.section, cfg);
    }
    // ResizeObserver's first callback sizes and draws the view; without it, do that now.
    if (!resizeObserver) {
      view.resize();
      if (reduced || view instanceof StaticView) view.renderStatic();
    }
    requestAnimationFrame(() => view.canvas.classList.add('ready'));
    views.set(cfg.section, view);
    resizeObserver && resizeObserver.observe(cfg.section);
    return view;
  };

  const resizeObserver = 'ResizeObserver' in window ? new ResizeObserver(entries => {
    entries.forEach(entry => {
      const v = views.get(entry.target);
      if (!v) return;
      v.resize();
      if (reduced || v instanceof StaticView) v.renderStatic();
    });
  }) : null;

  // Build the #approach view shortly before it scrolls in; render only while a section is on screen.
  const nearIO = new IntersectionObserver(entries => {
    entries.forEach(entry => { if (entry.isIntersecting) ensureView(configs.find(c => c.section === entry.target)); });
  }, { rootMargin: '200px 0px' });
  const io = new IntersectionObserver(entries => {
    entries.forEach(entry => {
      // intersectionRatio, not isIntersecting: a section merely touching the viewport edge is not visible.
      if (entry.intersectionRatio > 0) { ensureView(configs.find(c => c.section === entry.target)); visible.add(entry.target); } else visible.delete(entry.target);
    });
    animating() ? play() : pause();
  });

  const onVisibility = () => (document.hidden ? pause() : play());

  const init = async () => {
    const accelerated = supportsWebGL2();
    await yieldToMain();
    if (accelerated) {
      try {
        THREE = await import('../vendor/three/three.subset.min.js');
      } catch (e) {
        THREE = null;
      }
    }
    if (destroyed) return;
    ensureView(configs[0]);
    configs.forEach(c => { nearIO.observe(c.section); io.observe(c.section); });
    document.addEventListener('visibilitychange', onVisibility);
  };
  init();

  current = {
    destroy() {
      destroyed = true;
      pause();
      io.disconnect();
      nearIO.disconnect();
      resizeObserver && resizeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      views.forEach(v => v.dispose());
      views.clear();
      visible.clear();
      current = null;
    },
  };
  return current;
}

// Unmount on page teardown; rebuild if the page is restored from the back/forward cache.
window.addEventListener('pagehide', () => { if (current) current.destroy(); });
window.addEventListener('pageshow', e => { if (e.persisted) mount(); });
