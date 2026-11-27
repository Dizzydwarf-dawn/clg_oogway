import * as THREE from 'three';
import { OrbitControls } from '/vendor/three/OrbitControls.js';
import { LAYERS, ROOMS, CONDUITS } from './campusData.js';

/**
 * OMNIS-X 3D Campus Digital Twin Map (Charcoal / Dusty Purple / Gold)
 * Ported from JADE_PALACE CampusCanvas3D.tsx with:
 * - Animated Live Network (Dusty Purple Data Fiber + Pulses) & Power Grid (Gold + Pulses)
 * - Dynamic West/East Riser Shafts scaled by Exploded View
 * - Interactive Room Raycasting, Gold Selection Highlight, and Live Grievance Status
 */
export class CampusMap3D {
  constructor(container, callbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;

    this.selectedLayerId = 'all';
    this.selectedRoomId = null;
    this.hoveredRoomId = null;
    this.explodedDistance = 2.0;
    this.showPower = true;
    this.showData = true;
    this.showPulses = true;
    this.grievances = [];
    this.draftPin = null;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x0e0f12);

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.1, 200);
    this.camera.position.set(30, 24, 34);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.15;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.container.appendChild(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.minDistance = 6;
    this.controls.maxDistance = 110;
    this.controls.maxPolarAngle = Math.PI / 2.02;
    this.controls.target.set(0, 6, 0);

    this.targetCamPos = new THREE.Vector3(30, 24, 34);
    this.targetLookAt = new THREE.Vector3(0, 6, 0);
    this.isTransitioning = false;

    this.raycaster = new THREE.Raycaster();
    this.pointer = new THREE.Vector2();
    this.pointerDownPos = { x: 0, y: 0 };
    this.pickableMeshes = [];

    this.buildingGroup = new THREE.Group();
    this.conduitGroup = new THREE.Group();
    this.pulseGroup = new THREE.Group();
    this.beaconsGroup = new THREE.Group();
    this.draftPinGroup = new THREE.Group();
    this.pulseEntries = [];

    // OMNIS-X Charcoal & Gold Lighting Rig
    this.scene.add(new THREE.HemisphereLight(0x9d8eb5, 0x0e0f12, 0.9));
    const dirLight1 = new THREE.DirectionalLight(0xffffff, 1.5);
    dirLight1.position.set(25, 35, 20);
    this.scene.add(dirLight1);
    const dirLight2 = new THREE.DirectionalLight(0xd4af37, 1.1);
    dirLight2.position.set(-25, 20, -20);
    this.scene.add(dirLight2);
    this.scene.add(new THREE.AmbientLight(0x2d2a38, 0.7));

    this._buildGroundPlane();
    this.scene.add(this.buildingGroup);
    this.scene.add(this.conduitGroup);
    this.scene.add(this.pulseGroup);
    this.scene.add(this.beaconsGroup);
    this.scene.add(this.draftPinGroup);

    this._rebuildBuilding();
    this._rebuildConduits();
    this._setupEvents();
    this._handleResize();

    this.clock = new THREE.Clock();
    this._animate = this._animate.bind(this);
    this._rafId = requestAnimationFrame(this._animate);
  }

  _cadBox(size, { position = [0, 0, 0], color = 0x14151a, fillOpacity = 0.2, lineColor = 0x9d8eb5, lineOpacity = 0.65 } = {}) {
    const [w, h, d] = size;
    const group = new THREE.Group();
    group.position.set(position[0], position[1], position[2]);

    const geom = new THREE.BoxGeometry(w, h, d);
    const mesh = new THREE.Mesh(
      geom,
      new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: fillOpacity,
        depthWrite: false,
        side: THREE.DoubleSide,
      })
    );
    group.add(mesh);

    const lines = new THREE.LineSegments(
      new THREE.EdgesGeometry(geom),
      new THREE.LineBasicMaterial({
        color: lineColor,
        transparent: true,
        opacity: lineOpacity,
      })
    );
    group.add(lines);

    return { group, mesh, lines };
  }

  _buildGroundPlane() {
    const g = new THREE.Group();
    g.position.set(0, -0.02, 0);

    const minorGrid = new THREE.GridHelper(60, 60, 0x2d303b, 0x20222a);
    minorGrid.material.transparent = true;
    minorGrid.material.opacity = 0.35;
    g.add(minorGrid);

    const majorGrid = new THREE.GridHelper(60, 12, 0x9d8eb5, 0x2d303b);
    majorGrid.material.transparent = true;
    majorGrid.material.opacity = 0.22;
    majorGrid.position.y = 0.01;
    g.add(majorGrid);

    const boundary = [
      new THREE.Vector3(-21, 0.01, -14),
      new THREE.Vector3(21, 0.01, -14),
      new THREE.Vector3(21, 0.01, 14),
      new THREE.Vector3(-21, 0.01, 14),
      new THREE.Vector3(-21, 0.01, -14),
    ];
    g.add(
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(boundary),
        new THREE.LineBasicMaterial({ color: 0x5a4e70, transparent: true, opacity: 0.45 })
      )
    );

    this.scene.add(g);
  }

  _buildRoomFurniture(roomId, dimmed) {
    const fg = new THREE.Group();
    const box = (size, pos, accent = false) => {
      const { group } = this._cadBox(size, {
        position: pos,
        color: 0x191b22,
        fillOpacity: dimmed ? 0.05 : 0.3,
        lineColor: accent ? 0xd4af37 : 0x9d8eb5,
        lineOpacity: dimmed ? 0.14 : accent ? 0.68 : 0.44,
      });
      fg.add(group);
    };

    if (roomId.startsWith('CR-')) {
      box([1.8, 1.0, 0.8], [0, -0.9, -2.4], true);
      box([4.5, 1.6, 0.08], [0, 0.2, -3.45], true);
      box([0.6, 0.25, 0.6], [0, 1.3, -0.5], false);
      [-1.8, 0.2, 2.2].forEach((z) => {
        [-2.8, 0, 2.8].forEach((x) => box([1.8, 0.7, 0.7], [x, -0.85, z], false));
      });
    } else if (roomId === 'SUB-01') {
      box([2.8, 2.2, 2.2], [-2.8, -0.5, 0], true);
      box([2.8, 2.2, 2.2], [2.8, -0.5, 0], true);
      box([8.0, 2.4, 1.0], [0, -0.3, -2.6], true);
    } else if (roomId === 'UPS-01') {
      box([1.2, 2.2, 1.8], [-1.5, -0.4, 0], true);
      box([1.2, 2.2, 1.8], [0, -0.4, 0], true);
      box([1.0, 2.0, 2.4], [1.8, -0.5, -1.8], true);
      box([1.0, 2.0, 2.4], [1.8, -0.5, 1.8], true);
    } else if (roomId === 'SRV-01') {
      [-2.2, -0.8, 0.6, 2.0].forEach((x) => {
        box([1.1, 2.4, 1.1], [x, -0.3, -1.5], false);
        box([1.1, 2.4, 1.1], [x, -0.3, 1.5], false);
      });
      box([2.0, 0.6, 0.7], [0, 1.2, -2.6], true);
    } else if (roomId === 'BUS-01') {
      [-9, -3, 3, 9].forEach((x) => box([0.6, 1.8, 0.5], [x, -0.6, -2.5], true));
      [-6, 6].forEach((x) => box([8.5, 2.1, 2.6], [x, -0.6, 1.0], false));
    } else if (roomId === 'VLSI-201') {
      box([2.0, 2.5, 1.8], [-3.2, -0.3, -2.4], false);
      [-1, 2.2].forEach((x) => [-1.2, 1.5].forEach((z) => box([2.4, 0.8, 1.2], [x, -0.6, z], true)));
    } else if (roomId === 'ROB-202') {
      box([6.5, 2.2, 3.5], [0, 0, 0], true);
    } else if (roomId === 'HV-203') {
      box([1.6, 2.6, 1.6], [-2.5, -0.2, 0], true);
      box([3.8, 2.6, 3.8], [1.8, -0.2, 0], false);
    } else if (roomId === 'SEM-204') {
      box([9.5, 0.5, 1.5], [0, -1.1, -2.8], true);
      box([7.0, 2.0, 0.08], [0, 0.4, -3.45], true);
      [-1.0, -0.6, -0.2, 0.2].forEach((y, idx) => box([9.8, 0.45, 0.45], [0, y + 0.35, [-1.8, -0.4, 1.0, 2.4][idx]], false));
    } else if (roomId === 'ADM-301') {
      box([4.8, 0.15, 2.2], [0, -0.7, -0.5], true);
      box([2.2, 0.75, 1.1], [-3.8, -0.7, 2.0], false);
    } else if (roomId === 'CTR-302') {
      box([9.2, 2.2, 0.15], [0, 0.2, -3.2], true);
      box([3.2, 0.75, 1.2], [-2.5, -0.7, 0], false);
      box([3.2, 0.75, 1.2], [2.5, -0.7, 0], false);
    } else if (roomId === 'RF-303') {
      [-10, -6, -2, 2, 6, 10].forEach((x) => {
        const { group } = this._cadBox([3.2, 0.08, 3.8], { position: [x, 0.2, 0], fillOpacity: 0.18, lineColor: 0xd4af37, lineOpacity: 0.65 });
        group.rotation.x = -0.35;
        fg.add(group);
      });
      box([1.2, 4.4, 1.2], [0, 2.2, -2.0], false);
    }
    return fg;
  }

  _getFloorElevation(layerId) {
    const idx = LAYERS.findIndex((l) => l.id === layerId);
    if (idx < 0) return 0;
    return LAYERS[idx].elevationY + idx * this.explodedDistance;
  }

  _rebuildBuilding() {
    this.buildingGroup.clear();
    this.pickableMeshes = [];

    const columnXs = [-15, -7.5, 0, 7.5, 15];
    const columnZs = [-8, 0, 8];

    LAYERS.forEach((layer, index) => {
      const yElevation = layer.elevationY + index * this.explodedDistance;
      const isDimmedFloor = this.selectedLayerId !== 'all' && this.selectedLayerId !== layer.id;

      const floorGroup = new THREE.Group();
      floorGroup.position.set(0, yElevation, 0);

      const slab = this._cadBox([34, 0.25, 19], {
        position: [0, 0.125, 0],
        color: 0x14151a,
        fillOpacity: isDimmedFloor ? 0.08 : 0.45,
        lineColor: 0x9d8eb5,
        lineOpacity: isDimmedFloor ? 0.15 : 0.6,
      });
      floorGroup.add(slab.group);

      columnXs.forEach((cx) => {
        columnZs.forEach((cz) => {
          const col = this._cadBox([0.35, 3.6, 0.35], {
            position: [cx, 1.8, cz],
            color: 0x14151a,
            fillOpacity: 0.05,
            lineColor: 0x5a5565,
            lineOpacity: isDimmedFloor ? 0.08 : 0.3,
          });
          floorGroup.add(col.group);
        });
      });

      if (layer.id === 'floor1' || layer.id === 'floor2') {
        const w1 = this._cadBox([22, 3.2, 0.15], { position: [-4, 1.6, 1.2], fillOpacity: 0.04, lineColor: 0x5a5565, lineOpacity: isDimmedFloor ? 0.08 : 0.25 });
        const w2 = this._cadBox([22, 3.2, 0.15], { position: [-4, 1.6, -1.2], fillOpacity: 0.04, lineColor: 0x5a5565, lineOpacity: isDimmedFloor ? 0.08 : 0.25 });
        floorGroup.add(w1.group, w2.group);
      }

      ROOMS.filter((r) => r.layerId === layer.id).forEach((room) => {
        const isSelected = this.selectedRoomId === room.id;
        const isHovered = this.hoveredRoomId === room.id;
        const isDimmed = (this.selectedRoomId && !isSelected) || isDimmedFloor;

        const openIssues = this.grievances.filter((g) => g.roomId === room.id && g.status !== 'RESOLVED');
        const hasCritical = openIssues.some((g) => g.severity === 'CRITICAL');

        let fillColor = 0x14151a;
        let lineColor = room.criticality === 'CRITICAL' ? 0xd4af37 : 0xffffff;
        let fillOpacity = 0.16;
        let lineOpacity = 0.75;

        if (isSelected) {
          fillColor = 0x272433;
          lineColor = 0xf5d061;
          fillOpacity = 0.42;
          lineOpacity = 1.0;
        } else if (isHovered) {
          fillColor = 0x1e2029;
          lineColor = 0xd4af37;
          fillOpacity = 0.32;
          lineOpacity = 0.95;
        } else if (hasCritical && !isDimmed) {
          fillColor = 0x7f1d1d;
          lineColor = 0xef4444;
          fillOpacity = 0.32;
          lineOpacity = 0.95;
        } else if (openIssues.length > 0 && !isDimmed) {
          fillColor = 0x3b2c12;
          lineColor = 0xe5a83b;
          fillOpacity = 0.24;
          lineOpacity = 0.9;
        }

        if (isDimmed) {
          fillOpacity = 0.05;
          lineOpacity = 0.15;
        }

        const roomBox = this._cadBox(
          [room.dimensions.width, room.dimensions.height, room.dimensions.depth],
          { position: room.position, color: fillColor, fillOpacity, lineColor, lineOpacity }
        );

        roomBox.mesh.userData = { room, layer };
        this.pickableMeshes.push(roomBox.mesh);

        roomBox.group.add(this._buildRoomFurniture(room.id, isDimmed));
        floorGroup.add(roomBox.group);
      });

      this.buildingGroup.add(floorGroup);
    });
  }

  _mapConduitPoint(point) {
    const [x, y, z] = point;
    let adjustedY = y;
    if (y > 9.0) adjustedY = y + this.explodedDistance * 3;
    else if (y > 5.0) adjustedY = y + this.explodedDistance * 2;
    else if (y > 2.0) adjustedY = y + this.explodedDistance * 1;
    return new THREE.Vector3(x, adjustedY, z);
  }

  _rebuildConduits() {
    this.conduitGroup.clear();
    this.pulseGroup.clear();
    this.pulseEntries = [];

    if (!this.showPower && !this.showData) return;

    // West Power Riser & East Data Fiber Riser Shafts
    const totalExplodedHeight = 11.4 + this.explodedDistance * 3;
    if (this.showPower) {
      const riserWest = this._cadBox([0.9, totalExplodedHeight, 0.9], {
        position: [-4.5, totalExplodedHeight / 2, 0],
        fillOpacity: 0.04,
        lineColor: 0xd4af37,
        lineOpacity: 0.42,
      });
      this.conduitGroup.add(riserWest.group);
    }
    if (this.showData) {
      const riserEast = this._cadBox([0.9, totalExplodedHeight, 0.9], {
        position: [4.5, totalExplodedHeight / 2, 0],
        fillOpacity: 0.04,
        lineColor: 0x9d8eb5,
        lineOpacity: 0.42,
      });
      this.conduitGroup.add(riserEast.group);
    }

    const criticalRooms = new Set(
      this.grievances
        .filter((g) => g.status !== 'RESOLVED' && g.severity === 'CRITICAL')
        .map((g) => g.roomId)
    );

    CONDUITS.forEach((c, idx) => {
      const isPower = c.type === 'POWER';
      const isData = c.type === 'DATA';
      if (isPower && !this.showPower) return;
      if (isData && !this.showData) return;

      const vecPts = c.points.map((p) => this._mapConduitPoint(p));
      const curve = new THREE.CatmullRomCurve3(vecPts, false, 'catmullrom', 0.05);
      const isSevered =
        (isPower && criticalRooms.has('SUB-01')) ||
        (isData && criticalRooms.has('SRV-01'));

      const lineColor = isSevered ? 0x4a4e5c : isPower ? 0xd4af37 : 0x9d8eb5;
      const lineOpacity = isSevered ? 0.22 : isPower ? 0.88 : 0.78;

      this.conduitGroup.add(
        new THREE.Line(
          new THREE.BufferGeometry().setFromPoints(vecPts),
          new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: lineOpacity })
        )
      );

      if (this.showPulses && !isSevered) {
        const pulseColor = isPower ? 0xf5d061 : 0xbdb0d3;
        const radius = isPower ? 0.16 : 0.13;
        const speed = isData ? 0.32 : 0.22;
        for (let p = 0; p < 2; p++) {
          const sphere = new THREE.Mesh(
            new THREE.SphereGeometry(radius, 8, 8),
            new THREE.MeshBasicMaterial({ color: pulseColor, transparent: true, opacity: 0.95 })
          );
          this.pulseGroup.add(sphere);
          this.pulseEntries.push({
            mesh: sphere,
            curve,
            speed,
            offset: p * 0.5 + idx * 0.11,
          });
        }
      }
    });
  }

  _rebuildBeacons() {
    this.beaconsGroup.clear();
    const seenRooms = new Set();
    this.grievances.forEach((g) => {
      if (g.status === 'RESOLVED' || seenRooms.has(g.roomId)) return;
      const room = ROOMS.find((r) => r.id === g.roomId);
      if (!room) return;
      seenRooms.add(g.roomId);

      const floorY = this._getFloorElevation(room.layerId);
      const isVisible = this.selectedLayerId === 'all' || this.selectedLayerId === room.layerId;
      const col = new THREE.Color(g.severity === 'CRITICAL' ? 0xef4444 : 0xe5a83b);

      const marker = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.38, 0),
        new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: isVisible ? 0.92 : 0.2 })
      );
      marker.position.set(room.position[0], floorY + room.position[1] + room.dimensions.height / 2 + 0.65, room.position[2]);
      this.beaconsGroup.add(marker);
    });
  }

  _rebuildDraftPin() {
    this.draftPinGroup.clear();
    if (!this.draftPin) return;

    const room = ROOMS.find((r) => r.id === this.draftPin.roomId);
    if (!room) return;
    const floorY = this._getFloorElevation(room.layerId);
    const px = this.draftPin.x;
    const pz = this.draftPin.z;
    const py = floorY + room.position[1];
    const gold = new THREE.Color(0xf5d061);

    const lineGeom = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(px, floorY + 0.3, pz),
      new THREE.Vector3(px, py + 2.1, pz),
    ]);
    this.draftPinGroup.add(
      new THREE.Line(lineGeom, new THREE.LineBasicMaterial({ color: gold, transparent: true, opacity: 0.9 }))
    );

    const marker = new THREE.Mesh(
      new THREE.ConeGeometry(0.4, 0.85, 4),
      new THREE.MeshBasicMaterial({ color: gold })
    );
    marker.rotation.x = Math.PI;
    marker.position.set(px, py + 2.0, pz);
    this.draftPinGroup.add(marker);

    const ring = new THREE.Mesh(
      new THREE.RingGeometry(0.6, 0.82, 32),
      new THREE.MeshBasicMaterial({ color: gold, side: THREE.DoubleSide, transparent: true, opacity: 0.85 })
    );
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(px, floorY + 0.32, pz);
    this.draftPinGroup.add(ring);
  }

  setGrievances(list) {
    this.grievances = Array.isArray(list) ? list : [];
    this._rebuildBuilding();
    this._rebuildConduits();
    this._rebuildBeacons();
  }

  setLayer(layerId) {
    this.selectedLayerId = layerId || 'all';
    if (this.selectedRoomId && layerId !== 'all') {
      const r = ROOMS.find((x) => x.id === this.selectedRoomId);
      if (r && r.layerId !== layerId) this.selectedRoomId = null;
    }
    this._rebuildBuilding();
    this._rebuildBeacons();
    this._rebuildDraftPin();
    this._focusCameraForCurrentState();
  }

  setExplodedDistance(dist) {
    this.explodedDistance = Number(dist) || 0;
    this._rebuildBuilding();
    this._rebuildConduits();
    this._rebuildBeacons();
    this._rebuildDraftPin();
  }

  setUtilityLayers({ showPower, showData, showPulses }) {
    if (typeof showPower === 'boolean') this.showPower = showPower;
    if (typeof showData === 'boolean') this.showData = showData;
    if (typeof showPulses === 'boolean') this.showPulses = showPulses;
    this._rebuildConduits();
  }

  setViewPreset(preset) {
    this.isTransitioning = true;
    switch (preset) {
      case 'top':
        this.targetCamPos.set(0, 46, 0.01);
        this.targetLookAt.set(0, 5, 0);
        break;
      case 'front':
        this.targetCamPos.set(0, 10, 42);
        this.targetLookAt.set(0, 7, 0);
        break;
      case 'side':
        this.targetCamPos.set(-42, 10, 0);
        this.targetLookAt.set(0, 7, 0);
        break;
      case 'iso':
      default:
        this.targetCamPos.set(30, 24, 34);
        this.targetLookAt.set(0, 6, 0);
        break;
    }
  }

  selectRoom(roomId, customCoords = null) {
    const room = ROOMS.find((r) => r.id === roomId);
    if (!room) return;
    this.selectedRoomId = room.id;
    this.selectedLayerId = room.layerId;

    const floorY = this._getFloorElevation(room.layerId);
    const px = customCoords && typeof customCoords.x === 'number' ? customCoords.x : room.position[0];
    const py = customCoords && typeof customCoords.y === 'number' ? customCoords.y : floorY + room.position[1];
    const pz = customCoords && typeof customCoords.z === 'number' ? customCoords.z : room.position[2];

    this.draftPin = { roomId: room.id, layerId: room.layerId, x: px, y: py, z: pz };
    this._rebuildBuilding();
    this._rebuildBeacons();
    this._rebuildDraftPin();
    this._focusCameraForCurrentState();
  }

  clearSelection() {
    this.selectedRoomId = null;
    this.draftPin = null;
    this._rebuildBuilding();
    this._rebuildBeacons();
    this._rebuildDraftPin();
    this._focusCameraForCurrentState();
  }

  resetView() {
    this.selectedLayerId = 'all';
    this.selectedRoomId = null;
    this.explodedDistance = 2.0;
    this.draftPin = null;
    this._rebuildBuilding();
    this._rebuildConduits();
    this._rebuildBeacons();
    this._rebuildDraftPin();
    this.setViewPreset('iso');
  }

  _focusCameraForCurrentState() {
    this.isTransitioning = true;
    if (this.selectedRoomId) {
      const room = ROOMS.find((r) => r.id === this.selectedRoomId);
      if (room) {
        const floorY = this._getFloorElevation(room.layerId);
        const center = new THREE.Vector3(room.position[0], floorY + room.position[1], room.position[2]);
        this.targetLookAt.copy(center);
        this.targetCamPos.set(center.x + 10, center.y + 8, center.z + 11);
        return;
      }
    }
    if (this.selectedLayerId !== 'all') {
      const floorY = this._getFloorElevation(this.selectedLayerId);
      this.targetLookAt.set(0, floorY + 1.8, 0);
      this.targetCamPos.set(22, floorY + 12, 24);
      return;
    }
    this.targetLookAt.set(0, 5 + this.explodedDistance * 1.4, 0);
    this.targetCamPos.set(30, 24 + this.explodedDistance * 1.8, 34);
  }

  _setupEvents() {
    const dom = this.renderer.domElement;

    this._onPointerDown = (e) => {
      this.pointerDownPos = { x: e.clientX, y: e.clientY };
      this.isTransitioning = false;
    };

    this._onPointerMove = (e) => {
      const rect = dom.getBoundingClientRect();
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);

      const hits = this.raycaster.intersectObjects(this.pickableMeshes, false);
      const hitRoom = hits.length > 0 ? hits[0].object.userData.room : null;
      const newHoverId = hitRoom ? hitRoom.id : null;

      if (newHoverId !== this.hoveredRoomId) {
        this.hoveredRoomId = newHoverId;
        dom.style.cursor = hitRoom ? 'pointer' : 'grab';
        this._rebuildBuilding();
        if (this.callbacks.onHoverRoom) {
          this.callbacks.onHoverRoom(hitRoom, { x: e.clientX - rect.left, y: e.clientY - rect.top });
        }
      }
    };

    this._onPointerUp = (e) => {
      if (Math.hypot(e.clientX - this.pointerDownPos.x, e.clientY - this.pointerDownPos.y) > 6) return;
      const rect = dom.getBoundingClientRect();
      this.pointer.x = ((e.clientX - rect.left) / rect.width) * 2 - 1;
      this.pointer.y = -((e.clientY - rect.top) / rect.height) * 2 + 1;
      this.raycaster.setFromCamera(this.pointer, this.camera);

      const hits = this.raycaster.intersectObjects(this.pickableMeshes, false);
      if (hits.length > 0) {
        const hit = hits[0];
        const { room, layer } = hit.object.userData;
        const coords = {
          x: Number(hit.point.x.toFixed(2)),
          y: Number(hit.point.y.toFixed(2)),
          z: Number(hit.point.z.toFixed(2)),
        };
        this.selectRoom(room.id, coords);
        if (this.callbacks.onSelectRoom) {
          this.callbacks.onSelectRoom(room, layer, coords);
        }
      }
    };

    this._handleResize = () => {
      if (!this.container) return;
      const w = this.container.clientWidth || window.innerWidth;
      const h = this.container.clientHeight || 400;
      this.camera.aspect = w / h;
      this.camera.updateProjectionMatrix();
      this.renderer.setSize(w, h);
    };

    dom.addEventListener('pointerdown', this._onPointerDown);
    dom.addEventListener('pointermove', this._onPointerMove);
    dom.addEventListener('pointerup', this._onPointerUp);
    window.addEventListener('resize', this._handleResize);
    if (typeof ResizeObserver !== 'undefined') {
      this._resizeObs = new ResizeObserver(() => this._handleResize());
      this._resizeObs.observe(this.container);
    }
  }

  _animate() {
    this._rafId = requestAnimationFrame(this._animate);
    const elapsed = this.clock.getElapsedTime();

    if (this.isTransitioning) {
      this.camera.position.lerp(this.targetCamPos, 0.08);
      this.controls.target.lerp(this.targetLookAt, 0.08);
      if (
        this.camera.position.distanceTo(this.targetCamPos) < 0.12 &&
        this.controls.target.distanceTo(this.targetLookAt) < 0.12
      ) {
        this.isTransitioning = false;
      }
    }

    // Animate live power & network data pulses along conduits
    for (let i = 0; i < this.pulseEntries.length; i++) {
      const p = this.pulseEntries[i];
      const progress = (elapsed * p.speed + p.offset) % 1;
      p.mesh.position.copy(p.curve.getPointAt(progress));
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  }

  dispose() {
    cancelAnimationFrame(this._rafId);
    const dom = this.renderer.domElement;
    dom.removeEventListener('pointerdown', this._onPointerDown);
    dom.removeEventListener('pointermove', this._onPointerMove);
    dom.removeEventListener('pointerup', this._onPointerUp);
    window.removeEventListener('resize', this._handleResize);
    if (this._resizeObs) this._resizeObs.disconnect();
    this.controls.dispose();
    this.renderer.dispose();
  }
}
