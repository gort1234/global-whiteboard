(() => {
  'use strict';

  /* ---------------- Config ---------------- */
  const SWATCH_COLORS = ['#1e1e1e', '#e03131', '#2f9e44', '#1971c2', '#f08c00', '#9c36b5', '#ffffff'];
  const GRID_SIZE = 40;
  const MIN_SCALE = 0.1;
  const MAX_SCALE = 8;
  const STROKE_BUFFER_INTERVAL = 30; // ms, throttle for outgoing point batches

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

  /* ---------------- Networking (pluggable) ----------------
     A minimal local-network abstraction. Replace `Network` internals
     with real WebSocket / WebRTC / Firebase calls without touching
     drawing logic. All outgoing calls go through `network.*`.
     A BroadcastChannel-based implementation is included so that
     multiple browser tabs on this machine sync in realtime,
     simulating multiplayer without a backend.
  ------------------------------------------------------------ */
  class Network {
    constructor() {
      this.userId = 'user-' + Math.random().toString(36).slice(2, 9);
      this.userColor = '#' + Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
      this.channel = ('BroadcastChannel' in window) ? new BroadcastChannel('whiteboard-sync') : null;
      this.handlers = {};
      this.peers = new Map(); // userId -> last seen timestamp
      this.peers.set(this.userId, Date.now());

      if (this.channel) {
        this.channel.onmessage = (e) => this._handleMessage(e.data);
      }

      window.addEventListener('beforeunload', () => this._send({ type: 'leave', userId: this.userId }));

      this._heartbeatInterval = setInterval(() => {
        this._send({ type: 'presence', userId: this.userId });
        this._pruneStalePeers();
      }, 4000);

      this._send({ type: 'presence', userId: this.userId });
      this._send({ type: 'request-state', userId: this.userId });
    }

    on(type, cb) {
      this.handlers[type] = cb;
    }

    _send(msg) {
      if (this.channel) this.channel.postMessage(msg);
    }

    _handleMessage(msg) {
      if (!msg || msg.userId === this.userId && msg.type !== 'state-response-target') {
        // still process presence echoes minimally
      }
      switch (msg.type) {
        case 'presence':
          this.peers.set(msg.userId, Date.now());
          this._emitPeerCount();
          break;
        case 'leave':
          this.peers.delete(msg.userId);
          this._emitPeerCount();
          if (this.handlers['peer-leave']) this.handlers['peer-leave'](msg.userId);
          break;
        case 'request-state':
          if (msg.userId !== this.userId && this.handlers['state-request']) {
            this.handlers['state-request'](msg.userId);
          }
          break;
        case 'state-response':
          if (msg.targetId === this.userId && this.handlers['state-response']) {
            this.handlers['state-response'](msg.payload);
          }
          break;
        case 'stroke-start':
        case 'stroke-points':
        case 'stroke-end':
        case 'clear':
        case 'undo':
        case 'redo':
          if (msg.userId !== this.userId && this.handlers[msg.type]) {
            this.handlers[msg.type](msg);
          }
          break;
        case 'cursor':
          if (msg.userId !== this.userId && this.handlers['cursor']) {
            this.handlers['cursor'](msg);
          }
          break;
      }
    }

    _pruneStalePeers() {
      const now = Date.now();
      let changed = false;
      for (const [id, t] of this.peers) {
        if (now - t > 10000) {
          this.peers.delete(id);
          changed = true;
          if (this.handlers['peer-leave']) this.handlers['peer-leave'](id);
        }
      }
      if (changed) this._emitPeerCount();
    }

    _emitPeerCount() {
      if (this.handlers['peer-count']) this.handlers['peer-count'](this.peers.size);
    }

    sendStrokeStart(stroke) {
      this._send({ type: 'stroke-start', userId: this.userId, stroke });
    }
    sendStrokePoints(strokeId, points) {
      this._send({ type: 'stroke-points', userId: this.userId, strokeId, points });
    }
    sendStrokeEnd(strokeId) {
      this._send({ type: 'stroke-end', userId: this.userId, strokeId });
    }
    sendClear() {
      this._send({ type: 'clear', userId: this.userId });
    }
    sendUndo(strokeId) {
      this._send({ type: 'undo', userId: this.userId, strokeId });
    }
    sendRedo(stroke) {
      this._send({ type: 'redo', userId: this.userId, stroke });
    }
    sendCursor(x, y) {
      this._send({ type: 'cursor', userId: this.userId, x, y, color: this.userColor });
    }
    sendStateResponse(targetId, payload) {
      this._send({ type: 'state-response', userId: this.userId, targetId, payload });
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
    if (pts.length === 0) return;
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
    state.strokes.push(state.currentStroke);
    state.redoStack = [];
    network.sendStrokeEnd(state.currentStroke.id);
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
      state.strokes.push(peer.activeStroke);
      peer.activeStroke = null;
      render();
    }
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
    state.strokes.push(msg.stroke);
    render();
  });

  network.on('state-request', (requesterId) => {
    network.sendStateResponse(requesterId, {
      strokes: state.strokes,
    });
  });

  network.on('state-response', (payload) => {
    if (payload && Array.isArray(payload.strokes) && state.strokes.length === 0) {
      state.strokes = payload.strokes;
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