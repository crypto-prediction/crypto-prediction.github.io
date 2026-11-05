// Particle globe of real candles: one coloured arc per coin, one filament per candle. Nothing is
// random: position, shape, brightness and pulses come from the candles, and flashes fire on live ticks.
// It summarises price data only. It does not show blockchain transactions or money moving between coins.
import { memo, useEffect, useRef, useState } from 'react';
import { baseOf, nameOf, pairColor } from '../coins.js';
import { activityLevel, ranks, strongestLinks } from '../metrics.js';
import { compact, pct, price } from '../format.js';

const MAX_COINS = 32; // size of the shader's per-coin arrays

const VERT = `
attribute vec3 aPos; attribute vec3 aColor; attribute float aS; attribute float aPhase; attribute float aAlpha;
attribute float aId; attribute float aAsset; attribute float aRecency; attribute float aSpeed;
uniform float uT, uAspect, uFocal, uPointSize, uHover, uSelected;
uniform float uTickAge[${MAX_COINS}];
uniform float uActivity[${MAX_COINS}];
varying vec3 vColor; varying float vA;
vec3 rotX(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(p.x, c*p.y - s*p.z, s*p.y + c*p.z); }
vec3 rotY(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c*p.x + s*p.z, p.y, -s*p.x + c*p.z); }
vec3 rotZ(vec3 p, float a) { float c = cos(a), s = sin(a); return vec3(c*p.x - s*p.y, s*p.x + c*p.y, p.z); }
void main() {
  vec3 p = aPos;
  p += 0.018 * vec3(sin(p.y*5.0 + uT*0.9 + aPhase*6.0), sin(p.z*5.0 + uT*1.1 + aPhase*4.0), sin(p.x*5.0 + uT*0.8 + aPhase*5.0));
  p *= 1.0 + 0.012 * sin(uT*0.6);
  p = rotZ(p, uT*0.16);
  p = rotX(p, -0.38 + 0.12*sin(uT*0.23));
  p = rotY(p, -0.40 + 0.22*sin(uT*0.15));
  int coin = int(aAsset + 0.5);
  // pulse speed comes from the candle's trade count; pulse brightness from the coin's current volume
  float pulse = pow(fract(aS*0.8 - uT*(0.05 + 0.2*aSpeed) + aPhase), 22.0) * (0.15 + 1.0*uActivity[coin]);
  // a real tick on this coin flashes its newest candles
  float tick = exp(-uTickAge[coin]*2.5) * smoothstep(0.96, 1.0, aRecency);
  float hovered = 1.0 - step(0.5, abs(aId - uHover));
  float isSel = 1.0 - step(0.5, abs(aAsset - uSelected));
  float focus = uSelected < 0.0 ? 1.0 : mix(0.5, 1.9, isSel);
  vColor = mix(mix(aColor, vec3(1.0), tick*0.7), vec3(1.0), hovered);
  vA = aAlpha * focus * (uHover < 0.0 ? 1.0 : 0.45) + (pulse*focus + tick*0.9) * step(0.001, aAlpha) + hovered;
  float w = 4.3 - p.z;
  gl_Position = vec4(p.x*uFocal/uAspect, p.y*uFocal, 0.0, w);
  gl_PointSize = uPointSize * (1.0 + 3.0*hovered);
}`;

const FRAG = `
precision mediump float;
uniform float uRound;
varying vec3 vColor; varying float vA;
void main() {
  if (uRound > 0.5 && length(gl_PointCoord - 0.5) > 0.5) discard;
  gl_FragColor = vec4(vColor, vA);
}`;

const STRIDE = 13; // pos 3, color 3, s, phase, alpha, id, asset, recency, speed
const SEGMENTS = 30;
const LINK_SEGMENTS = 24;
const LINK_COUNT = 12;
const R = 1.0;
const TUBE = 0.62;
const SPIN = 0.16;
const NO_ID = -5;

const surface = (theta, phi, r) => [
  (R + r * Math.cos(phi)) * Math.cos(theta),
  (R + r * Math.cos(phi)) * Math.sin(theta),
  r * Math.sin(phi),
];

// Thin lines read darker than the same colour in a chart, so they are lifted a little.
const filamentColor = (symbol) => {
  const n = parseInt(pairColor(symbol).slice(1), 16);
  return [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.min(1, (v / 255) * 1.3));
};
const whiter = (c, k) => c.map((v) => v + (1 - v) * k);

// Turns one candle into a filament. Every input is a property of the candle.
function filament(c, i, n, sector, q) {
  const sectorSize = (Math.PI * 2) / sector.count;
  const theta = sector.index * sectorSize + (i / n) * sectorSize; // time runs around the coin's arc
  const side = i % 2 ? 1 : -1;
  const phi = side * (1 - q.price) * Math.PI; // higher closes sit nearer the outer rim
  const up = c.close >= c.open ? 1 : -1;
  if (q.volume >= 0.88) { // volume spike: a line shooting out of the rim, longer with more volume
    const outer = phi * 0.3;
    const start = surface(theta, outer, TUBE);
    const dir = [Math.cos(theta), Math.sin(theta), Math.sin(outer) * 0.8 + up * 0.15];
    const len = 0.2 + ((q.volume - 0.88) / 0.12) ** 2 * 1.0;
    return { alpha: 0.14 + 0.16 * q.range, taper: (s) => (1 - s) * (1 - s), at: (s) => start.map((v, k) => v + dir[k] * len * s) };
  }
  // stays near its own arc so each coin's colour remains identifiable
  const dTheta = up * sectorSize * (0.15 + 0.85 * q.range);
  const dPhi = up * (0.8 + 4.5 * q.body);
  const dip = q.range * 0.8;
  return {
    alpha: 0.06 + 0.15 * q.volume,
    taper: (s) => Math.sqrt(Math.sin(Math.PI * s)),
    at: (s) => surface(theta + dTheta * s, phi + dPhi * s, TUBE * (1 - dip * Math.sin(Math.PI * s))),
  };
}

const sectorMiddle = (index, count) => (index + 0.5) * ((Math.PI * 2) / count);

function buildGeometry(allSeries, perCoin) {
  const series = allSeries.map((s) => ({ symbol: s.symbol, candles: s.candles.slice(-perCoin) }));
  const total = series.reduce((sum, a) => sum + a.candles.length, 0);
  const links = strongestLinks(allSeries, LINK_COUNT);
  const lines = new Float32Array((total * SEGMENTS * 2 + links.length * LINK_SEGMENTS * 2) * STRIDE);
  const nodes = new Float32Array(total * STRIDE);
  const items = [];
  let o = 0;
  const put = (buf, at, p, color, s, phase, alpha, id, asset, recency, speed) => {
    buf.set(p, at);
    buf.set(color, at + 3);
    buf[at + 6] = s; buf[at + 7] = phase; buf[at + 8] = alpha; buf[at + 9] = id;
    buf[at + 10] = asset; buf[at + 11] = recency; buf[at + 12] = speed;
  };
  series.forEach(({ symbol, candles }, asset) => {
    const n = candles.length;
    const qPrice = ranks(candles.map((c) => c.close));
    const qVolume = ranks(candles.map((c) => c.quoteVolume));
    const qRange = ranks(candles.map((c) => (c.high - c.low) / c.open));
    const qBody = ranks(candles.map((c) => Math.abs(c.close - c.open) / c.open));
    const qTrades = ranks(candles.map((c) => c.trades));
    const base = filamentColor(symbol);
    candles.forEach((c, i) => {
      const id = items.length;
      const q = { price: qPrice[i], volume: qVolume[i], range: qRange[i], body: qBody[i] };
      const fil = filament(c, i, n, { index: asset, count: series.length }, q);
      const big = q.body >= 0.98; // the largest moves burn brightest
      const color = big ? whiter(base, 0.55) : base;
      const alpha = big ? fil.alpha * 2.2 : fil.alpha;
      const phase = (c.openTime / 3600000) * 0.618 % 1;
      const recency = n > 1 ? i / (n - 1) : 1;
      for (let k = 0; k < SEGMENTS; k++) {
        for (const j of [k, k + 1]) {
          const s = j / SEGMENTS;
          put(lines, o, fil.at(s), color, s, phase, alpha * fil.taper(s), id, asset, recency, qTrades[i]);
          o += STRIDE;
        }
      }
      const pos = fil.at(0.5);
      put(nodes, id * STRIDE, pos, color, 0.5, phase, 0.55, id, asset, recency, qTrades[i]);
      items.push({ symbol, candle: c, pos });
    });
  });

  // Lines between the most correlated coins. They arc over the ring to keep the centre clear.
  const count = series.length;
  const low = links.length ? links[links.length - 1].value : 0;
  links.forEach((link, li) => {
    const a = surface(sectorMiddle(link.a, count), 0, TUBE);
    const b = surface(sectorMiddle(link.b, count), 0, TUBE);
    const lift = [(a[0] + b[0]) * 0.5, (a[1] + b[1]) * 0.5, 1.0 + 0.25 * (li % 3)];
    const ca = filamentColor(series[link.a].symbol);
    const cb = filamentColor(series[link.b].symbol);
    const strength = link.value > low ? (link.value - low) / (1 - low) : 0;
    const alpha = 0.1 + 0.3 * strength;
    const phase = (li * 0.618) % 1;
    const point = (s) => [0, 1, 2].map((k) => (1 - s) * (1 - s) * a[k] + 2 * (1 - s) * s * lift[k] + s * s * b[k]);
    for (let k = 0; k < LINK_SEGMENTS; k++) {
      for (const j of [k, k + 1]) {
        const s = j / LINK_SEGMENTS;
        const near = s < 0.5 ? link.a : link.b;
        put(lines, o, point(s), ca.map((v, x) => v + (cb[x] - v) * s), s, phase, alpha * Math.sqrt(Math.sin(Math.PI * s)), NO_ID, near, 0, 0.3 + 0.5 * strength);
        o += STRIDE;
      }
    }
  });
  return { lines, nodes, items, candlesPerCoin: series[0]?.candles.length || 0, links };
}

function compile(gl) {
  const shader = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  };
  const prog = gl.createProgram();
  gl.attachShader(prog, shader(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, shader(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  return prog;
}

// Same transform as the vertex shader (minus the tiny drift), for pointer picking and coin labels.
function project([x, y, z], t, focal, aspect) {
  const b = 1 + 0.012 * Math.sin(t * 0.6);
  let px = x * b, py = y * b, pz = z * b;
  const rz = t * SPIN, rx = -0.38 + 0.12 * Math.sin(t * 0.23), ry = -0.40 + 0.22 * Math.sin(t * 0.15);
  [px, py] = [Math.cos(rz) * px - Math.sin(rz) * py, Math.sin(rz) * px + Math.cos(rz) * py];
  [py, pz] = [Math.cos(rx) * py - Math.sin(rx) * pz, Math.sin(rx) * py + Math.cos(rx) * pz];
  [px, pz] = [Math.cos(ry) * px + Math.sin(ry) * pz, -Math.sin(ry) * px + Math.cos(ry) * pz];
  const w = 4.3 - pz;
  return [(px * focal) / aspect / w, (py * focal) / w, pz];
}

const fmtTime = (ms) => `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;

export const FilamentTorus = memo(function FilamentTorus({ series, interval, error, tickers, overview, selected, onSelect }) {
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const labelEls = useRef({});
  const glState = useRef({ upload: null, geometry: null, hover: -1, tickAt: {}, lastEvent: {}, symbols: [], signature: null, selected: -1, activity: {}, paused: false });
  const [webglFailed, setWebglFailed] = useState(false);
  const [hovered, setHovered] = useState(null); // candle under the pointer
  const [hoverCoin, setHoverCoin] = useState(null); // {symbol, x, y}
  const [summary, setSummary] = useState({ perCoin: 0, links: [] });
  const perCoin = useRef(typeof window !== 'undefined' && window.innerWidth < 700 ? 150 : 300);
  const st = glState.current;

  st.selected = st.symbols.indexOf(selected);
  st.activity = overview;
  st.paused = Boolean(hoverCoin);

  // Rebuild only when a new candle has opened. With no data, nothing is drawn.
  useEffect(() => {
    const next = `${interval}|${series.map((a) => `${a.symbol}:${a.candles.length}:${a.candles[a.candles.length - 1]?.openTime}`).join('|')}`;
    if (next === st.signature) return;
    st.signature = next;
    st.geometry = series.length ? buildGeometry(series, perCoin.current) : null;
    st.symbols = series.map((a) => a.symbol).slice(0, MAX_COINS);
    st.selected = st.symbols.indexOf(selected);
    st.hover = -1;
    setHovered(null);
    setSummary({ perCoin: st.geometry?.candlesPerCoin || 0, links: st.geometry?.links || [] });
    st.upload?.();
  }, [series, interval, selected, st]);

  // A new tick on a coin flashes that coin's newest candles.
  useEffect(() => {
    for (const s of Object.keys(tickers || {})) {
      const ev = tickers[s]?.eventTime;
      if (ev && st.lastEvent[s] !== ev) {
        st.lastEvent[s] = ev;
        st.tickAt[s] = performance.now();
      }
    }
  }, [tickers, st]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const gl = canvas.getContext('webgl', { alpha: false, antialias: true, powerPreference: 'low-power' });
    if (!gl) { setWebglFailed(true); return undefined; }

    const speed = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.3 : 1;
    let raf = 0;
    let visible = true;
    let draw = null;
    let view = { focal: 1, aspect: 1 };
    let simT = 0;
    let lastFrame = performance.now();
    const ages = new Float32Array(MAX_COINS);
    const activity = new Float32Array(MAX_COINS);

    const init = () => {
      const prog = compile(gl);
      const lineBuf = gl.createBuffer();
      const nodeBuf = gl.createBuffer();
      let lineCount = 0;
      let nodeCount = 0;
      st.upload = () => {
        const g = st.geometry;
        if (!g) { lineCount = 0; nodeCount = 0; return; }
        gl.bindBuffer(gl.ARRAY_BUFFER, lineBuf);
        gl.bufferData(gl.ARRAY_BUFFER, g.lines, gl.STATIC_DRAW);
        gl.bindBuffer(gl.ARRAY_BUFFER, nodeBuf);
        gl.bufferData(gl.ARRAY_BUFFER, g.nodes, gl.STATIC_DRAW);
        lineCount = g.lines.length / STRIDE;
        nodeCount = g.nodes.length / STRIDE;
      };
      st.upload();
      const attrs = [['aPos', 3, 0], ['aColor', 3, 3], ['aS', 1, 6], ['aPhase', 1, 7], ['aAlpha', 1, 8], ['aId', 1, 9], ['aAsset', 1, 10], ['aRecency', 1, 11], ['aSpeed', 1, 12]]
        .map(([name, size, off]) => ({ loc: gl.getAttribLocation(prog, name), size, off }));
      const bind = (buf) => {
        gl.bindBuffer(gl.ARRAY_BUFFER, buf);
        for (const a of attrs) {
          gl.enableVertexAttribArray(a.loc);
          gl.vertexAttribPointer(a.loc, a.size, gl.FLOAT, false, STRIDE * 4, a.off * 4);
        }
      };
      const u = Object.fromEntries(['uT', 'uAspect', 'uFocal', 'uPointSize', 'uHover', 'uSelected', 'uRound'].map((k) => [k, gl.getUniformLocation(prog, k)]));
      const uTickAge = gl.getUniformLocation(prog, 'uTickAge[0]');
      const uActivity = gl.getUniformLocation(prog, 'uActivity[0]');
      gl.useProgram(prog);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE);
      gl.clearColor(0.024, 0.03, 0.043, 1);

      draw = (t) => {
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        const w = Math.round(canvas.clientWidth * dpr);
        const h = Math.round(canvas.clientHeight * dpr);
        if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
        gl.viewport(0, 0, w, h);
        const aspect = w / Math.max(h, 1);
        const focal = 2.35 * Math.min(1, aspect);
        view = { focal, aspect };
        gl.clear(gl.COLOR_BUFFER_BIT);
        if (!lineCount) return;
        const now = performance.now();
        st.symbols.forEach((s, i) => {
          ages[i] = st.tickAt[s] ? (now - st.tickAt[s]) / 1000 : 1000;
          activity[i] = activityLevel(st.activity?.[s]?.relativeVolume);
        });
        gl.uniform1f(u.uT, t);
        gl.uniform1f(u.uAspect, aspect);
        gl.uniform1f(u.uFocal, focal);
        gl.uniform1f(u.uHover, st.hover);
        gl.uniform1f(u.uSelected, st.selected);
        gl.uniform1fv(uTickAge, ages);
        gl.uniform1fv(uActivity, activity);
        gl.uniform1f(u.uPointSize, 1.5 * dpr);
        gl.uniform1f(u.uRound, 0);
        bind(lineBuf);
        gl.drawArrays(gl.LINES, 0, lineCount);
        gl.uniform1f(u.uRound, 1);
        bind(nodeBuf);
        gl.drawArrays(gl.POINTS, 0, nodeCount);
      };
    };

    // Coin labels float at the outer rim of each coin's arc and fade as they pass behind.
    const placeLabels = (t) => {
      const cw = canvas.clientWidth;
      const ch = canvas.clientHeight;
      st.symbols.forEach((s, i) => {
        const el = labelEls.current[s];
        if (!el) return;
        const [cx, cy, z] = project(surface(sectorMiddle(i, st.symbols.length), 0, TUBE + 0.14), t, view.focal, view.aspect);
        const x = Math.max(24, Math.min(cw - 24, (cx * 0.5 + 0.5) * cw));
        const y = Math.max(12, Math.min(ch - 12, (0.5 - cy * 0.5) * ch));
        el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
        el.style.opacity = String(0.65 + 0.35 * Math.min(1, Math.max(0, z / 1.5 + 0.5)));
      });
    };

    const frame = () => {
      raf = 0;
      if (!visible || !draw) return;
      const now = performance.now();
      const dt = Math.min(0.1, (now - lastFrame) / 1000);
      lastFrame = now;
      if (!st.paused) simT += dt * speed; // the ring holds still while a coin is hovered, so it can be read
      draw(simT);
      placeLabels(simT);
      raf = requestAnimationFrame(frame);
    };
    const play = () => { if (!raf && visible && draw) { lastFrame = performance.now(); raf = requestAnimationFrame(frame); } };

    const io = new IntersectionObserver(([e]) => { visible = e.isIntersecting; play(); });
    io.observe(canvas);

    // Find the nearest candle to the pointer, so any filament can be identified.
    const onMove = (e) => {
      const items = st.geometry?.items;
      if (!items) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      let best = -1;
      let bestDist = 14 * 14;
      for (let i = 0; i < items.length; i++) {
        const [cx, cy] = project(items[i].pos, simT, view.focal, view.aspect);
        const dx = (cx * 0.5 + 0.5) * rect.width - x;
        const dy = (0.5 - cy * 0.5) * rect.height - y;
        const d = dx * dx + dy * dy;
        if (d < bestDist) { bestDist = d; best = i; }
      }
      st.hover = best;
      setHovered(best < 0 ? null : { symbol: items[best].symbol, candle: items[best].candle, x, y, width: rect.width });
    };
    const onLeave = () => { st.hover = -1; setHovered(null); };
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerdown', onMove);
    canvas.addEventListener('pointerleave', onLeave);

    const onLost = (e) => { e.preventDefault(); draw = null; };
    const onRestored = () => { init(); play(); };
    canvas.addEventListener('webglcontextlost', onLost);
    canvas.addEventListener('webglcontextrestored', onRestored);

    try { init(); play(); } catch (e) { console.error(e); setWebglFailed(true); }

    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      st.upload = null;
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerdown', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onRestored);
    };
  }, [st]);

  const showCoin = (symbol, e) => {
    const r = wrapRef.current.getBoundingClientRect();
    const b = e.currentTarget.getBoundingClientRect();
    setHovered(null);
    st.hover = -1;
    setHoverCoin({ symbol, x: b.left - r.left + b.width / 2, y: b.bottom - r.top + 6, width: r.width, height: r.height });
  };

  if (webglFailed) {
    return <div className="flex h-full items-center justify-center p-4 text-center text-sm text-mute" role="status">This browser could not start WebGL, so the globe is off. Everything else still works.</div>;
  }
  const c = hovered?.candle;
  const change = c ? ((c.close - c.open) / c.open) * 100 : 0;
  const count = series.length;
  const liveTick = hoverCoin ? tickers?.[hoverCoin.symbol] : null;
  const info = hoverCoin ? overview?.[hoverCoin.symbol] : null;

  return (
    <div ref={wrapRef} className="relative h-full w-full">
      <canvas ref={canvasRef} data-torus aria-hidden="true" className="block h-full w-full" />

      {series.map((s) => {
        const isSelected = s.symbol === selected;
        return (
          <button
            key={s.symbol}
            type="button"
            data-coin-label={s.symbol}
            ref={(el) => { if (el) labelEls.current[s.symbol] = el; else delete labelEls.current[s.symbol]; }}
            aria-pressed={isSelected}
            aria-label={`Select ${nameOf(s.symbol)}`}
            onClick={() => onSelect(s.symbol)}
            onPointerEnter={(e) => showCoin(s.symbol, e)}
            onPointerLeave={() => setHoverCoin(null)}
            onFocus={(e) => showCoin(s.symbol, e)}
            onBlur={() => setHoverCoin(null)}
            className={`num absolute left-0 top-0 flex items-center gap-1 whitespace-nowrap rounded-full border bg-ink-950/80 px-1.5 py-0.5 text-[10px] leading-none will-change-transform sm:text-[11px] ${isSelected ? 'z-[5] font-bold text-white' : 'border-ink-600 text-slate-300 hover:text-white'}`}
            style={isSelected ? { borderColor: pairColor(s.symbol), boxShadow: `0 0 10px ${pairColor(s.symbol)}` } : undefined}
          >
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: pairColor(s.symbol) }} />
            {baseOf(s.symbol)}
          </button>
        );
      })}

      <div className="pointer-events-none absolute left-3 top-3 max-w-[210px] text-[11px] leading-relaxed text-mute">
        {count > 0 ? (
          <>
            <p className="text-slate-200"><span className="num">{count}</span> coins · <span className="num">{summary.perCoin}</span> latest {interval} candles each</p>
            <p className="hidden sm:block">Hover a coin for its live price, click to select it. Hover a filament to see its candle.</p>
            {error && <p className="text-rose-neon">{error}</p>}
          </>
        ) : (
          <p role="status">{error ? 'No market data, so nothing is drawn.' : 'Loading Binance candles…'}</p>
        )}
      </div>

      <dl className="pointer-events-none absolute right-3 top-3 hidden max-w-[240px] grid-cols-[auto_1fr] gap-x-2 text-[11px] leading-relaxed text-mute lg:grid">
        <dt className="text-slate-300">Each filament</dt><dd>one candle</dd>
        <dt className="text-slate-300">Around each arc</dt><dd>time, oldest to newest</dd>
        <dt className="text-slate-300">Nearer the rim</dt><dd>higher close</dd>
        <dt className="text-slate-300">Length</dt><dd>high-low range</dd>
        <dt className="text-slate-300">Direction</dt><dd>candle up or down</dd>
        <dt className="text-slate-300">Brightness</dt><dd>traded volume</dd>
        <dt className="text-slate-300">Spikes</dt><dd>top 12% by volume</dd>
        <dt className="text-slate-300">Brightest lines</dt><dd>top 2% price moves</dd>
        <dt className="text-slate-300">Pulses</dt><dd>speed: trades; glow: current volume</dd>
        <dt className="text-slate-300">White flash</dt><dd>live tick, newest candles</dd>
        <dt className="text-slate-300">Arcs over ring</dt><dd>{LINK_COUNT} most correlated coin pairs</dd>
      </dl>

      <p className="pointer-events-none absolute bottom-2 left-3 right-3 text-[10px] leading-tight text-mute">
        A visual summary of Binance price data. It does not show blockchain transactions or money moving between coins.
      </p>

      {hoverCoin && (
        <div
          data-coin-tip
          className="pointer-events-none absolute z-10 w-48 rounded border border-ink-600 bg-ink-950/95 p-2 text-[11px] leading-relaxed text-slate-300"
          style={{ left: Math.max(4, Math.min(hoverCoin.x - 96, hoverCoin.width - 196)), top: Math.max(4, Math.min(hoverCoin.y, hoverCoin.height - 120)) }}
        >
          <p className="font-semibold text-slate-100">{nameOf(hoverCoin.symbol)} <span className="text-mute">{baseOf(hoverCoin.symbol)}/USDT</span></p>
          {liveTick ? (
            <>
              <p className="num text-sm text-slate-100">{price(liveTick.lastPrice)}</p>
              <p className="num">{pct(liveTick.priceChangePercent)} 24h · ${compact(liveTick.quoteVolume)}</p>
            </>
          ) : <p className="text-amber-neon">No live price</p>}
          {info && !info.error && <p className="num text-mute">{info.trend} · RSI {info.rsi === null ? '—' : info.rsi.toFixed(1)}</p>}
        </div>
      )}

      {c && !hoverCoin && (
        <div
          data-torus-tip
          className="pointer-events-none absolute z-10 w-52 rounded border border-ink-600 bg-ink-950/95 p-2 text-[11px] leading-relaxed text-slate-300"
          style={{ left: Math.max(4, Math.min(hovered.x + 12, hovered.width - 212)), top: Math.max(4, hovered.y - 110) }}
        >
          <p className="font-semibold text-slate-100">{baseOf(hovered.symbol)}/USDT · {interval}{c.closed ? '' : ' · forming'}</p>
          <p className="text-mute">{fmtTime(c.openTime)}</p>
          <p className="num">O {price(c.open)} H {price(c.high)}</p>
          <p className="num">L {price(c.low)} C {price(c.close)}</p>
          <p className="num">
            <span className={change >= 0 ? 'text-lime-neon' : 'text-rose-neon'}>{pct(change)}</span>
            {' · '}${compact(c.quoteVolume)} · {c.trades.toLocaleString('en-US')} trades
          </p>
        </div>
      )}
    </div>
  );
});
