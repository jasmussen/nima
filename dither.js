// WebGL post-processing pipeline: blur + blue noise dither
// Takes a Canvas2D source, applies GPU blur and 1-bit dithering,
// renders result to a WebGL canvas.
//
// BLINK FIX — hard-won lesson, do not revert:
// The dither threshold grid MUST be fixed relative to the screen. Never
// add a per-frame offset (u_offset, "grain breathing", etc.) that shifts
// the noise pattern by integer pixels. Both blue noise and IGN are
// decorrelated at adjacent positions — shifting by 1px gives every pixel
// a completely unrelated threshold, causing thousands of pixels to flip
// simultaneously in a single frame, perceived as a visible blink.
// The two rules:
//   1. No integer-jumping offset to the noise coordinates.
//   2. Only call draw() when visual inputs actually changed (see main.js
//      draw-skip logic). Redundant repaints of identical content can
//      trigger Chrome compositor artifacts.

// Generate a 64x64 blue noise threshold texture using void-and-cluster.
// Runs once at module load, shared across all pipelines.
const BLUE_NOISE_SIZE = 64;
const _blueNoiseData = (function() {
  const size = BLUE_NOISE_SIZE;
  const count = size * size;
  const values = new Float32Array(count);
  const placed = new Uint8Array(count);
  const energy = new Float32Array(count);

  const sigma = 1.5;
  const sigma2x2 = 2 * sigma * sigma;
  const radius = Math.ceil(sigma * 3);

  function wrap(v) { return ((v % size) + size) % size; }

  function addEnergy(x, y, sign) {
    for (let dy = -radius; dy <= radius; dy++) {
      const wy = wrap(y + dy);
      for (let dx = -radius; dx <= radius; dx++) {
        const wx = wrap(x + dx);
        energy[wy * size + wx] += sign * Math.exp(-(dx * dx + dy * dy) / sigma2x2);
      }
    }
  }

  // Seed center pixel
  const seedIdx = Math.floor(count / 2);
  placed[seedIdx] = 1;
  addEnergy(seedIdx % size, (seedIdx / size) | 0, 1);

  // Build ranking by always placing next point at largest void
  for (let i = 1; i < count; i++) {
    let minE = Infinity, minIdx = 0;
    for (let j = 0; j < count; j++) {
      if (!placed[j] && energy[j] < minE) {
        minE = energy[j];
        minIdx = j;
      }
    }
    placed[minIdx] = 1;
    values[minIdx] = i / count;
    addEnergy(minIdx % size, (minIdx / size) | 0, 1);
  }

  // Convert to Uint8
  const bytes = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    bytes[i] = Math.floor(values[i] * 255);
  }
  return bytes;
})();

function createDitherPipeline(glCanvas) {
  const gl = glCanvas.getContext('webgl', {
    alpha: true,
    premultipliedAlpha: false,
  });
  if (!gl) {
    console.error('WebGL not available');
    return null;
  }

  // --- Shader sources ---

  const VERT_SRC = `
    attribute vec2 a_pos;
    attribute vec2 a_uv;
    varying vec2 v_uv;
    void main() {
      v_uv = vec2(a_uv.x, 1.0 - a_uv.y);
      gl_Position = vec4(a_pos, 0.0, 1.0);
    }
  `;

  // Blur shader: two-pass Gaussian (horizontal or vertical)
  // Skips out-of-bounds samples instead of relying on CLAMP_TO_EDGE,
  // which smears edge pixels outward (visible as specks extending near
  // viewport borders). Normalizes with full kernel weight so edges
  // naturally fade to transparent rather than brightening.
  const BLUR_SRC = `
    precision mediump float;
    varying vec2 v_uv;
    uniform sampler2D u_tex;
    uniform vec2 u_dir;       // (1/w, 0) for horizontal, (0, 1/h) for vertical
    uniform float u_radius;   // blur radius in pixels

    void main() {
      vec4 sum = vec4(0.0);
      float fullWeight = 0.0;

      for (float i = -12.0; i <= 12.0; i += 1.0) {
        if (abs(i) > u_radius) continue;
        float weight = exp(-0.5 * (i * i) / max(u_radius * u_radius * 0.16, 0.01));
        fullWeight += weight;
        vec2 sampleUV = v_uv + u_dir * i;
        // Skip samples outside the texture to prevent edge smearing
        if (sampleUV.x < 0.0 || sampleUV.x > 1.0 ||
            sampleUV.y < 0.0 || sampleUV.y > 1.0) continue;
        sum += texture2D(u_tex, sampleUV) * weight;
      }

      gl_FragColor = sum / fullWeight;
    }
  `;

  // Dither shader: 64x64 blue noise threshold texture, tiled across screen.
  // The threshold grid is FIXED to screen coordinates — no per-frame offset.
  // See blink fix comment at top of file.
  const DITHER_SRC = `
    precision mediump float;
    varying vec2 v_uv;
    uniform sampler2D u_tex;
    uniform sampler2D u_noise;
    uniform vec2 u_resolution;
    uniform vec3 u_fg;
    uniform float u_noiseSize;  // blue noise texture size (64.0)

    void main() {
      vec4 texel = texture2D(u_tex, v_uv);
      float intensity = dot(texel.rgb, vec3(0.299, 0.587, 0.114)) * texel.a;

      vec2 noiseUV = floor(v_uv * u_resolution) / u_noiseSize;
      float threshold = texture2D(u_noise, noiseUV).r;

      if (intensity > threshold) {
        gl_FragColor = vec4(u_fg, 1.0);
      } else {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
      }
    }
  `;

  // --- Compile helpers ---

  function compileShader(type, src) {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      console.error('Shader error:', gl.getShaderInfoLog(s));
      return null;
    }
    return s;
  }

  function createProgram(vertSrc, fragSrc) {
    const v = compileShader(gl.VERTEX_SHADER, vertSrc);
    const f = compileShader(gl.FRAGMENT_SHADER, fragSrc);
    const p = gl.createProgram();
    gl.attachShader(p, v);
    gl.attachShader(p, f);
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      console.error('Program error:', gl.getProgramInfoLog(p));
      return null;
    }
    return p;
  }

  // --- Programs ---
  const blurProg = createProgram(VERT_SRC, BLUR_SRC);
  const ditherProg = createProgram(VERT_SRC, DITHER_SRC);

  // Cache uniform locations — avoids ~75 string lookups per frame
  const blurLoc = {
    u_tex: gl.getUniformLocation(blurProg, 'u_tex'),
    u_dir: gl.getUniformLocation(blurProg, 'u_dir'),
    u_radius: gl.getUniformLocation(blurProg, 'u_radius'),
  };
  const ditherLoc = {
    u_tex: gl.getUniformLocation(ditherProg, 'u_tex'),
    u_noise: gl.getUniformLocation(ditherProg, 'u_noise'),
    u_resolution: gl.getUniformLocation(ditherProg, 'u_resolution'),
    u_fg: gl.getUniformLocation(ditherProg, 'u_fg'),
    u_noiseSize: gl.getUniformLocation(ditherProg, 'u_noiseSize'),
  };

  // --- Blue noise texture ---
  const noiseTex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, noiseTex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, BLUE_NOISE_SIZE, BLUE_NOISE_SIZE, 0,
    gl.LUMINANCE, gl.UNSIGNED_BYTE, _blueNoiseData);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);

  // --- Geometry: fullscreen quad ---
  const quadBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);
  // pos (x,y), uv (u,v)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([
    -1, -1,  0, 0,
     1, -1,  1, 0,
    -1,  1,  0, 1,
     1,  1,  1, 1,
  ]), gl.STATIC_DRAW);

  function setupAttribs(prog) {
    const aPos = gl.getAttribLocation(prog, 'a_pos');
    const aUv = gl.getAttribLocation(prog, 'a_uv');
    gl.enableVertexAttribArray(aPos);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);
  }

  // --- Textures and framebuffers ---

  function createFBO(w, h) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    const fb = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

    return { tex, fb, w, h };
  }

  // FBO cache: keyed by "w,h", allocated once and reused forever.
  // Eliminates per-frame GPU allocation thrashing when processing
  // multiple layers at different resolutions through a shared pipeline.
  const fboCache = new Map();
  let fboA = null;
  let fboB = null;
  let sourceTex = null;
  let currentKey = '';

  function ensureSize(w, h) {
    const key = w + ',' + h;
    if (key === currentKey) return;
    currentKey = key;

    let entry = fboCache.get(key);
    if (!entry) {
      entry = {
        fboA: createFBO(w, h),
        fboB: createFBO(w, h),
        sourceTex: (function() {
          const t = gl.createTexture();
          gl.bindTexture(gl.TEXTURE_2D, t);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
          return t;
        })(),
      };
      fboCache.set(key, entry);
    }

    fboA = entry.fboA;
    fboB = entry.fboB;
    sourceTex = entry.sourceTex;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  // --- Public API ---

  // Process a Canvas2D element through blur + dither and render to the WebGL canvas
  // blurRadius: pixel radius for Gaussian blur (0 = no blur)
  // fgColor: [r, g, b] normalized 0-1
  // outputSize: [w, h] optional full-res output size (blur at source res, dither at output res)
  function process(sourceCanvas, blurRadius, fgColor, outputSize) {
    const w = sourceCanvas.width;
    const h = sourceCanvas.height;
    const outW = outputSize ? outputSize[0] : w;
    const outH = outputSize ? outputSize[1] : h;

    // Only resize the output canvas when dimensions actually change —
    // setting .width/.height resets the WebGL drawing buffer, which can
    // cause a blank frame on some GPU drivers.
    if (glCanvas.width !== outW || glCanvas.height !== outH) {
      glCanvas.width = outW;
      glCanvas.height = outH;
    }
    gl.viewport(0, 0, w, h);
    ensureSize(w, h);

    // Upload source canvas to texture.
    // Explicitly set TEXTURE0 active before binding — the previous dither pass
    // leaves TEXTURE1 active, and uploading sourceTex on a different unit each
    // time can confuse some GPU drivers.
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, sourceTex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, sourceCanvas);

    gl.bindBuffer(gl.ARRAY_BUFFER, quadBuf);

    let currentTex = sourceTex;

    // Multi-pass blur: each pass handles up to 12px, repeat to reach target
    if (blurRadius > 0.5) {
      const MAX_PER_PASS = 12.0;
      let remaining = blurRadius;

      gl.useProgram(blurProg);
      setupAttribs(blurProg);
      gl.uniform1i(blurLoc.u_tex, 0);

      while (remaining > 0.5) {
        const r = Math.min(remaining, MAX_PER_PASS);
        remaining -= r;

        // Horizontal: currentTex -> fboA
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboA.fb);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, currentTex);
        gl.uniform2f(blurLoc.u_dir, 1.0 / w, 0.0);
        gl.uniform1f(blurLoc.u_radius, r);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        // Vertical: fboA -> fboB
        gl.bindFramebuffer(gl.FRAMEBUFFER, fboB.fb);
        gl.clear(gl.COLOR_BUFFER_BIT);
        gl.bindTexture(gl.TEXTURE_2D, fboA.tex);
        gl.uniform2f(blurLoc.u_dir, 0.0, 1.0 / h);
        gl.uniform1f(blurLoc.u_radius, r);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

        currentTex = fboB.tex;
      }
    }

    // Dither pass: currentTex -> screen at full output resolution
    gl.viewport(0, 0, outW, outH);
    gl.useProgram(ditherProg);
    setupAttribs(ditherProg);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    // No gl.clear — the dither full-screen quad overwrites every pixel
    // (either fg color or transparent). Skipping the clear avoids a brief
    // window where the canvas is blank, which the compositor could read.

    // Bind blurred image on unit 0 (bilinear filtered up to full res)
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, currentTex);
    gl.uniform1i(ditherLoc.u_tex, 0);

    // Bind blue noise on unit 1
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, noiseTex);
    gl.uniform1i(ditherLoc.u_noise, 1);

    // Resolution is the OUTPUT size so dither pattern is 1:1 with screen pixels
    gl.uniform2f(ditherLoc.u_resolution, outW, outH);
    gl.uniform3f(ditherLoc.u_fg, fgColor[0], fgColor[1], fgColor[2]);
    gl.uniform1f(ditherLoc.u_noiseSize, BLUE_NOISE_SIZE);

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // No explicit flush needed — caller uses transferToImageBitmap()
    // which internally GPU-fences before creating the snapshot.
  }

  return { process, gl };
}
