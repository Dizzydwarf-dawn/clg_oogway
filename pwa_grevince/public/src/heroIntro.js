import * as THREE from 'three';
import { LAYERS, ROOMS, CONDUITS } from './campusData.js';

/**
 * Monotone Cubic Hermite Spline (Fritsch-Carlson C1 continuity)
 * Ported directly from JADE_PALACE CinematicIntro.tsx
 */
function createSmoothTrack(keys) {
  const n = keys.length;
  const t = keys.map((k) => k[0]);
  const v = keys.map((k) => k[1]);
  const d = new Float64Array(n - 1);
  const m = new Float64Array(n);

  for (let i = 0; i < n - 1; i++) {
    const dt = t[i + 1] - t[i];
    d[i] = dt > 1e-6 ? (v[i + 1] - v[i]) / dt : 0;
  }

  m[0] = d[0];
  m[n - 1] = d[n - 2];
  for (let i = 1; i < n - 1; i++) {
    m[i] = d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) * 0.5;
  }

  for (let i = 0; i < n - 1; i++) {
    if (Math.abs(d[i]) < 1e-7) {
      m[i] = 0;
      m[i + 1] = 0;
    } else {
      const a = m[i] / d[i];
      const b = m[i + 1] / d[i];
      const sumSq = a * a + b * b;
      if (sumSq > 9) {
        const tau = 3 / Math.sqrt(sumSq);
        m[i] = tau * a * d[i];
        m[i + 1] = tau * b * d[i];
      }
    }
  }

  return function evalAt(x) {
    if (x <= t[0]) return v[0];
    if (x >= t[n - 1]) return v[n - 1];
    let lo = 0;
    let hi = n - 2;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (x < t[mid]) hi = mid - 1;
      else if (x > t[mid + 1]) lo = mid + 1;
      else {
        lo = mid;
        break;
      }
    }
    const i = lo;
    const h = t[i + 1] - t[i];
    const u = (x - t[i]) / h;
    const u2 = u * u;
    const u3 = u2 * u;
    return (
      (2 * u3 - 3 * u2 + 1) * v[i] +
      (u3 - 2 * u2 + u) * h * m[i] +
      (-2 * u3 + 3 * u2) * v[i + 1] +
      (u3 - u2) * h * m[i + 1]
    );
  };
}

/**
 * OMNIS-X Hero Cinematic Intro Controller
 * Plays the 7.5s 3D campus flythrough, core pulse convergence, radial flash,
 * and blur-to-sharp OMNIS-X hero reveal before entering the 3D Twin.
 */
export class HeroIntro {
  constructor(overlayEl, { onEnter } = {}) {
    this.overlayEl = overlayEl;
    this.onEnter = onEnter;
    this.canvasHost = overlayEl.querySelector('#hero-canvas-host');
    this.flashEl = overlayEl.querySelector('#hero-flash');
    this.contentEl = overlayEl.querySelector('#hero-content');

    this._rafId = null;
    this._disposed = false;
    this._flashTimer = null;
    this._revealTimer = null;

    this._setupScene();
    this._bindControls();
    this.replay();
  }

  _setupScene() {
    let width = window.innerWidth;
    let height = window.innerHeight;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e0f12);
    this.scene.fog = new THREE.FogExp2(0x0e0f12, 0.012);

    this.camera = new THREE.PerspectiveCamera(42, width / height, 0.1, 160);
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setSize(width, height);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.2;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    this.canvasHost.innerHTML = '';
    this.canvasHost.appendChild(this.renderer.domElement);

    // Lighting Rig
    this.scene.add(new THREE.HemisphereLight(0x9d8eb5, 0x0e0f12, 0.85));
    const rimTopLeft = new THREE.DirectionalLight(0xeef6ff, 2.8);
    rimTopLeft.position.set(-20, 25, -15);
    this.scene.add(rimTopLeft);

    const rimGold = new THREE.DirectionalLight(0xf5d061, 2.2);
    rimGold.position.set(20, -10, -15);
    this.scene.add(rimGold);

    const keyLight = new THREE.DirectionalLight(0xe2e8f0, 1.4);
    keyLight.position.set(10, 20, 25);
    this.scene.add(keyLight);

    this.coreLight = new THREE.PointLight(0xd4af37, 0, 35, 1.8);
    this.coreLight.position.set(0, 5, 0);
    this.scene.add(this.coreLight);

    // Stardust Particle System (280 drifting Gold/Dusty Purple/White particles)
    const particleCount = 280;
    this.particleCount = particleCount;
    this.particleGeo = new THREE.BufferGeometry();
    const positions = new Float32Array(particleCount * 3);
    const colors = new Float32Array(particleCount * 3);
    this.speeds = new Float32Array(particleCount * 3);

    const goldCol = new THREE.Color(0xd4af37);
    const purpleCol = new THREE.Color(0x9d8eb5);
    const whiteCol = new THREE.Color(0xffffff);

    for (let i = 0; i < particleCount; i++) {
      positions[i * 3 + 0] = (Math.random() - 0.5) * 60;
      positions[i * 3 + 1] = Math.random() * 25 - 2;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 60;

      this.speeds[i * 3 + 0] = (Math.random() - 0.5) * 0.4;
      this.speeds[i * 3 + 1] = (Math.random() - 0.5) * 0.3 + 0.1;
      this.speeds[i * 3 + 2] = (Math.random() - 0.5) * 0.4;

      const pick = Math.random();
      const col = pick < 0.45 ? goldCol : pick < 0.8 ? purpleCol : whiteCol;
      colors[i * 3 + 0] = col.r;
      colors[i * 3 + 1] = col.g;
      colors[i * 3 + 2] = col.b;
    }
    this.particleGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this.particleGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));

    this.particleMat = new THREE.PointsMaterial({
      size: 0.28,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
    });
    this.scene.add(new THREE.Points(this.particleGeo, this.particleMat));

    // Campus 3D Assembly
    this.campusGroup = new THREE.Group();
    this.scene.add(this.campusGroup);

    LAYERS.forEach((layer, idx) => {
      const slabMesh = new THREE.Mesh(
        new THREE.BoxGeometry(34, 0.25, 19),
        new THREE.MeshBasicMaterial({
          color: 0x14151a,
          transparent: true,
          opacity: 0.45,
          side: THREE.DoubleSide,
        })
      );
      slabMesh.position.set(0, layer.elevationY + 0.125, 0);
      this.campusGroup.add(slabMesh);

      const slabEdges = new THREE.LineSegments(
        new THREE.EdgesGeometry(new THREE.BoxGeometry(34, 0.25, 19)),
        new THREE.LineBasicMaterial({
          color: idx === 0 ? 0xd4af37 : 0x9d8eb5,
          transparent: true,
          opacity: 0.75,
        })
      );
      slabEdges.position.copy(slabMesh.position);
      this.campusGroup.add(slabEdges);
    });

    [-15, -7.5, 0, 7.5, 15].forEach((cx) => {
      [-8, 0, 8].forEach((cz) => {
        const colMesh = new THREE.LineSegments(
          new THREE.EdgesGeometry(new THREE.BoxGeometry(0.35, 12.5, 0.35)),
          new THREE.LineBasicMaterial({ color: 0x5a5565, transparent: true, opacity: 0.4 })
        );
        colMesh.position.set(cx, 6.25, cz);
        this.campusGroup.add(colMesh);
      });
    });

    ROOMS.forEach((room) => {
      const layer = LAYERS.find((l) => l.id === room.layerId);
      const floorY = layer ? layer.elevationY : 0;
      const roomBoxGeom = new THREE.BoxGeometry(room.dimensions.width, room.dimensions.height, room.dimensions.depth);

      const roomMesh = new THREE.Mesh(
        roomBoxGeom,
        new THREE.MeshBasicMaterial({
          color: room.criticality === 'CRITICAL' ? 0x241d2d : 0x161821,
          transparent: true,
          opacity: 0.25,
          depthWrite: false,
        })
      );
      roomMesh.position.set(room.position[0], floorY + room.position[1], room.position[2]);
      this.campusGroup.add(roomMesh);

      const roomEdges = new THREE.LineSegments(
        new THREE.EdgesGeometry(roomBoxGeom),
        new THREE.LineBasicMaterial({
          color: room.criticality === 'CRITICAL' ? 0xd4af37 : 0x9d8eb5,
          transparent: true,
          opacity: 0.85,
        })
      );
      roomEdges.position.copy(roomMesh.position);
      this.campusGroup.add(roomEdges);
    });

    // Conduits + animated signal pulses inside hero intro
    this.conduitPulses = [];
    CONDUITS.forEach((conduit, idx) => {
      const isPower = conduit.type === 'POWER';
      const vecPoints = conduit.points.map((p) => new THREE.Vector3(p[0], p[1], p[2]));
      const lineGeom = new THREE.BufferGeometry().setFromPoints(vecPoints);
      const lineMat = new THREE.LineBasicMaterial({
        color: isPower ? 0xd4af37 : 0x9d8eb5,
        transparent: true,
        opacity: isPower ? 0.9 : 0.78,
      });
      this.campusGroup.add(new THREE.Line(lineGeom, lineMat));

      const curve = new THREE.CatmullRomCurve3(vecPoints, false, 'catmullrom', 0.05);
      const pulse = new THREE.Mesh(
        new THREE.SphereGeometry(isPower ? 0.16 : 0.13, 8, 8),
        new THREE.MeshBasicMaterial({ color: isPower ? 0xf5d061 : 0xbdb0d3, transparent: true, opacity: 0.95 })
      );
      this.campusGroup.add(pulse);
      this.conduitPulses.push({ mesh: pulse, curve, speed: isPower ? 0.25 : 0.36, offset: idx * 0.13 });
    });

    // Central Core Pulse Orb
    this.coreOrb = new THREE.Mesh(
      new THREE.SphereGeometry(0.8, 24, 24),
      new THREE.MeshBasicMaterial({ color: 0xf5d061, transparent: true, opacity: 0.9 })
    );
    this.coreOrb.position.set(0, 5, 0);
    this.campusGroup.add(this.coreOrb);

    // Hermite Spline Camera Trajectory
    this.DURATION = 7.5;
    this.camXTrack = createSmoothTrack([[0.0, 38], [0.25, 26], [0.5, -12], [0.72, 4], [0.85, 0], [1.0, 0]]);
    this.camYTrack = createSmoothTrack([[0.0, 28], [0.25, 18], [0.5, 10], [0.72, 7.5], [0.85, 6], [1.0, 6]]);
    this.camZTrack = createSmoothTrack([[0.0, 42], [0.25, 34], [0.5, 24], [0.72, 22], [0.85, 19], [1.0, 19]]);
    this.targetXTrack = createSmoothTrack([[0.0, 0], [0.4, 2], [0.7, -1], [1.0, 0]]);
    this.targetYTrack = createSmoothTrack([[0.0, 4], [0.4, 5.5], [0.7, 4.5], [1.0, 5]]);
    this.targetZTrack = createSmoothTrack([[0.0, 0], [0.4, 0], [0.7, 0], [1.0, 0]]);

    this._onResize = () => {
      if (this._disposed) return;
      width = window.innerWidth;
      height = window.innerHeight;
      this.camera.aspect = width / height;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(width, height);
    };
    window.addEventListener('resize', this._onResize);

    this._animate = this._animate.bind(this);
    this._rafId = requestAnimationFrame(this._animate);
  }

  _bindControls() {
    this._onSkip = () => this.enterTwin();
    this._onReplay = () => this.replay();

    this.overlayEl.querySelectorAll('[data-hero-enter]').forEach((btn) => {
      btn.addEventListener('click', this._onSkip);
    });
    this.overlayEl.querySelectorAll('[data-hero-replay]').forEach((btn) => {
      btn.addEventListener('click', this._onReplay);
    });
  }

  replay() {
    clearTimeout(this._flashTimer);
    clearTimeout(this._revealTimer);
    this.startTime = performance.now() / 1000;
    this.detonated = false;
    this.camShake = 0;
    this.coreLight.intensity = 0;
    this.coreOrb.scale.setScalar(0.2);
    if (this.flashEl) this.flashEl.style.opacity = '0';
    if (this.contentEl) this.contentEl.classList.remove('revealed');
  }

  enterTwin() {
    this.dispose();
    this.overlayEl.style.display = 'none';
    if (this.onEnter) this.onEnter();
  }

  _animate(nowMs) {
    if (this._disposed) return;
    this._rafId = requestAnimationFrame(this._animate);

    const now = nowMs / 1000;
    const elapsed = Math.max(0, now - this.startTime);
    const p = Math.min(elapsed / this.DURATION, 1.0);

    // Stardust float
    const posAttr = this.particleGeo.attributes.position;
    for (let i = 0; i < this.particleCount; i++) {
      posAttr.setY(i, posAttr.getY(i) + this.speeds[i * 3 + 1] * 0.05);
      if (posAttr.getY(i) > 25) posAttr.setY(i, -2);
    }
    posAttr.needsUpdate = true;

    // Live network pulses
    for (let i = 0; i < this.conduitPulses.length; i++) {
      const cp = this.conduitPulses[i];
      const prog = (elapsed * cp.speed + cp.offset) % 1;
      cp.mesh.position.copy(cp.curve.getPointAt(prog));
    }

    // Core Orb charge
    const charge = Math.min(1.0, p / 0.78);
    const orbPulse = 1.0 + Math.sin(now * 14) * 0.12;
    this.coreOrb.scale.setScalar((0.4 + charge * 1.6) * orbPulse);
    this.coreLight.intensity = Math.pow(charge, 2.5) * 8.0;

    // Camera Hermite Evaluation
    const cx = this.camXTrack(p);
    const cy = this.camYTrack(p);
    const cz = this.camZTrack(p);
    const tx = this.targetXTrack(p);
    const ty = this.targetYTrack(p);
    const tz = this.targetZTrack(p);

    if (p >= 0.78 && !this.detonated) {
      this.detonated = true;
      this.camShake = 0.35;
      if (this.flashEl) {
        this.flashEl.style.opacity = '0.85';
        this._flashTimer = setTimeout(() => {
          if (this.flashEl) this.flashEl.style.opacity = '0';
        }, 140);
      }
      this._revealTimer = setTimeout(() => {
        if (this.contentEl) this.contentEl.classList.add('revealed');
      }, 180);
    }

    if (this.camShake > 0.002) {
      this.camera.position.set(
        cx + (Math.random() - 0.5) * this.camShake,
        cy + (Math.random() - 0.5) * this.camShake,
        cz - this.camShake * 0.4
      );
      this.camShake *= 0.88;
    } else {
      this.camera.position.set(cx, cy, cz);
    }

    this.camera.lookAt(tx, ty, tz);
    this.campusGroup.rotation.y = p >= 0.85 ? Math.sin((now - this.startTime - 6.0) * 0.4) * 0.06 : 0;

    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    if (this._disposed) return;
    this._disposed = true;
    cancelAnimationFrame(this._rafId);
    clearTimeout(this._flashTimer);
    clearTimeout(this._revealTimer);
    window.removeEventListener('resize', this._onResize);
    this.overlayEl.querySelectorAll('[data-hero-enter]').forEach((btn) => {
      btn.removeEventListener('click', this._onSkip);
    });
    this.overlayEl.querySelectorAll('[data-hero-replay]').forEach((btn) => {
      btn.removeEventListener('click', this._onReplay);
    });
    this.particleGeo.dispose();
    this.particleMat.dispose();
    this.renderer.dispose();
  }
}
