(() => {
  let data = null;
  let currentIndex = 0;
  let cameraX = 0;
  let cameraY = 0;
  let targetCameraX = 0;
  let targetCameraY = 0;
  const nodes = [];

  // --- Sound & color sequence (2x6 = 12, repeats forever) ---
  let audioCtx = null;

  // // Previous composition (2x5):
  // const TONE_SEQUENCE = [
  //   // Sequence 1
  //   { freq: 739.99, bg: 0, fg: 1 },  // F#5 — gray on black
  //   { freq: 1108.73, bg: 1, fg: 0 }, // C#6 — black on gray
  //   { freq: 1108.73, bg: 1, fg: 0 }, // C#6 — black on gray
  //   { freq: 739.99, bg: 0, fg: 1 },  // F#5 — gray on black
  //   { freq: 987.77, bg: 2, fg: 0 },  // B5  — black on red
  //   // Sequence 2
  //   { freq: 739.99, bg: 0, fg: 1 },  // F#5 — gray on black
  //   { freq: 987.77, bg: 2, fg: 0 },  // B5  — black on red
  //   { freq: 987.77, bg: 2, fg: 0 },  // B5  — black on red
  //   { freq: 739.99, bg: 0, fg: 1 },  // F#5 — gray on black
  //   { freq: 932.33, bg: 2, fg: 0 },  // A#5 — black on red
  // ];

  const TONE_SEQUENCE = [
    // Sequence 1
    { freq: 880.00, bg: 2, fg: 0 },  // A5  — red
    { freq: 783.99, bg: 1, fg: 0 },  // G5  — gray
    { freq: 783.99, bg: 1, fg: 0 },  // G5  — gray
    { freq: 739.99, bg: 2, fg: 0 },  // F#5 — red
    { freq: 659.25, bg: 0, fg: 1 },  // E5  — black
    { freq: 739.99, bg: 2, fg: 0 },  // F#5 — red
    // Sequence 2
    { freq: 880.00, bg: 2, fg: 0 },  // A5  — red
    { freq: 783.99, bg: 1, fg: 0 },  // G5  — gray
    { freq: 783.99, bg: 1, fg: 0 },  // G5  — gray
    { freq: 739.99, bg: 2, fg: 0 },  // F#5 — red
    { freq: 659.25, bg: 0, fg: 1 },  // E5  — black
    { freq: 587.33, bg: 0, fg: 1 },  // D5  — black
  ];

  function ensureAudioCtx() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    return audioCtx;
  }

  function playTone(freq) {
    const ctx = ensureAudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    // Chime envelope: quick attack, gentle decay
    const now = ctx.currentTime;
    gain.gain.setValueAtTime(0, now);
    gain.gain.linearRampToValueAtTime(0.15, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.001, now + 1.2);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 1.2);
  }

  // --- Rain ambience ---
  // Loops an MP3 rain recording. Starts on first click, fades in slowly.
  let rainStarted = false;
  const RAIN_VOLUME = 0.15;
  const RAIN_FADE_IN = 6; // seconds

  function startRain() {
    if (rainStarted) return;
    rainStarted = true;

    const rain = new Audio('rain-lofivision.mp3');
    rain.loop = true;
    rain.volume = 0;
    rain.play();

    // Fade in over RAIN_FADE_IN seconds
    const steps = 60;
    const interval = (RAIN_FADE_IN * 1000) / steps;
    let step = 0;
    const fade = setInterval(() => {
      step++;
      rain.volume = Math.min(RAIN_VOLUME, (step / steps) * RAIN_VOLUME);
      if (step >= steps) clearInterval(fade);
    }, interval);
  }

  // Display canvases
  const canvasBg = document.getElementById('canvas-bg');
  const canvasBgCtx = canvasBg.getContext('2d');
  const canvasImg = document.getElementById('canvas-img');
  const canvasFg = document.getElementById('canvas-fg');
  const canvasFgCtx = canvasFg.getContext('2d');
  const world = document.getElementById('world');
  let rewindBtn = null;

  // Mid canvas for connectors (plain Canvas2D, no WebGL processing)
  const canvasMid = document.getElementById('canvas-mid');
  const ctxMid = canvasMid.getContext('2d');

  // Single shared WebGL pipeline for ALL speck layers (1 context instead of 6).
  // Uses OffscreenCanvas so we can transferToImageBitmap() after each render —
  // this creates a GPU-fenced snapshot that drawImage reads reliably, avoiding
  // the stale-read blinks that occur with direct drawImage from a WebGL canvas.
  // Safari/Firefox don't have this stale-read issue, so we skip the expensive
  // GPU-CPU sync fence and draw directly from the OffscreenCanvas.
  const sharedGlCanvas = new OffscreenCanvas(1, 1);
  const sharedPipeline = createDitherPipeline(sharedGlCanvas);
  const needsBitmapTransfer = /Chrome/.test(navigator.userAgent) && !/Edge/.test(navigator.userAgent);

  // Per-layer offscreen Canvas2D (cheap, no WebGL)
  const speckOffscreens = [];

  // // V2: Image layer
  // const offImg = document.createElement('canvas');
  // const ctxImg = offImg.getContext('2d');
  // const ditherImg = createDitherPipeline(canvasImg);

  const TARGET_SCREEN_Y = 0.55;

  // --- Parallax ---
  let smoothMouseX = 0;
  let smoothMouseY = 0;
  const PARALLAX_FACTOR = 0.25; // parallax as fraction of viewport dimension
  const NODE_DEPTH = 0.55;
  const IMAGE_DEPTH = 0.45; // slightly behind nodes

  // --- Images ---
  const IMAGE_SIZE = 360; // CSS pixels
  const IMAGE_OFFSET_X = -220; // to the left of the node
  const IMAGE_OFFSET_Y = -40; // slightly above center
  const imageCache = {};
  let activeImageAlpha = 0;
  let fadeTo = 0;
  let activeImageNode = null; // which node's image is currently showing

  function preloadImage(src) {
    if (imageCache[src]) return;
    const img = new Image();
    img.src = src;
    imageCache[src] = img;
  }

  // --- Speck layers ---
  // Backup: full 6-layer configuration
  // { depth: 0.10, size: 4,   density: 0.25, opacity: 0.3,  canvas: 'bg', scale: 0.5  },  // L0: far back, tiny
  // { depth: 0.25, size: 8,   density: 0.2,  opacity: 0.35, canvas: 'bg', scale: 0.5  },  // L1: mid-back
  // { depth: 0.40, size: 16,  density: 0.12, opacity: 0.4,  canvas: 'bg', scale: 1    },  // L2: near-back
  // { depth: 0.80, size: 40,  density: 0.06, opacity: 0.3,  canvas: 'fg', scale: 0.5  },  // L3: near-front
  // { depth: 1.20, size: 100, density: 0.03, opacity: 0.2,  canvas: 'fg', scale: 0.25 },  // L4: mid-front
  // { depth: 1.80, size: 240, density: 0.015,opacity: 0.15, canvas: 'fg', scale: 0.125 }, // L5: closest
  // Current 3-layer config (restore after test):
  // { depth: 0.40, size: 8,   density: 0.5,  opacity: 0.3,   canvas: 'bg', scale: 0.25 },  // L2: near-back
  // { depth: 0.80, size: 40,  density: 0.1,  opacity: 0.3,   canvas: 'fg', scale: 0.5  },  // L3: near-front
  // { depth: 1.60, size: 160, density: 0.1,  opacity: 0.15,  canvas: 'fg', scale: 0.25 },  // L4: mid-front
  const SPECK_LAYERS = [
    { depth: 0.25, size: 6,   density: 0.2,  opacity: 0.35, canvas: 'bg', scale: 0.5  },  // L1: mid-back
    { depth: 0.40, size: 8,   density: 0.1,  opacity: 0.4,  canvas: 'bg', scale: 0.5  },  // L2: near-back
    { depth: 0.85, size: 40,  density: 0.03, opacity: 0.3,  canvas: 'fg', scale: 0.25 },  // L3: near-front
    { depth: 1.20, size: 100, density: 0.03, opacity: 0.2,  canvas: 'fg', scale: 0.25 },  // L4: mid-front
    { depth: 1.80, size: 240, density: 0.01, opacity: 0.15, canvas: 'fg', scale: 0.125 }, // L5: closest
  ];
  const BLUR_STRENGTH = 100;
  const SPECK_CELL_SIZE = 120;

  // Exponential blur: gentle near focal plane, extreme at distance
  function depthBlur(depth) {
    const dist = Math.abs(depth - NODE_DEPTH);
    return dist * dist * BLUR_STRENGTH;
  }

  // Initialize per-layer offscreen canvases (Canvas2D only, no WebGL)
  for (let i = 0; i < SPECK_LAYERS.length; i++) {
    const off = document.createElement('canvas');
    const ctx = off.getContext('2d');
    speckOffscreens.push({ off, ctx });
  }

  // Simple seeded PRNG (mulberry32)
  function mulberry32(seed) {
    return function() {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }

  function cellSeed(cx, cy, layerIndex) {
    return (cx * 73856093) ^ (cy * 19349663) ^ (layerIndex * 83492791);
  }

  function getCurrentFg() {
    if (nodes.length === 0) return data.colors[1];
    return nodes[nodes.length - 1].fg;
  }

  function getCurrentBg() {
    if (nodes.length === 0) return data.colors[0];
    return nodes[nodes.length - 1].bg;
  }

  function applyGlobalColors(immediate) {
    targetColorFg = hexToRGB(getCurrentFg());
    targetColorBg = hexToRGB(getCurrentBg());
    if (immediate) {
      liveFg = [...targetColorFg];
      liveBg = [...targetColorBg];
      applyCSSColors();
    }
  }

  function applyCSSColors() {
    const fgHex = rgbToHex(Math.round(liveFg[0]), Math.round(liveFg[1]), Math.round(liveFg[2]));
    const bgHex = rgbToHex(Math.round(liveBg[0]), Math.round(liveBg[1]), Math.round(liveBg[2]));
    document.body.style.backgroundColor = bgHex;
    document.documentElement.style.setProperty('--fg', fgHex);
    document.documentElement.style.setProperty('--bg', bgHex);
  }

  function hexToNorm(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
  }

  function hexToRGB(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  function rgbToHex(r, g, b) {
    return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
  }

  // Color fade state — stored as [r,g,b] for efficient per-frame lerp.
  // Colors only start transitioning once the camera settles after a click,
  // which naturally throttles rapid clicks: each click keeps the camera
  // moving, delaying the fade. Only the final target color is shown.
  let liveFg = [0, 0, 0];
  let liveBg = [0, 0, 0];
  let targetColorFg = [0, 0, 0];
  let targetColorBg = [0, 0, 0];
  // Fade locking: when a fade starts, its goal is snapshot from targets.
  // The fade runs to that goal even if new clicks change the targets.
  // New fades only start when camera settles again after the previous
  // fade completes, so rapid clicking stays on the last completed color.
  let colorFadeActive = false;
  let fadeGoalFg = [0, 0, 0];
  let fadeGoalBg = [0, 0, 0];

  function parallaxOffset(depth) {
    if (!debug.parallax) return { x: 0, y: 0 };
    return {
      x: -smoothMouseX * depth * window.innerWidth * PARALLAX_FACTOR,
      y: -smoothMouseY * depth * window.innerHeight * PARALLAX_FACTOR,
    };
  }

  // Speck pulse: each speck's opacity oscillates on its own slow sine
  // cycle, seeded by cell position so no two specks pulse in sync.
  // Through the dither pipeline, this becomes pixel-level glittering —
  // as opacity drops, fewer pixels survive the blue noise threshold.
  const PULSE_SPEED = 0.0004;  // ~15s full cycle
  const PULSE_DEPTH = 0.3;     // oscillates between 0.7–1.0 of base opacity

  function drawSpeckLayer(ctx, w, h, li, time) {
    const layer = SPECK_LAYERS[li];
    const rs = RENDER_SCALE * layer.scale; // combined scale: render + layer
    const px = parallaxOffset(layer.depth);
    const maxParallax = Math.max(window.innerWidth, window.innerHeight) * PARALLAX_FACTOR;
    const pad = layer.size + maxParallax * layer.depth;

    // Simple 2D cell grid — each cell independently places a speck
    // at a fully random position within its bounds. No column structure.
    const startCX = Math.floor((cameraX - pad - px.x) / SPECK_CELL_SIZE) - 1;
    const endCX = Math.floor((cameraX + w / rs + pad - px.x) / SPECK_CELL_SIZE) + 1;
    const startCY = Math.floor((cameraY - pad - px.y) / SPECK_CELL_SIZE) - 1;
    const endCY = Math.floor((cameraY + h / rs + pad - px.y) / SPECK_CELL_SIZE) + 1;

    const sz = layer.size * rs;

    for (let cx = startCX; cx <= endCX; cx++) {
      for (let cy = startCY; cy <= endCY; cy++) {
        const rng = mulberry32(cellSeed(cx, cy, li));

        if (rng() > layer.density * layerDensityMul[li]) continue;

        // Fully random position within cell
        const worldX = cx * SPECK_CELL_SIZE + rng() * SPECK_CELL_SIZE;
        const worldY = cy * SPECK_CELL_SIZE + rng() * SPECK_CELL_SIZE;

        const screenX = (worldX - cameraX + px.x) * rs;
        const screenY = (worldY - cameraY + px.y) * rs;

        if (screenX < -pad * rs || screenX > w + pad * rs) continue;
        if (screenY < -pad * rs || screenY > h + pad * rs) continue;

        // Per-speck phase from RNG (0–2π), so each glitters independently
        const phase = rng() * 6.2832;
        const pulse = 1.0 - PULSE_DEPTH + PULSE_DEPTH * Math.sin(time * PULSE_SPEED + phase);

        ctx.globalAlpha = layer.opacity * pulse;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(
          Math.round(screenX - sz / 2),
          Math.round(screenY - sz / 2),
          Math.round(sz),
          Math.round(sz)
        );
      }
    }

    ctx.globalAlpha = 1;
  }

  function drawConnectors(ctx) {
    const fg = rgbToHex(Math.round(liveFg[0]), Math.round(liveFg[1]), Math.round(liveFg[2]));
    const px = parallaxOffset(NODE_DEPTH);
    const rs = RENDER_SCALE;
    ctx.strokeStyle = fg;
    ctx.lineWidth = 2;
    ctx.setLineDash([2, 10]);

    for (let i = 1; i < nodes.length; i++) {
      const prev = nodes[i - 1];
      const curr = nodes[i];

      const prevX = Math.round((prev.worldX - cameraX + 6 + px.x) * rs) + 0.5;
      const prevY = Math.round((prev.worldY - cameraY + 6 + px.y) * rs) + 0.5;
      const currX = Math.round((curr.worldX - cameraX + 6 + px.x) * rs) + 0.5;
      const currY = Math.round((curr.worldY - cameraY + 6 + px.y) * rs) + 0.5;

      const midY = prevY + (currY - prevY) * 0.5;

      // Maximum arc radius: half the horizontal distance, clamped so the
      // two arcs don't overlap when vertical space is tight.
      const dx = Math.abs(currX - prevX);
      const dy = Math.abs(currY - prevY);
      const r = Math.min(dx / 2, dy / 2);

      ctx.beginPath();
      ctx.moveTo(prevX, prevY);

      if (dx < 60) {
        // Nodes are nearly aligned — loop out to the side and back
        const loopR = 40;
        // Loop to whichever side has more space from the node dots
        const loopDir = (prevX < ctx.canvas.width / 2) ? -1 : 1;
        const cpX = prevX + loopDir * loopR;
        ctx.bezierCurveTo(cpX, prevY, cpX, currY, currX, currY);
      } else {
        // arcTo handles the straight segments automatically:
        // draws a line to the tangent point, then the arc.
        ctx.arcTo(prevX, midY, currX, midY, r);
        ctx.arcTo(currX, midY, currX, currY, r);
        ctx.lineTo(currX, currY);
      }

      ctx.stroke();
    }

    ctx.setLineDash([]);
  }

  function drawImage(ctx, w, h) {
    if (!activeImageNode || activeImageAlpha < 0.01) return;

    const node = activeImageNode;
    const nodeData = data.nodes[node.index];
    if (!nodeData.image) return;

    const img = imageCache[nodeData.image];
    if (!img || !img.complete) return;

    const px = parallaxOffset(IMAGE_DEPTH);
    const screenX = node.worldX - cameraX + IMAGE_OFFSET_X + px.x;
    const screenY = node.worldY - cameraY + IMAGE_OFFSET_Y + px.y;

    ctx.globalAlpha = activeImageAlpha;
    ctx.drawImage(img, screenX, screenY, IMAGE_SIZE, IMAGE_SIZE);
    ctx.globalAlpha = 1;
  }

  const RENDER_SCALE = 1; // full CSS-pixel resolution (retina handled by browser)

  function resize() {
    const w = Math.ceil(window.innerWidth * RENDER_SCALE);
    const h = Math.ceil(window.innerHeight * RENDER_SCALE);

    canvasBg.width = w;
    canvasBg.height = h;
    canvasFg.width = w;
    canvasFg.height = h;
    canvasMid.width = w;
    canvasMid.height = h;
    for (let i = 0; i < speckOffscreens.length; i++) {
      const s = SPECK_LAYERS[i].scale;
      speckOffscreens[i].off.width = Math.ceil(w * s);
      speckOffscreens[i].off.height = Math.ceil(h * s);
    }

    draw(performance.now());
  }

  async function init() {
    const resp = await fetch('nodes.json');
    data = await resp.json();

    // // V2: Preload all images
    // for (const nd of data.nodes) {
    //   if (nd.image) preloadImage(nd.image);
    // }

    applyQualityTier(); // Start at minimum, progressively enhance

    window.addEventListener('resize', resize);
    window.addEventListener('mousemove', handleMouseMove);

    // Pre-warm: force shader compilation and FBO allocation for all layer sizes
    // before the first visible frame, so the GPU pipeline is hot from the start.
    const warmW = Math.ceil(window.innerWidth);
    const warmH = Math.ceil(window.innerHeight);
    const warmCanvas = document.createElement('canvas');
    warmCanvas.width = 2;
    warmCanvas.height = 2;
    const seen = new Set();
    for (const layer of SPECK_LAYERS) {
      const key = layer.scale;
      if (seen.has(key)) continue;
      seen.add(key);
      sharedPipeline.process(warmCanvas, 0, [1, 1, 1],
        key < 1 ? [warmW, warmH] : null);
    }

    resize();

    const firstX = window.innerWidth * 0.4;
    const firstY = window.innerHeight * TARGET_SCREEN_Y;
    addNode(firstX, firstY, true);

    document.addEventListener('click', handleClick);
    console.log('🔧 Debug keys (Option+key): 1=parallax 2=dither 3=blur D=dom P=pixelated F=freeze 5-9=layers 0=all-layers');
    logDebugState();
    animate();
  }

  // --- Debug toggles (keyboard shortcuts) ---
  // Press keys 1-5 to toggle. Current state logged to console.
  const debug = {
    parallax: true,   // 1: mouse parallax offset
    dither: true,      // 2: WebGL dither pipeline (off = raw Canvas2D specks)
    blur: true,        // 3: Gaussian blur before dither
    dom: true,         // D: DOM nodes (text, dots, connectors)
    pixelated: true,   // P: image-rendering: pixelated on canvases
    freeze: false,     // F: freeze drawing (stop calling draw)
    layers: [true, true, true, true, true], // 5-9: individual speck layers
  };

  function logDebugState() {
    const flags = [
      `parallax:${debug.parallax ? 'ON' : 'OFF'}`,
      `dither:${debug.dither ? 'ON' : 'OFF'}`,
      `blur:${debug.blur ? 'ON' : 'OFF'}`,
      `dom:${debug.dom ? 'ON' : 'OFF'}`,
      `pixelated:${debug.pixelated ? 'ON' : 'OFF'}`,
      `freeze:${debug.freeze ? 'FROZEN' : 'off'}`,
      `layers:[${debug.layers.map((v, i) => v ? i : '-').filter(v => v !== '-').join(',')}]`,
    ];
    console.log('🔧 Debug: ' + flags.join('  '));
  }

  window.addEventListener('keydown', (e) => {
    if (!e.altKey) return; // Option+key on Mac
    const c = e.code;
    if (c === 'Digit1') { debug.parallax = !debug.parallax; logDebugState(); e.preventDefault(); }
    if (c === 'Digit2') { debug.dither = !debug.dither; logDebugState(); e.preventDefault(); }
    if (c === 'Digit3') { debug.blur = !debug.blur; logDebugState(); e.preventDefault(); }
    if (c === 'KeyD') {
      debug.dom = !debug.dom;
      document.getElementById('world').style.display = debug.dom ? '' : 'none';
      document.getElementById('canvas-mid').style.display = debug.dom ? '' : 'none';
      if (rewindBtn) rewindBtn.style.display = debug.dom ? '' : 'none';
      logDebugState();
      e.preventDefault();
    }
    if (c === 'KeyP') {
      debug.pixelated = !debug.pixelated;
      const val = debug.pixelated ? 'pixelated' : 'auto';
      document.querySelectorAll('canvas').forEach(c => {
        c.style.imageRendering = val;
      });
      logDebugState();
      e.preventDefault();
    }
    if (c === 'KeyF') {
      debug.freeze = !debug.freeze;
      logDebugState();
      e.preventDefault();
    }
    if (c === 'Digit0') {
      const allOn = debug.layers.every(v => v);
      debug.layers.fill(!allOn);
      logDebugState();
      e.preventDefault();
    }
    for (let i = 0; i < debug.layers.length; i++) {
      if (c === 'Digit' + (i + 5)) {
        debug.layers[i] = !debug.layers[i];
        logDebugState();
        e.preventDefault();
      }
    }
  });

  let rawMouseX = window.innerWidth * 0.5;
  let rawMouseY = window.innerHeight * 0.5;
  let forceRedraw = true; // ensure first frame draws

  // --- Performance: progressive enhancement ---
  // Starts at minimum quality (fewest, cheapest layers) and adds detail
  // as long as FPS stays above 50. Backs off if FPS drops below 30.
  // Layers are ordered by cost: L2 (scale 1.0) is most expensive,
  // L5 (scale 0.125) is cheapest. We add cheap layers first.
  // Frame skipping is a last resort, only if tier 0 still struggles.
  let frameCount = 0;
  let speckFrameSkip = 1; // 1 = no skip; only enabled as last resort

  let lastFrameTime = 0;
  let frameTimes = [];
  let lastTierCheck = 0;
  let qualityTier = 0;
  let frameSkipFallback = false;
  const MAX_QUALITY_TIER = 5;
  const TIER_CHECK_INTERVAL = 2000; // ms between tier checks
  const originalScales = SPECK_LAYERS.map(l => l.scale);
  const layerOpacity = new Float32Array(SPECK_LAYERS.length).fill(1);
  const layerDensityMul = new Float32Array(SPECK_LAYERS.length).fill(0.5);
  const layerDensityTarget = new Float32Array(SPECK_LAYERS.length).fill(0.5);

  function resizeOffscreens() {
    const w = Math.ceil(window.innerWidth * RENDER_SCALE);
    const h = Math.ceil(window.innerHeight * RENDER_SCALE);
    for (let i = 0; i < speckOffscreens.length; i++) {
      const s = SPECK_LAYERS[i].scale;
      speckOffscreens[i].off.width = Math.ceil(w * s);
      speckOffscreens[i].off.height = Math.ceil(h * s);
    }
  }

  // Tiers add detail progressively:
  //   Phase 1 — add layers (cheapest first), all at half density:
  //     0: L4 + L5 only, density 0.5x
  //     1: L3 + L4 + L5, density 0.5x
  //     2: All 5 layers, density 0.5x
  //   Phase 2 — increase density (foremost first):
  //     3: L4 + L5 density 1.0x
  //     4: L3 + L4 + L5 density 1.0x
  //     5: All density 1.0x (full quality)
  function applyQualityTier() {
    const wasEnabled = debug.layers.slice(); // snapshot before changes

    // Reset everything, then apply current tier
    for (let i = 0; i < SPECK_LAYERS.length; i++) {
      SPECK_LAYERS[i].scale = originalScales[i];
      debug.layers[i] = true;
      layerDensityTarget[i] = 0.5; // default half density
    }
    speckFrameSkip = frameSkipFallback ? 2 : 1;

    switch (qualityTier) {
      case 0: // L4 + L5 only, half density
        debug.layers[0] = false;
        debug.layers[1] = false;
        debug.layers[2] = false;
        break;
      case 1: // L3 + L4 + L5, half density
        debug.layers[0] = false;
        debug.layers[1] = false;
        break;
      case 2: // All 5, half density
        break;
      case 3: // All 5, L4+L5 full density
        layerDensityTarget[3] = 1.0;
        layerDensityTarget[4] = 1.0;
        break;
      case 4: // All 5, L3+L4+L5 full density
        layerDensityTarget[2] = 1.0;
        layerDensityTarget[3] = 1.0;
        layerDensityTarget[4] = 1.0;
        break;
      case 5: // Full quality — all density 1.0x
        for (let i = 0; i < SPECK_LAYERS.length; i++) {
          layerDensityTarget[i] = 1.0;
        }
        break;
    }

    // Fade in newly enabled layers (disabled → enabled)
    for (let i = 0; i < SPECK_LAYERS.length; i++) {
      if (debug.layers[i] && !wasEnabled[i]) {
        layerOpacity[i] = 0;
      }
    }

    resizeOffscreens();
  }

  function checkAdaptiveQuality(now) {
    if (now - lastTierCheck < TIER_CHECK_INTERVAL) return;
    lastTierCheck = now;
    if (frameTimes.length < 30) return;

    const sorted = [...frameTimes].sort((a, b) => a - b);
    const medianDt = sorted[Math.floor(sorted.length / 2)];
    const fps = 1000 / medianDt;

    if (fps > 50) {
      // Performance is good — try adding detail
      if (frameSkipFallback) {
        // Recover from frame-skip first
        frameSkipFallback = false;
        applyQualityTier();
        console.log(`⚡ Frame skip off (${fps.toFixed(1)} fps)`);
      } else if (qualityTier < MAX_QUALITY_TIER) {
        qualityTier++;
        applyQualityTier();
        console.log(`⚡ Quality tier ${qualityTier}/${MAX_QUALITY_TIER} (${fps.toFixed(1)} fps)`);
      }
    } else if (fps < 30) {
      // Performance is bad — reduce detail
      if (qualityTier > 0) {
        qualityTier--;
        applyQualityTier();
        console.log(`⚡ Quality tier ${qualityTier}/${MAX_QUALITY_TIER} (${fps.toFixed(1)} fps)`);
      } else if (!frameSkipFallback) {
        // Already at minimum — last resort: frame skipping
        frameSkipFallback = true;
        speckFrameSkip = 2;
        console.log(`⚡ Frame skip fallback (${fps.toFixed(1)} fps)`);
      }
    }

    frameTimes = [];
  }

  function handleMouseMove(e) {
    rawMouseX = e.clientX;
    rawMouseY = e.clientY;
  }

  function handleClick(e) {
    if (e.target.closest('.node-text') || e.target.closest('#rewind')) return;
    if (rewinding) return;
    if (currentIndex >= data.nodes.length) return;

    const prev = nodes[nodes.length - 1];
    const worldX = e.clientX + cameraX;
    let worldY = e.clientY + cameraY;

    // If clicking below the current node, use click's X but force Y to 100px above
    if (worldY >= prev.worldY - 20) {
      worldY = prev.worldY - 100;
    }

    addNode(worldX, worldY);
    startRain(); // begins on first click, no-op after
    targetCameraX = worldX - window.innerWidth * 0.4;
    targetCameraY = worldY - window.innerHeight * TARGET_SCREEN_Y;
    forceRedraw = true;
  }

  function addNode(worldX, worldY, silent) {
    const nodeData = data.nodes[currentIndex];
    const colors = data.colors;
    const toneIndex = silent ? -1 : currentIndex - 1;
    const tone = toneIndex < 0
      ? { freq: 0, bg: 0, fg: 1 }  // first node: black, silent
      : TONE_SEQUENCE[toneIndex % TONE_SEQUENCE.length];

    if (!silent) playTone(tone.freq);

    const node = {
      worldX,
      worldY,
      bg: colors[tone.bg],
      fg: colors[tone.fg],
      text: nodeData.text,
      index: currentIndex,
    };

    nodes.push(node);

    const el = document.createElement('div');
    el.className = 'node';

    const dot = document.createElement('div');
    dot.className = 'node-dot';

    const text = document.createElement('div');
    text.className = 'node-text';
    text.textContent = node.text;

    el.appendChild(dot);
    el.appendChild(text);
    world.appendChild(el);

    node.el = el;
    currentIndex++;

    applyGlobalColors(silent);

    // // V2: Update active image
    // if (nodeData.image) {
    //   activeImageNode = node;
    //   fadeTo = 1;
    // } else {
    //   fadeTo = 0;
    // }

    if (currentIndex >= data.nodes.length) {
      showRewind();
    }

    updatePositions();
  }

  function showRewind() {
    if (rewindBtn) return;
    rewindBtn = document.createElement('button');
    rewindBtn.id = 'rewind';
    rewindBtn.textContent = 'Be kind, rewind';
    document.body.appendChild(rewindBtn);
    rewindBtn.style.display = 'block';
    rewindBtn.addEventListener('click', doRewind);
  }

  let rewinding = false;
  let rewindProgress = 0;
  let rewindStartX = 0;
  let rewindStartY = 0;
  let rewindNodeCount = 0;
  const REWIND_FRAMES_PER_NODE = 16; // ~0.27s per node at 60fps

  // --- Dissolve system for rewind ---
  // When a node is removed during rewind, its text and dot are rasterized
  // to a canvas and dissolved using the same blue noise threshold pattern
  // as the dither pipeline. Pixels vanish in blue-noise order — the text
  // disintegrates into the same digital grain that makes up the world.
  const dissolvingNodes = [];
  const DISSOLVE_FRAMES = 30; // ~0.5s at 60fps

  function startDissolve(node) {
    const dotSize = 12;
    const textX = 20;
    const textYOff = -8;
    const lineH = 30;
    const maxTextW = 400;
    const font = '300 24px "Public Sans", sans-serif';

    // Measure and wrap text (matching CSS max-width: 400px)
    const measure = document.createElement('canvas').getContext('2d');
    measure.font = font;
    const words = node.text.split(' ');
    const lines = [];
    let line = '';
    for (const word of words) {
      const test = line ? line + ' ' + word : word;
      if (measure.measureText(test).width > maxTextW && line) {
        lines.push(line);
        line = word;
      } else {
        line = test;
      }
    }
    lines.push(line);

    // Size canvas to fit dot + wrapped text
    const textW = Math.max(...lines.map(l => Math.ceil(measure.measureText(l).width)));
    const yShift = -textYOff; // 8: text starts 8px above dot
    const w = textX + textW + 4;
    const h = yShift + Math.max(dotSize, lines.length * lineH) + 4;

    const cvs = document.createElement('canvas');
    cvs.width = w;
    cvs.height = h;
    const ctx = cvs.getContext('2d');

    // Draw dot (white)
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, yShift, dotSize, dotSize);

    // Draw wrapped text (white)
    ctx.font = font;
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'top';
    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], textX, i * lineH);
    }

    // Store original alpha channel
    const imgData = ctx.getImageData(0, 0, w, h);
    const originalAlpha = new Uint8Array(w * h);
    for (let j = 0; j < originalAlpha.length; j++) {
      originalAlpha[j] = imgData.data[j * 4 + 3];
    }

    dissolvingNodes.push({
      worldX: node.worldX,
      worldY: node.worldY,
      canvas: cvs, ctx,
      width: w, height: h,
      originalAlpha,
      progress: 0,
      yShift,
    });
  }

  function tickDissolve() {
    const step = 1 / DISSOLVE_FRAMES;
    for (let i = dissolvingNodes.length - 1; i >= 0; i--) {
      dissolvingNodes[i].progress += step;
      if (dissolvingNodes[i].progress >= 1) {
        dissolvingNodes.splice(i, 1);
      }
    }
  }

  function drawDissolve(ctx) {
    if (dissolvingNodes.length === 0) return;

    const px = parallaxOffset(NODE_DEPTH);
    const fgR = Math.round(liveFg[0]);
    const fgG = Math.round(liveFg[1]);
    const fgB = Math.round(liveFg[2]);

    for (const dn of dissolvingNodes) {
      const w = dn.width;
      const h = dn.height;
      const imgData = new ImageData(w, h);
      const pixels = imgData.data;

      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const idx = y * w + x;
          const alpha = dn.originalAlpha[idx];
          if (alpha === 0) continue;

          // Same blue noise field as the dither pipeline, coords local
          // to the text so the pattern stays stable as camera moves
          const threshold = _blueNoiseData[
            (y % BLUE_NOISE_SIZE) * BLUE_NOISE_SIZE + (x % BLUE_NOISE_SIZE)
          ] / 255;

          if (threshold > dn.progress) {
            const pi = idx * 4;
            pixels[pi]     = fgR;
            pixels[pi + 1] = fgG;
            pixels[pi + 2] = fgB;
            pixels[pi + 3] = alpha;
          }
        }
      }

      dn.ctx.putImageData(imgData, 0, 0);

      const screenX = Math.round(dn.worldX - cameraX + px.x);
      const screenY = Math.round(dn.worldY - cameraY + px.y - dn.yShift);
      ctx.drawImage(dn.canvas, screenX, screenY);
    }
  }

  function doRewind() {
    rewinding = true;
    rewindProgress = 0;
    rewindStartX = cameraX;
    rewindStartY = cameraY;
    rewindNodeCount = nodes.length;
    if (rewindBtn) {
      rewindBtn.style.display = 'none';
    }
    // Lock colors to black bg + gray fg — instant, no fade
    liveFg = hexToRGB(data.colors[1]);
    liveBg = hexToRGB(data.colors[0]);
    targetColorFg = [...liveFg];
    targetColorBg = [...liveBg];
    applyCSSColors();
  }

  function rewindTick() {
    if (!rewinding) return;

    // Advance progress
    const totalFrames = rewindNodeCount * REWIND_FRAMES_PER_NODE;
    rewindProgress = Math.min(1, rewindProgress + 1 / totalFrames);

    // Move camera in a straight line from start to origin
    cameraX = rewindStartX * (1 - rewindProgress);
    cameraY = rewindStartY * (1 - rewindProgress);

    // Remove nodes evenly across the journey (keep the first)
    const nodesRemaining = Math.max(1, Math.ceil((1 - rewindProgress) * rewindNodeCount));
    while (nodes.length > nodesRemaining) {
      const dying = nodes[nodes.length - 1];
      startDissolve(dying);
      dying.el.remove();
      nodes.pop();
    }

    // Done
    if (rewindProgress >= 1) {
      cameraX = 0;
      cameraY = 0;
      targetCameraX = 0;
      targetCameraY = 0;
      currentIndex = 1;
      rewinding = false;
      if (rewindBtn) {
        rewindBtn.remove();
        rewindBtn = null;
      }
      applyGlobalColors();
    }
  }

  function updatePositions() {
    const px = parallaxOffset(NODE_DEPTH);
    for (const node of nodes) {
      const screenX = node.worldX - cameraX + px.x;
      const screenY = node.worldY - cameraY + px.y;
      node.el.style.transform = `translate(${screenX}px, ${screenY}px)`;
    }
  }

  function draw(time) {
    if (debug.freeze) return; // stop touching the canvas entirely
    const w = canvasBg.width;
    const h = canvasBg.height;
    if (w === 0 || h === 0) return;

    // Use live (interpolated) fg for specks and connectors.
    // During rewind, liveFg is locked to data.colors[1] by doRewind().
    const fgNorm = [liveFg[0] / 255, liveFg[1] / 255, liveFg[2] / 255];

    // Frame pacing: render speck layers every Nth frame.
    // Canvas content persists, so skipped frames reuse previous specks.
    frameCount++;
    if (speckFrameSkip <= 1 || (frameCount % speckFrameSkip === 0)) {

    // Grain offset removed — Math.floor caused the entire IGN threshold
    // map to shift by 1 pixel at integer crossings of smoothMouse, which
    // decorrelates every pixel's threshold (IGN is a hash function),
    // causing visible full-frame blinks at specific mouse positions.

    // --- Speck layers: each rendered individually with per-layer blur ---
    // Use 'copy' composite for the first layer on each canvas to atomically
    // replace the old frame — avoids clearRect which leaves the visible canvas
    // blank until redrawn, causing single-frame blinks when the browser
    // compositor reads between the clear and the first drawImage.
    let bgFirst = true;
    let fgFirst = true;

    for (let li = 0; li < SPECK_LAYERS.length; li++) {
      if (!debug.layers[li]) continue; // skip disabled layers

      const layer = SPECK_LAYERS[li];
      const sp = speckOffscreens[li];
      const s = layer.scale;
      // Blur radius scales down with resolution (0 when debug.blur is off)
      const blur = debug.blur ? depthBlur(layer.depth) * s : 0;
      const sw = sp.off.width;
      const sh = sp.off.height;

      sp.ctx.clearRect(0, 0, sw, sh);
      drawSpeckLayer(sp.ctx, sw, sh, li, time);

      let source;
      if (debug.dither) {
        // Full WebGL pipeline: blur + dither
        const outSize = (s < 1) ? [w, h] : null;
        sharedPipeline.process(sp.off, blur, fgNorm, outSize);

        if (needsBitmapTransfer) {
          // Chrome: GPU-fenced snapshot avoids stale-read blinks
          source = sharedGlCanvas.transferToImageBitmap();
        } else {
          // Safari/Firefox: draw directly from the OffscreenCanvas —
          // no stale-read issue, and skipping the sync fence is much faster
          source = sharedGlCanvas;
        }
      } else {
        source = sp.off;
      }

      // Composite to the appropriate visible canvas
      const alpha = layerOpacity[li];
      if (layer.canvas === 'bg') {
        if (bgFirst) {
          canvasBgCtx.globalCompositeOperation = 'copy';
          bgFirst = false;
        }
        canvasBgCtx.globalAlpha = alpha;
        canvasBgCtx.drawImage(source, 0, 0, w, h);
        canvasBgCtx.globalAlpha = 1;
        canvasBgCtx.globalCompositeOperation = 'source-over';
      } else {
        if (fgFirst) {
          canvasFgCtx.globalCompositeOperation = 'copy';
          fgFirst = false;
        }
        canvasFgCtx.globalAlpha = alpha;
        canvasFgCtx.drawImage(source, 0, 0, w, h);
        canvasFgCtx.globalAlpha = 1;
        canvasFgCtx.globalCompositeOperation = 'source-over';
      }

      // Release the bitmap if we created one (only for transferToImageBitmap path)
      if (source instanceof ImageBitmap) source.close();
    }

    // If all layers of a canvas type were disabled, clear it
    if (bgFirst) canvasBgCtx.clearRect(0, 0, w, h);
    if (fgFirst) canvasFgCtx.clearRect(0, 0, w, h);
    } // end frame pacing

    // // V2: Image layer
    // const imgBlur = depthBlur(IMAGE_DEPTH);
    // ctxImg.clearRect(0, 0, w, h);
    // drawImage(ctxImg, w, h);
    // ditherImg.process(offImg, imgBlur, fgNorm, grainOffset);

    // --- Mid layer: connectors + dissolving text (sharp, no blur, no dither) ---
    ctxMid.clearRect(0, 0, w, h);
    drawConnectors(ctxMid);
    drawDissolve(ctxMid);
  }

  function animate() {
    if (rewinding) {
      rewindTick();
    } else {
      const camDx = targetCameraX - cameraX;
      const camDy = targetCameraY - cameraY;
      cameraX += camDx * 0.06;
      cameraY += camDy * 0.06;
    }

    // Smooth image fade
    const fadeEase = 0.06;
    activeImageAlpha += (fadeTo - activeImageAlpha) * fadeEase;

    // When faded out, clear the reference
    if (fadeTo === 0 && activeImageAlpha < 0.01) {
      activeImageNode = null;
    }

    const currentNode = nodes[nodes.length - 1];
    let mouseOffsetX = 0;
    let mouseOffsetY = 0;
    if (currentNode && !rewinding) {
      const nodeScreenX = currentNode.worldX - cameraX;
      const nodeScreenY = currentNode.worldY - cameraY;
      mouseOffsetX = (rawMouseX - nodeScreenX) / window.innerWidth * 2;
      mouseOffsetY = (rawMouseY - nodeScreenY) / window.innerHeight * 2;
    }

    const mouseEase = 0.05;
    const mouseDx = mouseOffsetX - smoothMouseX;
    const mouseDy = mouseOffsetY - smoothMouseY;
    smoothMouseX += mouseDx * mouseEase;
    smoothMouseY += mouseDy * mouseEase;

    tickDissolve();
    updatePositions();

    // Color fade: once started, runs to its locked-in goal even if new
    // clicks change the targets. New fades only begin when camera settles
    // AND the previous fade is done, so rapid clicking stays on the last
    // completed color.
    const camSettled = Math.abs(targetCameraX - cameraX) < 20 &&
                       Math.abs(targetCameraY - cameraY) < 20;
    if (colorFadeActive) {
      const ease = 0.04;
      let reached = true;
      for (let i = 0; i < 3; i++) {
        liveFg[i] += (fadeGoalFg[i] - liveFg[i]) * ease;
        liveBg[i] += (fadeGoalBg[i] - liveBg[i]) * ease;
        if (Math.abs(liveFg[i] - fadeGoalFg[i]) > 0.5 ||
            Math.abs(liveBg[i] - fadeGoalBg[i]) > 0.5) reached = false;
      }
      applyCSSColors();
      if (reached) colorFadeActive = false;
    } else if (camSettled && !rewinding) {
      const needsFade = liveFg.some((v, i) => Math.abs(v - targetColorFg[i]) > 0.5) ||
                        liveBg.some((v, i) => Math.abs(v - targetColorBg[i]) > 0.5);
      if (needsFade) {
        colorFadeActive = true;
        fadeGoalFg = [...targetColorFg];
        fadeGoalBg = [...targetColorBg];
      }
    }

    // Fade in newly enabled layers (~0.8s linear ramp)
    for (let i = 0; i < layerOpacity.length; i++) {
      if (debug.layers[i] && layerOpacity[i] < 1) {
        layerOpacity[i] = Math.min(1, layerOpacity[i] + 0.02);
      }
    }

    // Lerp density multipliers toward targets (~1s ease)
    for (let i = 0; i < layerDensityMul.length; i++) {
      const diff = layerDensityTarget[i] - layerDensityMul[i];
      if (Math.abs(diff) > 0.005) {
        layerDensityMul[i] += diff * 0.03;
      } else {
        layerDensityMul[i] = layerDensityTarget[i];
      }
    }

    // FPS monitoring for adaptive quality
    const now = performance.now();
    if (lastFrameTime > 0) {
      frameTimes.push(now - lastFrameTime);
      if (frameTimes.length > 120) frameTimes.shift();
    }
    lastFrameTime = now;
    checkAdaptiveQuality(now);

    draw(now);

    requestAnimationFrame(animate);
  }

  init();
})();
