(() => {
  'use strict';

  /* ---------------- Config ---------------- */
  const SWATCH_COLORS = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00', '#9c36b5', '#ffffff'];
  const GRID_SIZE = 40;
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 8;
  const STROKE_BUFFER_INTERVAL = 30; // ms, throttle for outgoing point batches
  const MIN_BRUSH_SIZE = 1;
  const MAX_BRUSH_SIZE = 50;
  const MAX_POINTS_PER_STROKE = 1000;
  const USERNAME_STORAGE_KEY = 'whiteboard_username';

  const firebaseConfig = {
    apiKey: "AIzaSyDwDXUMF6fFeQO4UfMqvqWRnBHfRsY6YH0",
    authDomain: "global-whiteboard.firebaseapp.com",
    databaseURL: "https://global-whiteboard-default-rtdb.firebaseio.com",
    projectId: "global-whiteboard",
    storageBucket: "global-whiteboard.firebasestorage.app",
    messagingSenderId: "778477116998",
    appId: "1:778477116998:web:f805aa340abb04470c3447",
    measurementId: "G-5B5HVLNM5P"
  };

  /* ---------------- Validation helpers ---------------- */
  function isValidNumber(n) {
    return typeof n === 'number' && Number.isFinite(n) && !Number.isNaN(n);
  }

  function isValidPoint(p) {
    return p && isValidNumber(p.x) && isValidNumber(p.y);
  }

  function clampBrushSize(size) {
    let s = parseFloat(size);
    if (!isValidNumber(s)) s = MIN_BRUSH_SIZE;
    return Math.min(MAX_BRUSH_SIZE, Math.max(MIN_BRUSH_SIZE, s));
  }

  function sanitizeUsername(name) {
    if (typeof name !== 'string') return '';
    return name.trim().slice(0, 20);
  }

  /* ---------------- State ---------------- */
  const state = {
    tool: 'pen',
    color: '#1e1e1e',
    size: 4,
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    isDrawing: false,
    isPanning: false,
    lastPanPoint: null,
    currentStroke: null,
    strokes: [],     // committed strokes {id, owner, ownerName, tool, color, size, points:[{x,y}]}
    redoStack: [],
    localUserId: null,
    username: '',
    remoteUsers: new Map(), // userId -> {color, name, lastPoint, el, activeStroke}
    onlineUsers: new Map(), // userId -> {name, color}
    pendingPoints: [],
  };

  /* ---------------- DOM ---------------- */
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const canvasWrap = document.getElementById('canvasWrap');
  const cursorsLayer = document.getElementById('cursorsLayer');
  const colorPicker = document.getElementById('colorPicker');
  const swatchesEl = document.getElementById('swatches');
  const sizeSlider = document.getElementById('sizeSlider');
  const sizeValue = document.getElementById('sizeValue');
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  const zoomInBtn = document.getElementById('zoomInBtn');
  const zoomOutBtn = document.getElementById('zoomOutBtn');
  const resetViewBtn = document.getElementById('resetViewBtn');
  const zoomValue = document.getElementById('zoomValue');
  const toolIndicator = document.getElementById('toolIndicator');
  const userCountEl = document.getElementById('userCount');
  const toolButtons = document.querySelectorAll('.tool-btn');
  const chatSidebar = document.getElementById('chatSidebar');
  const chatToggle = document.getElementById('chatToggle');
  const usersToggle = document.getElementById('usersToggle');
  const usersPanel = document.getElementById('usersPanel');
  const usersPanelClose = document.getElementById('usersPanelClose');
  const usersList = document.getElementById('usersList');
  const settingsBtn = document.getElementById('settingsBtn');
  const usernameModalOverlay = document.getElementById('usernameModalOverlay');
  const usernameInput = document.getElementById('usernameInput');
  const usernameSubmit = document.getElementById('usernameSubmit');

  /* ---------------- Username handling ---------------- */
  function loadStoredUsername() {
    try {
      return sanitizeUsername(localStorage.getItem(USERNAME_STORAGE_KEY) || '');
    } catch (e) {
      return '';
    }
  }

  function storeUsername(name) {
    try {
      localStorage.setItem(USERNAME_STORAGE_KEY, name);
    } catch (e) {}
  }

  function openUsernameModal(prefill) {
    usernameInput.value = prefill || '';
    usernameModalOverlay.classList.add('visible');
    setTimeout(() => usernameInput.focus(), 50);
  }

  function closeUsernameModal() {
    usernameModalOverlay.classList.remove('visible');
  }

  function commitUsername(rawName) {
    const name = sanitizeUsername(rawName) || ('Guest' + Math.floor(Math.random() * 1000));
    state.username = name;
    storeUsername(name);
    closeUsernameModal();
    if (network) network.updateUsername(name);
  }

  usernameSubmit.addEventListener('click', () => commitUsername(usernameInput.value));
  usernameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') commitUsername(usernameInput.value);
  });

  settingsBtn.addEventListener('click', () => {
    openUsernameModal(state.username);
  });

  /* ---------------- Networking (Firebase Realtime Database) ---------------- */
  class Network {
    constructor(username) {
      this.userId = 'user-' + Math.random().toString(36).slice(2, 9);
      this.userColor = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
      this.username = username;
      this.handlers = {};

      firebase.initializeApp(firebaseConfig);
      this.db = firebase.database();

      this.strokesRef = this.db.ref('whiteboard/strokes');
      this.eventsRef = this.db.ref('whiteboard/events');
      this.presenceRef = this.db.ref('whiteboard/presence');
      this.cursorsRef = this.db.ref('whiteboard/cursors');
      this.myPresenceRef = this.presenceRef.child(this.userId);
      this.myCursorRef = this.cursorsRef.child(this.userId);

      this._setupPresence();
      this._setupStrokesSync();
      this._setupEventsSync();
      this._setupCursorsSync();
    }

    on(type, cb) {
      this.handlers[type] = cb;
    }

    /* ---- Presence ---- */
    _setupPresence() {
      this.db.ref('.info/connected').on('value', (snap) => {
        if (snap.val() === true) {
          this.myPresenceRef.onDisconnect().remove();
          this.myPresenceRef.set({
            online: true,
            name: this.username,
            color: this.userColor,
            ts: firebase.database.ServerValue.TIMESTAMP
          });
          this.myCursorRef.onDisconnect().remove();
        }
      });

      this.presenceRef.on('value', (snap) => {
        const val = snap.val() || {};
        if (this.handlers['presence-update']) this.handlers['presence-update'](val);
      });

      this.presenceRef.on('child_removed', (snap) => {
        const userId = snap.key;
        if (this.handlers['peer-leave']) this.handlers['peer-leave'](userId);
      });
    }

    updateUsername(name) {
      this.username = name;
      this.myPresenceRef.update({ name });
    }

    /* ---- Cursors ---- */
    _setupCursorsSync() {
      const handleCursor = (snap) => {
        const userId = snap.key;
        if (userId === this.userId) return;
        const data = snap.val();
        if (data && this.handlers['cursor']) {
          this.handlers['cursor']({ userId, x: data.x, y: data.y, color: data.color, name: data.name });
        }
      };
      this.cursorsRef.on('child_changed', handleCursor);
      this.cursorsRef.on('child_added', handleCursor);
    }

    sendCursor(x, y) {
      if (!isValidNumber(x) || !isValidNumber(y)) return;
      this.myCursorRef.set({ x, y, color: this.userColor, name: this.username, ts: firebase.database.ServerValue.TIMESTAMP });
    }

    /* ---- Strokes (committed, persistent) ---- */
    _setupStrokesSync() {
      this.strokesRef.on('child_added', (snap) => {
        const stroke = snap.val();
        if (!stroke) return;
        if (stroke.owner === this.userId) return;
        if (this.handlers['remote-stroke-added']) this.handlers['remote-stroke-added'](stroke);
      });

      this.strokesRef.on('child_removed', (snap) => {
        const stroke = snap.val();
        if (!stroke) return;
        if (this.handlers['undo']) this.handlers['undo']({ strokeId: stroke.id });
      });

      this.strokesRef.once('value', (snap) => {
        const val = snap.val() || {};
        const strokes = Object.values(val);
        if (this.handlers['initial-strokes']) this.handlers['initial-strokes'](strokes);
      });
    }

    /* ---- Live in-progress events (start/points/end) ---- */
    _setupEventsSync() {
      this.eventsRef.on('child_added', (snap) => {
        const msg = snap.val();
        if (!msg || msg.userId === this.userId) return;
        if (msg.type && this.handlers[msg.type]) {
          this.handlers[msg.type](msg);
        }
        snap.ref.remove();
      });
    }

    _pushEvent(msg) {
      this.eventsRef.push({ ...msg, ts: firebase.database.ServerValue.TIMESTAMP });
    }

    sendStrokeStart(stroke) {
      this._pushEvent({ type: 'stroke-start', userId: this.userId, stroke });
    }
    sendStrokePoints(strokeId, points) {
      this._pushEvent({ type: 'stroke-points', userId: this.userId, strokeId, points });
    }
    sendStrokeEnd(strokeId) {
      this._pushEvent({ type: 'stroke-end', userId: this.userId, strokeId });
    }

    /* ---- Committed stroke persistence ---- */
    commitStroke(stroke) {
      this.strokesRef.child(stroke.id).set(stroke);
    }

    removeStroke(strokeId) {
      this.strokesRef.child(strokeId).remove();
    }

    sendUndo(strokeId) {
      this.removeStroke(strokeId);
    }

    sendRedo(stroke) {
      this.commitStroke(stroke);
    }
  }

  let network = null;
  state.localUserId = null;

  /* ---------------- Canvas sizing / DPI ---------------- */
  function resizeCanvas() {
    const rect = canvasWrap.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    render();
  }
  window.addEventListener('resize', resizeCanvas);

  /* ---------------- Coordinate transforms ---------------- */
  function screenToWorld(x, y) {
    return {
      x: (x - state.offsetX) / state.scale,
      y: (y - state.offsetY) / state.scale,
    };
  }

  function getPointerPos(e) {
    const rect = canvasWrap.getBoundingClientRect();
    const clientX = e.touches ? e.touches[0].clientX : e.clientX;
    const clientY = e.touches ? e.touches[0].clientY : e.clientY;
    return { x: clientX - rect.left, y: clientY - rect.top };
  }

  /* ---------------- Rendering ---------------- */
  function clearCanvasPixels() {
    const rect = canvasWrap.getBoundingClientRect();
    ctx.save();
    ctx.setTransform(window.devicePixelRatio || 1, 0, 0, window.devicePixelRatio || 1, 0, 0);
    ctx.clearRect(0, 0, rect.width, rect.height);
    ctx.restore();
  }

  function drawGrid() {
    const rect = canvasWrap.getBoundingClientRect();
    ctx.save();
    ctx.strokeStyle = getComputedColor('--grid-line');
    ctx.lineWidth = 1;
    const step = GRID_SIZE * state.scale;
    if (step < 6) { ctx.restore(); return; }
    const offX = state.offsetX % step;
    const offY = state.offsetY % step;
    ctx.beginPath();
    for (let x = offX; x < rect.width; x += step) {
      ctx.moveTo(x, 0);
      ctx.lineTo(x, rect.height);
    }
    for (let y = offY; y < rect.height; y += step) {
      ctx.moveTo(0, y);
      ctx.lineTo(rect.width, y);
    }
    ctx.stroke();
    ctx.restore();
  }

  let gridColorCache = null;
  function getComputedColor(varName) {
    if (gridColorCache) return gridColorCache;
    gridColorCache = getComputedStyle(document.documentElement).getPropertyValue(varName).trim();
    return gridColorCache;
  }

  function strokeToPath(strokeObj) {
    const pts = strokeObj.points;
    if (!pts || pts.length === 0) return;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.globalCompositeOperation = strokeObj.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = strokeObj.color;
    ctx.lineWidth = clampBrushSize(strokeObj.size) * state.scale;

    ctx.beginPath();
    const p0 = worldToScreen(pts[0]);
    ctx.moveTo(p0.x, p0.y);
    if (pts.length === 1) {
      ctx.lineTo(p0.x + 0.1, p0.y + 0.1);
    } else {
      for (let i = 1; i < pts.length; i++) {
        const p = worldToScreen(pts[i]);
        ctx.lineTo(p.x, p.y);
      }
    }
    ctx.stroke();
    ctx.restore();
  }

  function worldToScreen(p) {
    return {
      x: p.x * state.scale + state.offsetX,
      y: p.y * state.scale + state.offsetY,
    };
  }

  let renderQueued = false;
  function render() {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      clearCanvasPixels();
      drawGrid();
      for (const s of state.strokes) strokeToPath(s);
      if (state.currentStroke) strokeToPath(state.currentStroke);
      for (const [, peer] of state.remoteUsers) {
        if (peer.activeStroke) strokeToPath(peer.activeStroke);
      }
    });
  }

  /* ---------------- Drawing logic (local) ---------------- */
  function genId() {
    return state.localUserId + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  }

  function startStroke(worldPoint) {
    if (!isValidPoint(worldPoint)) return;
    const size = clampBrushSize(state.tool === 'eraser' ? Math.max(state.size * 2, 10) : state.size);
    const stroke = {
      id: genId(),
      owner: state.localUserId,
      ownerName: state.username,
      tool: state.tool,
      color: state.tool === 'eraser' ? '#000000' : state.color,
      size: size,
      points: [worldPoint],
    };
    state.currentStroke = stroke;
    state.pendingPoints = [];
    network.sendStrokeStart({
      id: stroke.id, owner: stroke.owner, ownerName: stroke.ownerName,
      tool: stroke.tool, color: stroke.color, size: stroke.size, points: [worldPoint]
    });
  }

  function addPointToStroke(worldPoint) {
    if (!state.currentStroke) return;
    if (!isValidPoint(worldPoint)) return;
    const pts = state.currentStroke.points;
    const last = pts[pts.length - 1];
    const dist = Math.hypot(worldPoint.x - last.x, worldPoint.y - last.y);
    if (dist < 0.5 / state.scale) return; // skip negligible movement

    if (pts.length >= MAX_POINTS_PER_STROKE) {
      // split: finalize current stroke and start a new one continuing from last point
      flushPendingPoints();
      const finished = state.currentStroke;
      state.strokes.push(finished);
      network.sendStrokeEnd(finished.id);
      network.commitStroke(finished);

      const continuation = {
        id: genId(),
        owner: finished.owner,
        ownerName: finished.ownerName,
        tool: finished.tool,
        color: finished.color,
        size: finished.size,
        points: [last, worldPoint],
      };
      state.currentStroke = continuation;
      state.pendingPoints = [worldPoint];
      network.sendStrokeStart({
        id: continuation.id, owner: continuation.owner, ownerName: continuation.ownerName,
        tool: continuation.tool, color: continuation.color, size: continuation.size,
        points: [last, worldPoint]
      });
      render();
      return;
    }

    pts.push(worldPoint);
    state.pendingPoints.push(worldPoint);
    render();
  }

  function flushPendingPoints() {
    if (state.currentStroke && state.pendingPoints.length > 0) {
      network.sendStrokePoints(state.currentStroke.id, state.pendingPoints);
      state.pendingPoints = [];
    }
  }
  setInterval(flushPendingPoints, STROKE_BUFFER_INTERVAL);

  function endStroke() {
    if (!state.currentStroke) return;
    flushPendingPoints();
    const finished = state.currentStroke;
    state.strokes.push(finished);
    state.redoStack = [];
    network.sendStrokeEnd(finished.id);
    network.commitStroke(finished);
    state.currentStroke = null;
    render();
  }

  /* ---------------- Pointer / touch events ---------------- */
  function onPointerDown(e) {
    if (!network || !state.username) return;
    if (e.button !== undefined && e.button !== 0 && e.type === 'mousedown') return;
    const pos = getPointerPos(e);

    if (state.tool === 'pan' || (e.type === 'mousedown' && e.button === 1)) {
      state.isPanning = true;
      state.lastPanPoint = pos;
      canvasWrap.style.cursor = 'grabbing';
      return;
    }

    state.isDrawing = true;
    const world = screenToWorld(pos.x, pos.y);
    startStroke(world);
    render();
  }

  function onPointerMove(e) {
    if (!network) return;
    const pos = getPointerPos(e);

    if (state.isPanning && state.lastPanPoint) {
      const dx = pos.x - state.lastPanPoint.x;
      const dy = pos.y - state.lastPanPoint.y;
      state.offsetX += dx;
      state.offsetY += dy;
      state.lastPanPoint = pos;
      render();
      return;
    }

    if (state.isDrawing) {
      const world = screenToWorld(pos.x, pos.y);
      addPointToStroke(world);
    }

    const world = screenToWorld(pos.x, pos.y);
    network.sendCursor(world.x, world.y);
  }

  function onPointerUp() {
    if (state.isPanning) {
      state.isPanning = false;
      state.lastPanPoint = null;
      canvasWrap.style.cursor = state.tool === 'pan' ? 'grab' : 'crosshair';
      return;
    }
    if (state.isDrawing) {
      state.isDrawing = false;
      endStroke();
    }
  }

  canvasWrap.addEventListener('mousedown', onPointerDown);
  window.addEventListener('mousemove', onPointerMove);
  window.addEventListener('mouseup', onPointerUp);

  canvasWrap.addEventListener('touchstart', (e) => { e.preventDefault(); onPointerDown(e); }, { passive: false });
  canvasWrap.addEventListener('touchmove', (e) => { e.preventDefault(); onPointerMove(e); }, { passive: false });
  canvasWrap.addEventListener('touchend', (e) => { e.preventDefault(); onPointerUp(e); }, { passive: false });
  canvasWrap.addEventListener('touchcancel', (e) => { e.preventDefault(); onPointerUp(e); }, { passive: false });

  /* ---------------- Zoom ---------------- */
  function zoomAt(screenX, screenY, factor) {
    const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, state.scale * factor));
    const worldBefore = screenToWorld(screenX, screenY);
    state.scale = newScale;
    state.offsetX = screenX - worldBefore.x * state.scale;
    state.offsetY = screenY - worldBefore.y * state.scale;
    zoomValue.textContent = Math.round(state.scale * 100) + '%';
    render();
  }

  canvasWrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const pos = getPointerPos(e);
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    zoomAt(pos.x, pos.y, factor);
  }, { passive: false });

  zoomInBtn.addEventListener('click', () => {
    const rect = canvasWrap.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, 1.2);
  });
  zoomOutBtn.addEventListener('click', () => {
    const rect = canvasWrap.getBoundingClientRect();
    zoomAt(rect.width / 2, rect.height / 2, 0.8);
  });
  resetViewBtn.addEventListener('click', () => {
    state.scale = 1;
    state.offsetX = 0;
    state.offsetY = 0;
    zoomValue.textContent = '100%';
    render();
  });

  /* ---------------- Pinch zoom (touch) ---------------- */
  let pinchStartDist = null;
  let pinchStartScale = 1;
  canvasWrap.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      state.isDrawing = false;
      const [a, b] = e.touches;
      pinchStartDist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      pinchStartScale = state.scale;
    }
  }, { passive: false });
  canvasWrap.addEventListener('touchmove', (e) => {
    if (e.touches.length === 2 && pinchStartDist) {
      const [a, b] = e.touches;
      const dist = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const rect = canvasWrap.getBoundingClientRect();
      const cx = (a.clientX + b.clientX) / 2 - rect.left;
      const cy = (a.clientY + b.clientY) / 2 - rect.top;
      const targetScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinchStartScale * (dist / pinchStartDist)));
      const factor = targetScale / state.scale;
      zoomAt(cx, cy, factor);
    }
  }, { passive: false });
  canvasWrap.addEventListener('touchend', (e) => {
    if (e.touches.length < 2) pinchStartDist = null;
  });

  /* ---------------- Toolbar UI ---------------- */
  function setTool(tool) {
    state.tool = tool;
    toolButtons.forEach(b => b.classList.toggle('active', b.dataset.tool === tool));
    toolIndicator.textContent = tool.charAt(0).toUpperCase() + tool.slice(1);
    canvasWrap.style.cursor = tool === 'pan' ? 'grab' : 'crosshair';
  }

  toolButtons.forEach(btn => {
    btn.addEventListener('click', () => setTool(btn.dataset.tool));
  });

  function buildSwatches() {
    SWATCH_COLORS.forEach((c, i) => {
      const el = document.createElement('div');
      el.className = 'swatch';
      el.style.background = c;
      if (c === '#ffffff') el.style.boxShadow = '0 0 0 1px #ccc';
      if (i === 0) el.classList.add('active');
      el.addEventListener('click', () => {
        state.color = c;
        colorPicker.value = c;
        document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
        el.classList.add('active');
        if (state.tool === 'eraser') setTool('pen');
      });
      swatchesEl.appendChild(el);
    });
  }
  buildSwatches();

  colorPicker.addEventListener('input', (e) => {
    state.color = e.target.value;
    document.querySelectorAll('.swatch').forEach(s => s.classList.remove('active'));
    if (state.tool === 'eraser') setTool('pen');
  });

  sizeSlider.addEventListener('input', (e) => {
    state.size = clampBrushSize(e.target.value);
    sizeValue.textContent = state.size;
  });

  undoBtn.addEventListener('click', () => {
    for (let i = state.strokes.length - 1; i >= 0; i--) {
      if (state.strokes[i].owner === state.localUserId) {
        const removed = state.strokes.splice(i, 1)[0];
        state.redoStack.push(removed);
        network.sendUndo(removed.id);
        render();
        break;
      }
    }
  });

  redoBtn.addEventListener('click', () => {
    for (let i = state.redoStack.length - 1; i >= 0; i--) {
      if (state.redoStack[i].owner === state.localUserId) {
        const restored = state.redoStack.splice(i, 1)[0];
        state.strokes.push(restored);
        network.sendRedo(restored);
        render();
        break;
      }
    }
  });

  /* ---------------- Keyboard shortcuts ---------------- */
  window.addEventListener('keydown', (e) => {
    const tag = document.activeElement && document.activeElement.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA') return;

    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
      e.preventDefault();
      undoBtn.click();
    } else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) {
      e.preventDefault();
      redoBtn.click();
    } else if (e.key === 'p' || e.key === 'P') {
      setTool('pen');
    } else if (e.key === 'e' || e.key === 'E') {
      setTool('eraser');
    } else if (e.key === 'h' || e.key === 'H' || e.key === ' ') {
      setTool('pan');
    }
  });

  /* ---------------- Chat sidebar toggle ---------------- */
  chatToggle.addEventListener('click', () => {
    chatSidebar.classList.toggle('collapsed');
    chatToggle.textContent = chatSidebar.classList.contains('collapsed') ? '⮜' : '⮞';
  });

  /* ---------------- Online users panel ---------------- */
  usersToggle.addEventListener('click', () => {
    usersPanel.classList.toggle('collapsed');
  });
  usersPanelClose.addEventListener('click', () => {
    usersPanel.classList.add('collapsed');
  });

  function renderUsersList() {
    usersList.innerHTML = '';
    const entries = Array.from(state.onlineUsers.entries());
    entries.sort((a, b) => {
      if (a[0] === state.localUserId) return -1;
      if (b[0] === state.localUserId) return 1;
      return (a[1].name || '').localeCompare(b[1].name || '');
    });
    for (const [userId, info] of entries) {
      const li = document.createElement('li');
      li.className = 'users-list-item';
      const dot = document.createElement('span');
      dot.className = 'user-color-dot';
      dot.style.background = info.color || '#999';
      const name = document.createElement('span');
      name.className = 'user-name' + (userId === state.localUserId ? ' is-you' : '');
      name.textContent = (info.name || 'Guest') + (userId === state.localUserId ? ' (you)' : '');
      li.appendChild(dot);
      li.appendChild(name);
      usersList.appendChild(li);
    }
    userCountEl.textContent = Math.max(entries.length, 1);
  }

  /* ---------------- Remote cursors ---------------- */
  function ensureCursorEl(userId, color, name) {
    let peer = state.remoteUsers.get(userId);
    if (!peer) {
      const el = document.createElement('div');
      el.className = 'remote-cursor';
      const dot = document.createElement('div');
      dot.className = 'dot-cursor';
      dot.style.background = color;
      const label = document.createElement('div');
      label.className = 'label';
      label.style.background = color;
      label.textContent = name || userId.slice(0, 10);
      el.appendChild(dot);
      el.appendChild(label);
      cursorsLayer.appendChild(el);
      peer = { color, name, el, label, activeStroke: null };
      state.remoteUsers.set(userId, peer);
    } else if (name && peer.name !== name) {
      peer.name = name;
      peer.label.textContent = name;
    }
    return peer;
  }

  function removeCursorEl(userId) {
    const peer = state.remoteUsers.get(userId);
    if (peer && peer.el) peer.el.remove();
    state.remoteUsers.delete(userId);
  }

  /* ---------------- Network setup / event handlers ---------------- */
  function setupNetworkHandlers() {
    network.on('presence-update', (presenceMap) => {
      state.onlineUsers.clear();
      for (const [userId, info] of Object.entries(presenceMap)) {
        state.onlineUsers.set(userId, { name: info.name || 'Guest', color: info.color || '#999' });
      }
      renderUsersList();
    });

    network.on('peer-leave', (userId) => {
      removeCursorEl(userId);
      state.onlineUsers.delete(userId);
      renderUsersList();
      render();
    });

    network.on('cursor', (msg) => {
      const peer = ensureCursorEl(msg.userId, msg.color, msg.name);
      const screen = worldToScreen({ x: msg.x, y: msg.y });
      peer.el.style.left = screen.x + 'px';
      peer.el.style.top = screen.y + 'px';
    });

    network.on('stroke-start', (msg) => {
      if (!msg.stroke || !Array.isArray(msg.stroke.points)) return;
      const validPoints = msg.stroke.points.filter(isValidPoint);
      if (validPoints.length === 0) return;
      const peer = ensureCursorEl(msg.userId, msg.stroke.color === '#000000' ? '#999' : msg.stroke.color, msg.stroke.ownerName);
      peer.activeStroke = {
        id: msg.stroke.id,
        owner: msg.stroke.owner,
        ownerName: msg.stroke.ownerName,
        tool: msg.stroke.tool,
        color: msg.stroke.color,
        size: clampBrushSize(msg.stroke.size),
        points: validPoints,
      };
      render();
    });

    network.on('stroke-points', (msg) => {
      const peer = state.remoteUsers.get(msg.userId);
      if (peer && peer.activeStroke && peer.activeStroke.id === msg.strokeId && Array.isArray(msg.points)) {
        const validPoints = msg.points.filter(isValidPoint);
        const remaining = MAX_POINTS_PER_STROKE - peer.activeStroke.points.length;
        if (remaining > 0) {
          peer.activeStroke.points.push(...validPoints.slice(0, remaining));
        }
        render();
      }
    });

    network.on('stroke-end', (msg) => {
      const peer = state.remoteUsers.get(msg.userId);
      if (peer && peer.activeStroke) {
        peer.activeStroke = null;
        render();
      }
    });

    network.on('remote-stroke-added', (stroke) => {
      if (!stroke || !Array.isArray(stroke.points)) return;
      const validPoints = stroke.points.filter(isValidPoint).slice(0, MAX_POINTS_PER_STROKE);
      if (validPoints.length === 0) return;
      if (!state.strokes.find(s => s.id === stroke.id)) {
        state.strokes.push({ ...stroke, size: clampBrushSize(stroke.size), points: validPoints });
        render();
      }
    });

    network.on('initial-strokes', (strokes) => {
      const existingIds = new Set(state.strokes.map(s => s.id));
      for (const s of strokes) {
        if (!s || !Array.isArray(s.points)) continue;
        const validPoints = s.points.filter(isValidPoint).slice(0, MAX_POINTS_PER_STROKE);
        if (validPoints.length === 0) continue;
        if (!existingIds.has(s.id)) {
          state.strokes.push({ ...s, size: clampBrushSize(s.size), points: validPoints });
        }
      }
      render();
    });

    network.on('undo', (msg) => {
      const idx = state.strokes.findIndex(s => s.id === msg.strokeId);
      if (idx !== -1) state.strokes.splice(idx, 1);
      render();
    });

    network.on('redo', (msg) => {
      if (msg && msg.stroke && !state.strokes.find(s => s.id === msg.stroke.id)) {
        state.strokes.push(msg.stroke);
        render();
      }
    });
  }

  /* ---------------- Init ---------------- */
  function startApp(username) {
    state.username = username;
    network = new Network(username);
    state.localUserId = network.userId;
    setupNetworkHandlers();
    resizeCanvas();
    setTool('pen');
    sizeValue.textContent = state.size;
    userCountEl.textContent = 1;
  }

  function init() {
    const stored = loadStoredUsername();
    if (stored) {
      startApp(stored);
    } else {
      openUsernameModal('');
      const originalCommit = commitUsername;
      usernameSubmit.removeEventListener('click', () => {});
      usernameSubmit.onclick = () => {
        const name = sanitizeUsername(usernameInput.value) || ('Guest' + Math.floor(Math.random() * 1000));
        state.username = name;
        storeUsername(name);
        closeUsernameModal();
        if (!network) {
          startApp(name);
        } else {
          network.updateUsername(name);
        }
      };
      usernameInput.onkeydown = (e) => {
        if (e.key === 'Enter') usernameSubmit.onclick();
      };
    }
  }

  init();
})();