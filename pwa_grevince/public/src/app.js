import {
  LAYERS,
  ROOMS,
  CATEGORIES,
  SEVERITIES,
  STATUS_META,
  getCategoryMeta,
  getLayerMeta,
  getRoomMeta,
} from './campusData.js';
import { CampusMap2D } from './campusMap2d.js';
import { EngineClient } from './engineClient.js';
import { enqueueGrievance, getQueuedGrievances, flushQueue } from './offlineQueue.js';

const state = {
  user: null, // { username, role, displayName, assignedFloor }
  alerts: [],
  unreadAlerts: 0,
  selectedCategory: 'water',
  selectedSubCategory: '',
  selectedSeverity: 'MEDIUM',
  selectedEquipment: '',
  selectedRoom: null,
  selectedLayer: null,
  pinCoords: null,
  photoDataUrl: '',
  grievances: [],
  statusSummary: null,
  config: null,
  desktopMapMode: '2d',
  showPower: false,
  showData: false,
  deferredInstallPrompt: null,
};

const $ = (id) => document.getElementById(id);

let map2dDesktop = null;
let map2dMobile = null;
let map3d = null;
let map3dInitialized = false;
let streamSource = null;
let pollTimer = null;

function showToast(msg, duration = 3500) {
  const el = $('toast');
  el.textContent = msg;
  el.style.display = 'block';
  clearTimeout(showToast._timer);
  showToast._timer = setTimeout(() => {
    el.style.display = 'none';
  }, duration);
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatTime(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString([], {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function syncMapsWithGrievances() {
  if (map2dDesktop) map2dDesktop.setGrievances(state.grievances);
  if (map2dMobile) map2dMobile.setGrievances(state.grievances);
  if (map3d) map3d.setGrievances(state.grievances);
}

async function refreshData() {
  try {
    const { items, statusSummary } = await EngineClient.fetchAll();
    state.grievances = items;
    state.statusSummary = statusSummary;
    localStorage.setItem('omnisx_cached_grievances', JSON.stringify(state.grievances));
    localStorage.setItem('omnisx_cached_status', JSON.stringify(state.statusSummary));
  } catch {
    try {
      state.grievances = JSON.parse(localStorage.getItem('omnisx_cached_grievances') || '[]');
      state.statusSummary = JSON.parse(localStorage.getItem('omnisx_cached_status') || 'null');
    } catch {
      // ignore
    }
  }

  syncMapsWithGrievances();
  renderStatusTab();
  renderAdminTriage();
  await updateQueueBadge();
}

async function refreshAlerts() {
  if (!state.user) return;
  try {
    const res = await EngineClient.fetchAlerts();
    state.alerts = res.items || [];
    state.unreadAlerts = res.unreadCount || 0;
  } catch {
    // offline
  }
  renderAlerts();
}

function renderAlerts() {
  const countEl = $('alerts-count');
  countEl.textContent = String(state.unreadAlerts);
  countEl.style.background = state.unreadAlerts > 0 ? 'rgba(212,175,55,0.22)' : '#14151C';

  const listEl = $('alerts-list');
  if (!state.alerts.length) {
    listEl.innerHTML = '<div style="text-align:center;padding:18px;font-size:12px;color:#8A8594;">No alerts yet.</div>';
    return;
  }

  listEl.innerHTML = state.alerts
    .map(
      (a) => `
      <div class="alert-item ${a.isRead ? '' : 'unread'}" data-alert-id="${escapeHtml(a.id)}" data-room="${escapeHtml(a.roomCode)}" data-layer="${escapeHtml(a.layerId)}">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <span class="mono" style="font-size:10px;color:${a.alertType === 'RESOLVED' ? '#52B788' : '#F5D061'};font-weight:700;">
            ${escapeHtml(a.alertType)} • ${escapeHtml(a.ticketCode)}
          </span>
          <span class="mono" style="font-size:10px;color:#8A8594;">${escapeHtml(formatTime(a.createdAt))}</span>
        </div>
        <div style="font-size:12px;color:#E2E1E6;line-height:1.4;">${escapeHtml(a.message)}</div>
      </div>`
    )
    .join('');

  listEl.querySelectorAll('.alert-item').forEach((el) => {
    el.addEventListener('click', async () => {
      const aid = el.dataset.alertId;
      const roomCode = el.dataset.room;
      try {
        await EngineClient.markAlertsRead(aid);
      } catch {
        // ignore
      }
      $('alerts-drawer').style.display = 'none';
      if (roomCode) {
        const room = getRoomMeta(roomCode);
        if (room) {
          if (map2dDesktop) map2dDesktop.selectRoom(room.id, null);
          if (map2dMobile) map2dMobile.selectRoom(room.id, null);
          setActiveLayerUI(room.layerId);
        }
      }
      if (state.user && (state.user.role === 'FACULTY' || state.user.role === 'ADMIN')) {
        switchTab('portal');
      } else {
        switchTab('status');
      }
      await refreshAlerts();
    });
  });
}

async function loadConfig() {
  if (!state.user || state.user.role !== 'ADMIN') return;
  try {
    const cfg = await EngineClient.fetchConfig();
    state.config = cfg;
    $('cfg-website-name').value = cfg.websiteName || '';
    $('cfg-integration-mode').value = cfg.integrationMode || 'omnisx';
    $('cfg-webhook-url').value = cfg.webhookUrl || '';
    $('cfg-omnisx-user').value = cfg.omnisxUserId || 'USR-PRINCIPAL';
    $('cfg-auto-forward').checked = cfg.autoForward !== false;
    $('omnisx-user-field').style.display = cfg.integrationMode === 'webhook' ? 'none' : 'block';
  } catch {
    // offline
  }
}

// --- Role-Aware UI & Live SSE Stream ---
function applyUserRoleUI() {
  const user = state.user;
  if (!user) return;

  const isStaff = user.role === 'ADMIN' || user.role === 'FACULTY';
  const isAdmin = user.role === 'ADMIN';

  // Top bar badge
  if (user.role === 'FACULTY') {
    const lvl = user.assignedFloor === 'floor1' ? 'LEVEL 01' : user.assignedFloor === 'floor2' ? 'LEVEL 02' : user.assignedFloor;
    $('user-role-badge').textContent = `${user.username.toUpperCase()} • ${lvl}`;
  } else {
    $('user-role-badge').textContent = user.role;
  }
  $('portal-subtitle').textContent = `Signed in as ${user.displayName}`;

  // Show/hide Tab 3 (Floor Triage / Admin)
  $('tab-btn-portal').style.display = isStaff ? 'block' : 'none';
  $('mob-tab-portal').style.display = isStaff ? 'flex' : 'none';
  $('desktop-tabs').style.gridTemplateColumns = isStaff ? 'repeat(3, 1fr)' : 'repeat(2, 1fr)';
  $('mobile-nav').style.gridTemplateColumns = isStaff ? 'repeat(3, 1fr)' : 'repeat(2, 1fr)';

  const portalLabel = isAdmin ? 'Admin & Sync' : 'My Floor Alerts';
  $('tab-btn-portal').textContent = portalLabel;
  $('mob-tab-portal').textContent = portalLabel;
  $('admin-config-card').style.display = isAdmin ? 'block' : 'none';

  // Default landing tab & floor focus
  if (user.role === 'FACULTY') {
    const floorLayer = getLayerMeta(user.assignedFloor);
    $('role-triage-banner').innerHTML = `<strong style="color:#F5D061;">${escapeHtml(user.displayName)}</strong> — Receiving alerts for <strong>${escapeHtml(floorLayer.planeNumber)} (${escapeHtml(floorLayer.title)})</strong>. Resolving an issue here updates all users immediately.`;
    $('triage-list-heading').textContent = `${floorLayer.planeNumber} Issue Queue`;
    if (map2dDesktop) map2dDesktop.setLayer(user.assignedFloor);
    if (map2dMobile) map2dMobile.setLayer(user.assignedFloor);
    setActiveLayerUI(user.assignedFloor);
    switchTab('portal');
  } else if (isAdmin) {
    $('role-triage-banner').innerHTML = `<strong style="color:#F5D061;">Campus Admin</strong> — Viewing all floors and OMNIS-X engine sync settings.`;
    $('triage-list-heading').textContent = 'All Campus Issues (Admin Triage)';
    switchTab('portal');
  } else {
    switchTab('report');
  }
}

function startLiveSync() {
  stopLiveSync();
  streamSource = EngineClient.connectStream({
    onCreated: async (ev) => {
      await Promise.all([refreshData(), refreshAlerts()]);
      const targets = ev.alertTargets || [];
      if (state.user && targets.includes(state.user.username)) {
        showToast(`ALERT: ${ev.message}`, 5500);
      }
    },
    onUpdated: async (ev) => {
      await Promise.all([refreshData(), refreshAlerts()]);
      showToast(`UPDATE: ${ev.message}`, 5000);
    },
    onDeleted: async () => {
      await Promise.all([refreshData(), refreshAlerts()]);
    },
  });

  // Gentle 8-second fallback sync in case SSE reconnects on mobile sleep/wake
  pollTimer = setInterval(() => {
    if (state.user && navigator.onLine) {
      refreshData();
      refreshAlerts();
    }
  }, 8000);
}

function stopLiveSync() {
  if (streamSource) {
    streamSource.close();
    streamSource = null;
  }
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function enterAuthenticatedApp(user) {
  state.user = user;
  $('login-screen').style.display = 'none';
  $('app-shell').style.display = 'flex';
  if (map2dDesktop) map2dDesktop._render();
  if (map2dMobile) map2dMobile._render();
  applyUserRoleUI();
  await Promise.all([loadConfig(), refreshData(), refreshAlerts()]);
  startLiveSync();
}

function showLoginScreen() {
  stopLiveSync();
  state.user = null;
  state.alerts = [];
  state.unreadAlerts = 0;
  $('alerts-drawer').style.display = 'none';
  $('app-shell').style.display = 'none';
  $('login-screen').style.display = 'flex';
}

function initAuth() {
  $('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errEl = $('login-error');
    errEl.style.display = 'none';
    const username = $('login-username').value.trim();
    const password = $('login-password').value;
    const btn = $('btn-login-submit');
    btn.disabled = true;
    btn.textContent = 'Signing in...';
    try {
      const user = await EngineClient.login(username, password);
      await enterAuthenticatedApp(user);
    } catch (err) {
      errEl.textContent = err.message || 'Invalid credentials';
      errEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Sign In to Portal';
    }
  });

  document.querySelectorAll('.quick-user-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const u = btn.dataset.demoUser;
      const p = btn.dataset.demoPass;
      $('login-username').value = u;
      $('login-password').value = p;
      $('login-error').style.display = 'none';
      try {
        const user = await EngineClient.login(u, p);
        await enterAuthenticatedApp(user);
      } catch (err) {
        $('login-error').textContent = err.message;
        $('login-error').style.display = 'block';
      }
    });
  });

  $('btn-logout').addEventListener('click', async () => {
    await EngineClient.logout();
    showLoginScreen();
  });

  $('btn-alerts').addEventListener('click', () => {
    const drawer = $('alerts-drawer');
    const isOpen = drawer.style.display === 'flex';
    drawer.style.display = isOpen ? 'none' : 'flex';
  });

  $('btn-close-alerts').addEventListener('click', () => {
    $('alerts-drawer').style.display = 'none';
  });

  $('btn-mark-all-read').addEventListener('click', async () => {
    await EngineClient.markAlertsRead(null);
    await refreshAlerts();
  });
}

// --- Lightweight 2D Maps ---
function init2DMaps() {
  const callbacks = {
    onLayerChange: (layerId) => {
      setActiveLayerUI(layerId);
      if (map2dDesktop && map2dDesktop.activeLayerId !== layerId) map2dDesktop.setLayer(layerId);
      if (map2dMobile && map2dMobile.activeLayerId !== layerId) map2dMobile.setLayer(layerId);
      if (map3d) map3d.setLayer(layerId);
    },
    onSelectRoom: (room, layer, coords) => {
      setLocationFromMap(room, layer, coords);
      showToast(`Pinned ${room.code} (${layer.planeNumber})`);
    },
  };

  map2dDesktop = new CampusMap2D($('desktop-map2d-host'), callbacks);
  map2dMobile = new CampusMap2D($('mobile-map2d-host'), callbacks);
}

// --- Lazy-loaded 3D Twin (Desktop optional only) ---
async function init3DMapLazy() {
  if (map3dInitialized) return;
  map3dInitialized = true;

  const { CampusMap3D } = await import('./campusMap3d.js');
  const container = $('map3d-container');
  const tooltip = $('hover-tooltip');

  map3d = new CampusMap3D(container, {
    onHoverRoom: (room, pos) => {
      if (!room) {
        tooltip.style.display = 'none';
        return;
      }
      const openCount = state.grievances.filter(
        (g) => g.roomId === room.id && g.status !== 'RESOLVED'
      ).length;
      tooltip.innerHTML = `<strong style="color:#F5D061;">${escapeHtml(room.code)}</strong> • ${escapeHtml(room.name)}<br><span style="color:#9D8EB5;">${
        openCount > 0 ? `${openCount} active issue(s)` : 'Click to pin location'
      }</span>`;
      tooltip.style.left = `${pos.x}px`;
      tooltip.style.top = `${pos.y}px`;
      tooltip.style.display = 'block';
    },
    onSelectRoom: (room, layer, coords) => {
      setLocationFromMap(room, layer, coords);
      showToast(`Pinned ${room.code} (${layer.planeNumber})`);
    },
  });

  map3d.setGrievances(state.grievances);
  if (state.selectedRoom) {
    map3d.selectRoom(state.selectedRoom.id, state.pinCoords);
  }

  const floorPills = $('floor-pills');
  const allBtn = document.createElement('button');
  allBtn.className = 'floor-pill active';
  allBtn.textContent = 'All Levels';
  allBtn.dataset.layer = 'all';
  floorPills.appendChild(allBtn);

  LAYERS.forEach((layer) => {
    const b = document.createElement('button');
    b.className = 'floor-pill';
    b.textContent = layer.planeNumber;
    b.dataset.layer = layer.id;
    floorPills.appendChild(b);
  });

  floorPills.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-layer]');
    if (!btn) return;
    const lid = btn.dataset.layer;
    setActiveLayerUI(lid);
    map3d.setLayer(lid);
    if (lid !== 'all') {
      if (map2dDesktop) map2dDesktop.setLayer(lid);
      if (map2dMobile) map2dMobile.setLayer(lid);
    }
  });

  $('view-presets').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-preset]');
    if (!btn) return;
    $('view-presets').querySelectorAll('button[data-preset]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    map3d.setViewPreset(btn.dataset.preset);
  });

  $('btn-reset-map').addEventListener('click', () => {
    map3d.resetView();
    setActiveLayerUI('all');
    $('explode-slider').value = '1.6';
    $('explode-val').textContent = '1.6m';
    $('view-presets').querySelectorAll('button[data-preset]').forEach((b) => {
      b.classList.toggle('active', b.dataset.preset === 'iso');
    });
  });

  $('explode-slider').addEventListener('input', (e) => {
    const val = parseFloat(e.target.value);
    $('explode-val').textContent = `${val.toFixed(1)}m`;
    map3d.setExplodedDistance(val);
  });

  $('btn-toggle-power').addEventListener('click', () => {
    state.showPower = !state.showPower;
    $('btn-toggle-power').classList.toggle('active-power', state.showPower);
    map3d.setUtilityLayers({ showPower: state.showPower });
  });

  $('btn-toggle-data').addEventListener('click', () => {
    state.showData = !state.showData;
    $('btn-toggle-data').classList.toggle('active-data', state.showData);
    map3d.setUtilityLayers({ showData: state.showData });
  });
}

function initDesktopModeSwitch() {
  $('map-mode-switch').addEventListener('click', async (e) => {
    const btn = e.target.closest('button[data-map-mode]');
    if (!btn) return;
    const mode = btn.dataset.mapMode;
    state.desktopMapMode = mode;

    $('map-mode-switch').querySelectorAll('button').forEach((b) => {
      b.classList.toggle('active', b.dataset.mapMode === mode);
    });

    if (mode === '3d') {
      $('desktop-map2d-host').style.display = 'none';
      $('desktop-map3d-wrap').style.display = 'block';
      await init3DMapLazy();
      if (map3d) map3d._handleResize();
    } else {
      $('desktop-map3d-wrap').style.display = 'none';
      $('desktop-map2d-host').style.display = 'flex';
    }
  });
}

function setActiveLayerUI(layerId) {
  const layer = layerId === 'all' ? null : getLayerMeta(layerId);
  $('breadcrumb-floor').textContent = layer ? `${layer.planeNumber} (${layer.title})` : 'All Levels';
  $('floor-pills').querySelectorAll('button[data-layer]').forEach((b) => {
    b.classList.toggle('active', b.dataset.layer === layerId);
  });
}

function setLocationFromMap(room, layer, coords) {
  state.selectedRoom = room;
  state.selectedLayer = layer || getLayerMeta(room.layerId);
  state.pinCoords = coords || {
    x: room.position[0],
    y: Number((state.selectedLayer.elevationY + room.position[1]).toFixed(2)),
    z: room.position[2],
  };
  state.selectedEquipment = '';

  setActiveLayerUI(room.layerId);
  $('room-select').value = room.id;

  if (map2dDesktop) map2dDesktop.selectRoom(room.id, state.pinCoords);
  if (map2dMobile) map2dMobile.selectRoom(room.id, state.pinCoords);
  if (map3d && map3d.selectedRoomId !== room.id) map3d.selectRoom(room.id, state.pinCoords);

  const eqField = $('equipment-field');
  const eqChips = $('equipment-chips');
  eqChips.innerHTML = '';
  if (room.equipment && room.equipment.length) {
    room.equipment.forEach((eq) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'mini-chip';
      btn.textContent = eq;
      btn.addEventListener('click', () => {
        const already = state.selectedEquipment === eq;
        state.selectedEquipment = already ? '' : eq;
        eqChips.querySelectorAll('.mini-chip').forEach((x) => x.classList.remove('active'));
        if (!already) btn.classList.add('active');
      });
      eqChips.appendChild(btn);
    });
    eqField.style.display = 'block';
  } else {
    eqField.style.display = 'none';
  }

  const alertTargetNote =
    room.layerId === 'floor1'
      ? 'Alerts Faculty 1'
      : room.layerId === 'floor2'
      ? 'Alerts Faculty 2'
      : 'Alerts Admin';

  const locBox = $('location-display');
  locBox.classList.add('selected');
  locBox.innerHTML = `
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
      <span class="badge" style="border-color:rgba(212,175,55,0.45);color:#F5D061;">${escapeHtml(room.code)} • ${escapeHtml(state.selectedLayer.planeNumber)}</span>
      <span class="mono" style="font-size:10px;color:#52B788;">${alertTargetNote}</span>
    </div>
    <div style="font-size:13px;font-weight:700;color:#fff;">${escapeHtml(room.name)}</div>
    <div style="font-size:11px;color:#8A8594;margin-top:2px;">${escapeHtml(room.department)}</div>
  `;
}

function initFormControls() {
  const grid = $('category-grid');
  const filterCat = $('filter-category');

  CATEGORIES.forEach((cat) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `cat-card ${cat.id === state.selectedCategory ? 'active' : ''}`;
    btn.dataset.cat = cat.id;
    btn.innerHTML = `<span class="cat-dot" style="background:${cat.color};"></span><span>${escapeHtml(cat.label)}</span>`;
    grid.appendChild(btn);

    const opt = document.createElement('option');
    opt.value = cat.id;
    opt.textContent = cat.label;
    filterCat.appendChild(opt);
  });

  grid.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-cat]');
    if (!btn) return;
    selectCategory(btn.dataset.cat);
  });

  selectCategory(state.selectedCategory);

  const roomSelect = $('room-select');
  LAYERS.forEach((layer) => {
    const grp = document.createElement('optgroup');
    grp.label = `${layer.planeNumber} — ${layer.title}`;
    ROOMS.filter((r) => r.layerId === layer.id).forEach((room) => {
      const opt = document.createElement('option');
      opt.value = room.id;
      opt.textContent = `${room.code} — ${room.name}`;
      grp.appendChild(opt);
    });
    roomSelect.appendChild(grp);
  });

  roomSelect.addEventListener('change', () => {
    const room = getRoomMeta(roomSelect.value);
    if (!room) {
      state.selectedRoom = null;
      state.pinCoords = null;
      state.selectedEquipment = '';
      $('location-display').classList.remove('selected');
      $('location-display').innerHTML = '<div class="location-empty">Tap any room on the college floor plan, or select from the list below.</div>';
      $('equipment-field').style.display = 'none';
      if (map2dDesktop) map2dDesktop.clearSelection();
      if (map2dMobile) map2dMobile.clearSelection();
      if (map3d) map3d.clearSelection();
      return;
    }
    const layer = getLayerMeta(room.layerId);
    setLocationFromMap(room, layer, {
      x: room.position[0],
      y: Number((layer.elevationY + room.position[1]).toFixed(2)),
      z: room.position[2],
    });
  });

  const sevRow = $('severity-row');
  SEVERITIES.forEach((s) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `sev-btn ${s.id === state.selectedSeverity ? 'active' : ''}`;
    b.dataset.sev = s.id;
    b.textContent = s.label;
    sevRow.appendChild(b);
  });

  sevRow.addEventListener('click', (e) => {
    const b = e.target.closest('button[data-sev]');
    if (!b) return;
    state.selectedSeverity = b.dataset.sev;
    sevRow.querySelectorAll('button').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.sev === state.selectedSeverity);
    });
  });

  try {
    const savedProfile = JSON.parse(localStorage.getItem('omnisx_student_profile') || '{}');
    if (savedProfile.name) $('student-name').value = savedProfile.name;
    if (savedProfile.id) $('student-id').value = savedProfile.id;
    if (savedProfile.contact) $('student-contact').value = savedProfile.contact;
  } catch {
    // ignore
  }

  $('anon-toggle').addEventListener('change', (e) => {
    $('student-fields').style.display = e.target.checked ? 'none' : 'block';
  });

  $('photo-input').addEventListener('change', async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    try {
      state.photoDataUrl = await compressImageToDataUrl(file, 800, 0.72);
      $('photo-preview').src = state.photoDataUrl;
      $('photo-preview-wrap').style.display = 'flex';
      $('photo-preview-wrap').style.alignItems = 'center';
    } catch {
      showToast('Could not process image');
    }
  });

  $('btn-clear-photo').addEventListener('click', () => {
    state.photoDataUrl = '';
    $('photo-input').value = '';
    $('photo-preview-wrap').style.display = 'none';
  });

  $('btn-new-report').addEventListener('click', () => {
    $('submission-success').style.display = 'none';
    $('report-form-container').style.display = 'block';
  });

  $('grievance-form').addEventListener('submit', handleSubmitGrievance);
}

function selectCategory(catId) {
  state.selectedCategory = catId;
  const cat = getCategoryMeta(catId);
  $('selected-cat-badge').textContent = cat.shortLabel.toUpperCase();
  $('issue-title').placeholder = cat.quickPlaceholder;

  $('category-grid').querySelectorAll('button[data-cat]').forEach((b) => {
    b.classList.toggle('active', b.dataset.cat === catId);
  });

  const chips = $('subcategory-chips');
  chips.innerHTML = '';
  state.selectedSubCategory = cat.subCategories[0] || '';
  cat.subCategories.forEach((sub, idx) => {
    const c = document.createElement('button');
    c.type = 'button';
    c.className = `mini-chip ${idx === 0 ? 'active' : ''}`;
    c.textContent = sub;
    c.addEventListener('click', () => {
      state.selectedSubCategory = sub;
      chips.querySelectorAll('.mini-chip').forEach((x) => x.classList.remove('active'));
      c.classList.add('active');
      if (!$('issue-title').value.trim()) {
        $('issue-title').value = state.selectedRoom ? `${sub} in ${state.selectedRoom.code}` : sub;
      }
    });
    chips.appendChild(c);
  });
}

function compressImageToDataUrl(file, maxDim, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          const ratio = Math.min(maxDim / width, maxDim / height);
          width = Math.round(width * ratio);
          height = Math.round(height * ratio);
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d').drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

async function handleSubmitGrievance(e) {
  e.preventDefault();
  if (!state.selectedRoom) {
    showToast('Tap a room on the floor plan first.');
    return;
  }

  const title = $('issue-title').value.trim();
  const description = $('issue-desc').value.trim();
  if (!title || !description) {
    showToast('Please enter a short headline and details.');
    return;
  }

  const anonymous = $('anon-toggle').checked;
  const studentName = $('student-name').value.trim();
  const studentId = $('student-id').value.trim();
  const studentContact = $('student-contact').value.trim();

  if (!anonymous) {
    localStorage.setItem(
      'omnisx_student_profile',
      JSON.stringify({ name: studentName, id: studentId, contact: studentContact })
    );
  }

  const payload = {
    category: state.selectedCategory,
    subCategory: state.selectedSubCategory,
    title,
    description,
    severity: state.selectedSeverity,
    layerId: state.selectedRoom.layerId,
    layerTitle: state.selectedLayer?.title || '',
    roomId: state.selectedRoom.id,
    roomCode: state.selectedRoom.code,
    roomName: state.selectedRoom.name,
    backendEntityId: state.selectedRoom.backendEntityId || state.selectedRoom.id,
    department: state.selectedRoom.department,
    equipment: state.selectedEquipment,
    locationNote: $('location-note').value.trim(),
    pinCoords: state.pinCoords || { x: 0, y: 0, z: 0 },
    anonymous,
    studentName,
    studentId,
    studentContact,
    photoDataUrl: state.photoDataUrl,
  };

  const btn = $('btn-submit');
  btn.disabled = true;
  btn.textContent = 'Submitting...';

  try {
    if (!navigator.onLine) throw new Error('offline');
    const item = await EngineClient.submitGrievance(payload);
    resetFormFields();
    await Promise.all([refreshData(), refreshAlerts()]);

    $('success-ticket-code').textContent = item.ticketCode;
    $('success-sync-note').textContent = `Assigned & alerted: ${item.assignedTo || 'Campus Admin'} (${item.roomCode}).`;
    $('report-form-container').style.display = 'none';
    $('submission-success').style.display = 'block';
  } catch {
    await enqueueGrievance(payload);
    await updateQueueBadge();
    resetFormFields();
    showToast('Saved offline — will auto-sync when online.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Submit Incident Report';
  }
}

function resetFormFields() {
  $('issue-title').value = '';
  $('issue-desc').value = '';
  $('location-note').value = '';
  state.selectedEquipment = '';
  $('equipment-chips').querySelectorAll('.mini-chip').forEach((x) => x.classList.remove('active'));
  state.photoDataUrl = '';
  $('photo-input').value = '';
  $('photo-preview-wrap').style.display = 'none';
}

function renderStatusTab() {
  const cardsEl = $('system-status-cards');
  const feedEl = $('grievance-feed');
  const s = state.statusSummary;

  const badgeColor = (st) => {
    if (st === 'CRITICAL') return '#E05D5D';
    if (st === 'DEGRADED') return '#E5A83B';
    if (st === 'ADVISORY') return '#D4AF37';
    return '#52B788';
  };

  if (s) {
    const sysList = [
      { key: 'water', title: 'Water & Coolers' },
      { key: 'ac', title: 'Air Conditioning' },
      { key: 'faculty', title: 'Teacher / Classes' },
      { key: 'electrical', title: 'Power & Lights' },
      { key: 'network', title: 'Wi-Fi & Labs' },
      { key: 'facilities', title: 'Hygiene & Facility' },
    ];
    cardsEl.innerHTML = sysList
      .map((sys) => {
        const info = s.systems[sys.key] || { state: 'OPERATIONAL', openCount: 0, affectedRooms: [] };
        const col = badgeColor(info.state);
        const roomsText = info.affectedRooms.length ? info.affectedRooms.join(', ') : 'All normal';
        return `
        <div class="stat-card">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:5px;">
            <span style="font-size:11px;font-weight:600;color:#E2E1E6;">${sys.title}</span>
            <span class="badge" style="border-color:${col};color:${col};">${info.state}</span>
          </div>
          <div class="mono" style="font-size:10px;color:#8A8594;">
            Open: <strong style="color:#E2E1E6;">${info.openCount}</strong> • ${escapeHtml(roomsText)}
          </div>
        </div>`;
      })
      .join('');
  }

  const catFilter = $('filter-category').value;
  const stFilter = $('filter-status').value;
  const search = $('filter-search').value.trim().toLowerCase();

  const filtered = state.grievances.filter((g) => {
    if (catFilter !== 'ALL' && g.category !== catFilter) return false;
    if (stFilter !== 'ALL' && g.status !== stFilter) return false;
    if (search) {
      const hay = `${g.ticketCode} ${g.title} ${g.description} ${g.roomCode} ${g.roomName} ${g.equipment}`.toLowerCase();
      if (!hay.includes(search)) return false;
    }
    return true;
  });

  if (!filtered.length) {
    feedEl.innerHTML = '<div class="section-card" style="text-align:center;color:#8A8594;font-size:12px;">No grievances reported yet. All campus areas are clear.</div>';
    return;
  }

  feedEl.innerHTML = filtered
    .map((g) => {
      const cat = getCategoryMeta(g.category);
      const stMeta = STATUS_META[g.status] || { label: g.status, color: '#9D8EB5' };
      return `
      <div class="ticket-card" data-focus-room="${escapeHtml(g.roomId)}">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:6px;margin-bottom:5px;">
          <span class="mono" style="font-size:10px;color:#F5D061;">${escapeHtml(g.ticketCode)} • ${escapeHtml(g.roomCode)}</span>
          <span class="badge" style="border-color:${stMeta.color};color:${stMeta.color};">${escapeHtml(stMeta.label)}</span>
        </div>
        <div style="font-size:13px;font-weight:600;color:#E2E1E6;margin-bottom:4px;">${escapeHtml(g.title)}</div>
        <div style="font-size:12px;color:#8A8594;line-height:1.45;margin-bottom:8px;">${escapeHtml(g.description)}</div>
        <div style="display:flex;flex-wrap:wrap;gap:6px;align-items:center;">
          <span class="badge" style="border-color:${cat.color};color:${cat.color};">${escapeHtml(cat.shortLabel)}</span>
          <span class="badge">${escapeHtml(g.severity)}</span>
          ${g.assignedTo ? `<span class="badge">Assigned: ${escapeHtml(g.assignedTo)}</span>` : ''}
          <span class="mono" style="font-size:10px;color:#8A8594;margin-left:auto;">${escapeHtml(formatTime(g.createdAt))}</span>
        </div>
        ${g.resolutionNote || g.updatedBy ? `<div style="margin-top:8px;padding:6px 8px;background:rgba(82,183,136,0.08);border-left:2px solid #52B788;font-size:11px;color:#cce8db;">${g.updatedBy ? `Updated by ${escapeHtml(g.updatedBy)}: ` : 'Update: '}${escapeHtml(g.resolutionNote || g.status)}</div>` : ''}
        ${g.photoDataUrl ? `<img src="${g.photoDataUrl}" alt="Attachment" style="margin-top:8px;max-height:84px;border-radius:6px;border:1px solid #2D303E;" />` : ''}
      </div>`;
    })
    .join('');

  feedEl.querySelectorAll('.ticket-card[data-focus-room]').forEach((card) => {
    card.addEventListener('click', () => {
      const rid = card.dataset.focusRoom;
      const room = getRoomMeta(rid);
      if (room) {
        if (map2dDesktop) map2dDesktop.selectRoom(rid, null);
        if (map2dMobile) map2dMobile.selectRoom(rid, null);
        if (map3d) map3d.selectRoom(rid, null);
        setActiveLayerUI(room.layerId);
      }
    });
  });
}

function renderAdminTriage() {
  const el = $('admin-triage-list');
  if (!state.user || (state.user.role !== 'ADMIN' && state.user.role !== 'FACULTY')) {
    el.innerHTML = '';
    return;
  }

  const list =
    state.user.role === 'FACULTY' && state.user.assignedFloor
      ? state.grievances.filter((g) => g.layerId === state.user.assignedFloor)
      : state.grievances;

  if (!list.length) {
    el.innerHTML = '<div style="font-size:12px;color:#8A8594;">No grievances reported on your assigned floor yet.</div>';
    return;
  }

  el.innerHTML = list
    .map((g) => {
      const stMeta = STATUS_META[g.status] || { label: g.status, color: '#9D8EB5' };
      return `
      <div style="border:1px solid #252833;border-radius:8px;padding:11px;margin-bottom:10px;background:#14151C;">
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
          <strong class="mono" style="font-size:11px;color:#F5D061;">${escapeHtml(g.ticketCode)} • ${escapeHtml(g.roomCode)}</strong>
          <span class="badge" style="border-color:${stMeta.color};color:${stMeta.color};">${escapeHtml(stMeta.label)}</span>
        </div>
        <div style="font-size:13px;font-weight:600;margin-bottom:4px;color:#E2E1E6;">${escapeHtml(g.title)}</div>
        <div style="font-size:12px;color:#8A8594;margin-bottom:8px;">${escapeHtml(g.description)}</div>
        <div class="field" style="margin-bottom:8px;">
          <input class="input triage-note" data-id="${escapeHtml(g.id)}" type="text" value="${escapeHtml(g.resolutionNote)}" placeholder="Resolution / action note for all users..." style="padding:7px 9px;font-size:12px;" />
        </div>
        <div style="display:flex;gap:6px;flex-wrap:wrap;">
          <button type="button" class="btn btn-sm triage-action" data-id="${escapeHtml(g.id)}" data-status="ACKNOWLEDGED">Acknowledge</button>
          <button type="button" class="btn btn-sm triage-action" data-id="${escapeHtml(g.id)}" data-status="IN_PROGRESS">In Progress</button>
          <button type="button" class="btn btn-sm btn-gold triage-action" data-id="${escapeHtml(g.id)}" data-status="RESOLVED" style="margin-left:auto;">Mark Resolved</button>
        </div>
      </div>`;
    })
    .join('');

  el.querySelectorAll('.triage-action').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const status = btn.dataset.status;
      const resolutionNote = el.querySelector(`.triage-note[data-id="${id}"]`).value.trim();
      btn.disabled = true;
      try {
        await EngineClient.updateGrievanceStatus(id, { status, resolutionNote });
        showToast(`Marked ${status} — updated across all users`);
        await Promise.all([refreshData(), refreshAlerts()]);
      } catch (err) {
        showToast(`Failed: ${err.message}`);
      } finally {
        btn.disabled = false;
      }
    });
  });
}

function initPortalTab() {
  $('cfg-integration-mode').addEventListener('change', (e) => {
    $('omnisx-user-field').style.display = e.target.value === 'webhook' ? 'none' : 'block';
  });

  $('btn-save-config').addEventListener('click', async () => {
    const body = {
      websiteName: $('cfg-website-name').value.trim(),
      integrationMode: $('cfg-integration-mode').value,
      webhookUrl: $('cfg-webhook-url').value.trim(),
      omnisxUserId: $('cfg-omnisx-user').value.trim(),
      autoForward: $('cfg-auto-forward').checked,
    };
    const authVal = $('cfg-auth-header').value.trim();
    if (authVal) body.webhookAuthHeader = authVal;

    try {
      const cfg = await EngineClient.saveConfig(body);
      state.config = cfg;
      $('cfg-auth-header').value = '';
      showToast('OMNIS-X connection settings saved');
    } catch (err) {
      showToast(`Error: ${err.message}`);
    }
  });

  $('btn-test-webhook').addEventListener('click', async () => {
    const webhookUrl = $('cfg-webhook-url').value.trim();
    const webhookAuthHeader = $('cfg-auth-header').value.trim();
    try {
      const res = await EngineClient.testConnection({ webhookUrl, webhookAuthHeader });
      showToast(res.result);
    } catch (err) {
      showToast(`Connection test failed: ${err.message}`);
    }
  });

  $('btn-export-json').addEventListener('click', () => {
    const blob = new Blob([JSON.stringify(state.grievances, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `omnisx-grievances-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  });

  $('filter-category').addEventListener('change', renderStatusTab);
  $('filter-status').addEventListener('change', renderStatusTab);
  $('filter-search').addEventListener('input', renderStatusTab);
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn, .mobile-nav button').forEach((b) => {
    b.classList.toggle('active', b.dataset.tab === tabId);
  });
  ['report', 'status', 'portal'].forEach((id) => {
    $(`tab-${id}`).style.display = id === tabId ? 'block' : 'none';
  });
}

function initNavigation() {
  document.querySelectorAll('.tab-btn, .mobile-nav button').forEach((b) => {
    b.addEventListener('click', () => switchTab(b.dataset.tab));
  });
}

async function updateQueueBadge() {
  try {
    const q = await getQueuedGrievances();
    $('queue-count').textContent = String(q.length);
    $('btn-sync-queue').style.display = q.length > 0 ? 'inline-flex' : 'none';
  } catch {
    // ignore
  }
}

async function syncQueuedItems() {
  if (!navigator.onLine) return;
  const { synced } = await flushQueue((payload) => EngineClient.submitGrievance(payload));
  await updateQueueBadge();
  if (synced.length > 0) {
    showToast(`Synced ${synced.length} offline report(s)`);
    await Promise.all([refreshData(), refreshAlerts()]);
  }
}

function initConnectivityAndPWA() {
  const updateOnlineStatus = () => {
    const online = navigator.onLine;
    $('conn-dot').classList.toggle('offline', !online);
    $('conn-label').textContent = online ? 'LIVE' : 'OFFLINE';
    if (online && state.user) syncQueuedItems();
  };

  window.addEventListener('online', updateOnlineStatus);
  window.addEventListener('offline', updateOnlineStatus);
  updateOnlineStatus();

  $('btn-sync-queue').addEventListener('click', syncQueuedItems);

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstallPrompt = e;
    $('btn-install-pwa').style.display = 'inline-flex';
  });

  $('btn-install-pwa').addEventListener('click', async () => {
    if (!state.deferredInstallPrompt) return;
    state.deferredInstallPrompt.prompt();
    await state.deferredInstallPrompt.userChoice;
    state.deferredInstallPrompt = null;
    $('btn-install-pwa').style.display = 'none';
  });

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

async function boot() {
  initNavigation();
  initAuth();
  initFormControls();
  initPortalTab();
  init2DMaps();
  initDesktopModeSwitch();
  initConnectivityAndPWA();

  const existingUser = await EngineClient.getMe();
  if (existingUser) {
    await enterAuthenticatedApp(existingUser);
  } else {
    showLoginScreen();
  }
}

boot();
