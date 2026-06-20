(() => {
  'use strict';

  /* ---------------- Config ---------------- */
  const SWATCH_COLORS = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00', '#9c36b5', '#ffffff'];
  const GRID_SIZE = 40;
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 8;
  const STROKE_BUFFER_INTERVAL = 30; // ms, throttle for outgoing point batches

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
    strokes: [],     // committed strokes {id, owner, tool, color, size, points:[{x,y}]}
    redoStack: [],
    localUserId: null,
    remoteUsers: new Map(), // userId -> {color, lastPoint, el}
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
  const clearBtn = document.getElementById('clearBtn');
  const zoomInBtn = document.getElementById('zoomInBtn');
  const zoomOutBtn = document.getElementById('zoomOutBtn');
  const resetViewBtn = document.getElementById('resetViewBtn');
  const zoomValue = document.getElementById('zoomValue');
  const toolIndicator = document.getElementById('toolIndicator');
  const userCountEl = document.getElementById('userCount');
  const toolButtons = document.querySelectorAll('.tool-btn');
  const chatSidebar = document.getElementById('chatSidebar');
  const chatToggle = document.getElementById('chatToggle');

  /* ---------------- Networking (Firebase Realtime Database) ----------------
     Same public interface as before (network.send*, network.on(...)),
     so drawing logic below is untouched. Internals now talk to
     Firebase RTDB instead of BroadcastChannel.
  ------------------------------------------------------------ */
  class Network {
    constructor() {
      this.userId = 'user-' + Math.random().toString(36).slice(2, 9);
      this.userColor = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
      this.handlers = {};

      firebase.initializeApp(firebaseConfig);
      this.db = firebase.database();

      this.strokesRef = this.db.ref('whiteboard/strokes');
      this.eventsRef = this.db.ref('whiteboard/events');
      this.presenceRef = this.db.ref('whiteboard/presence');
      this.cursorsRef = this.db.ref('whiteboard/cursors');
      this.myPresenceRef = this.presenceRef.child(this.userId);
      this.myCursorRef = this.cursorsRef.child(this.userId);

      this._activeRemoteStrokeKeys = new Map(); // strokeId -> dbKey
      this._initialStrokesLoaded = false;

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
          this.myPresenceRef.set({ online: true, ts: firebase.database.ServerValue.TIMESTAMP });
          this.myCursorRef.onDisconnect().remove();
        }
      });

      this.presenceRef.on('value', (snap) => {
        const val = snap.val() || {};
        const count = Object.keys(val).length;
        this._emitPeerCount(count);
      });

      this.presenceRef.on('child_removed', (snap) => {
        const userId = snap.key;
        if (this.handlers['peer-leave']) this.handlers['peer-leave'](userId);
      });
    }

    _emitPeerCount(count) {
      if (this.handlers['peer-count']) this.handlers['peer-count'](count);
    }

    /* ---- Cursors ---- */
    _setupCursorsSync() {
      this.cursorsRef.on('child_changed', (snap) => {
        const userId = snap.key;
        if (userId === this.userId) return;
        const data = snap.val();
        if (data && this.handlers['cursor']) {
          this.handlers['cursor']({ userId, x: data.x, y: data.y, color: data.color });
        }
      });
      this.cursorsRef.on('child_added', (snap) => {
        const userId = snap.key;
        if (userId === this.userId) return;
        const data = snap.val();
        if (data && this.handlers['cursor']) {
          this.handlers['cursor']({ userId, x: data.x, y: data.y, color: data.color });
        }
      });
    }

    sendCursor(x, y) {
      this.myCursorRef.set({ x, y, color: this.userColor, ts: firebase.database.ServerValue.TIMESTAMP });
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
        this._initialStrokesLoaded = true;
        if (this.handlers['initial-strokes']) this.handlers['initial-strokes'](strokes);
      });
    }

    /* ---- Live in-progress events (start/points/end/clear) ---- */
    _setupEventsSync() {
      this.eventsRef.on('child_added', (snap) => {
        const msg = snap.val();
        if (!msg || msg.userId === this.userId) return;
        if (msg.type && this.handlers[msg.type]) {
          this.handlers[msg.type](msg);
        }
        // auto-clean old events to keep db small
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

    sendClear() {
      this.strokesRef.remove();
      this._pushEvent({ type: 'clear', userId: this.userId });
    }

    sendUndo(strokeId) {
      this.removeStroke(strokeId);
    }

    sendRedo(stroke) {
      this.commitStroke(stroke);
    }
  }

  const network = new Network();
  state.localUserId = network.userId;

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
    ctx.lineWidth = strokeObj.size * state.scale;

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
    const stroke = {
      id: genId(),
      owner: state.localUserId,
      tool: state.tool,
      color: state.tool === 'eraser' ? '#000000' : state.color,
      size: state.tool === 'eraser' ? Math.max(state.size * 2, 10) : state.size,
      points: [worldPoint],
    };
    state.currentStroke = stroke;
    state.pendingPoints = [];
    network.sendStrokeStart({ id: stroke.id, owner: stroke.owner, tool: stroke.tool, color: stroke.color, size: stroke.size, points: [worldPoint] });
  }

  function addPointToStroke(worldPoint) {
    if (!state.currentStroke) return;
    const pts = state.currentStroke.points;
    const last = pts[pts.length - 1];
    const dist = Math.hypot(worldPoint.x - last.x, worldPoint.y - last.y);
    if (dist < 0.5 / state.scale) return; // skip negligible movement
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
    state.size = parseInt(e.target.value, 10);
    sizeValue.textContent = state.size;
  });

  clearBtn.addEventListener('click', () => {
    state.strokes = [];
    state.redoStack = [];
    network.sendClear();
    render();
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
    const last = state.redoStack.pop();
    if (last) {
      state.strokes.push(last);
      network.sendRedo(last);
      render();
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

  /* ---------------- Remote cursors ---------------- */
  function ensureCursorEl(userId, color) {
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
      label.textContent = userId.slice(0, 10);
      el.appendChild(dot);
      el.appendChild(label);
      cursorsLayer.appendChild(el);
      peer = { color, el, activeStroke: null };
      state.remoteUsers.set(userId, peer);
    }
    return peer;
  }

  function removeCursorEl(userId) {
    const peer = state.remoteUsers.get(userId);
    if (peer && peer.el) peer.el.remove();
    state.remoteUsers.delete(userId);
  }

  /* ---------------- Network event handlers ---------------- */
  network.on('peer-count', (count) => {
    userCountEl.textContent = Math.max(count, 1);
  });

  network.on('peer-leave', (userId) => {
    removeCursorEl(userId);
    render();
  });

  network.on('cursor', (msg) => {
    const peer = ensureCursorEl(msg.userId, msg.color);
    const screen = worldToScreen({ x: msg.x, y: msg.y });
    peer.el.style.left = screen.x + 'px';
    peer.el.style.top = screen.y + 'px';
  });

  network.on('stroke-start', (msg) => {
    const peer = ensureCursorEl(msg.userId, msg.stroke.color === '#000000' ? '#999' : msg.stroke.color);
    peer.activeStroke = {
      id: msg.stroke.id,
      owner: msg.stroke.owner,
      tool: msg.stroke.tool,
      color: msg.stroke.color,
      size: msg.stroke.size,
      points: [...msg.stroke.points],
    };
    render();
  });

  network.on('stroke-points', (msg) => {
    const peer = state.remoteUsers.get(msg.userId);
    if (peer && peer.activeStroke && peer.activeStroke.id === msg.strokeId) {
      peer.activeStroke.points.push(...msg.points);
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
    if (!state.strokes.find(s => s.id === stroke.id)) {
      state.strokes.push(stroke);
      render();
    }
  });

  network.on('initial-strokes', (strokes) => {
    const existingIds = new Set(state.strokes.map(s => s.id));
    for (const s of strokes) {
      if (!existingIds.has(s.id)) state.strokes.push(s);
    }
    render();
  });

  network.on('clear', () => {
    state.strokes = [];
    state.redoStack = [];
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

  /* ---------------- Init ---------------- */
  function init() {
    resizeCanvas();
    setTool('pen');
    sizeValue.textContent = state.size;
    userCountEl.textContent = 1;
  }

  init();
})();