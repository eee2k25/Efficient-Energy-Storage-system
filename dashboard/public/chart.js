'use strict';
/**
 * TimeChart — tiny dependency-free canvas time-series chart.
 *
 *   const chart = new TimeChart(canvas, {
 *     unit: 'W',
 *     series: [{ key: 'pvP', label: 'PV power', color: '#34d399', fill: true }],
 *     thresholds: [{ value: 12.40, label: 'LVD 12.40 V', color: '#f87171' }],
 *   });
 *   chart.setData({ t: [...ms], pvP: [...] });
 *
 * Handles devicePixelRatio, container resize, null gaps, area gradients and a
 * hover crosshair with a DOM tooltip (no external libraries, works offline).
 */

class TimeChart {
  constructor(canvas, cfg = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.wrap = canvas.parentElement;
    this.cfg = {
      unit: '',
      series: [],
      thresholds: [],
      yMin: null,
      yMax: null,
      yTicks: 4,
      pad: { t: 16, r: 52, b: 26, l: 46 },
      xFormat: 'time',
      ...cfg,
    };
    this.data = { t: [] };
    this.hoverX = null;
    this.hoverIdx = null;

    this.tip = document.createElement('div');
    this.tip.className = 'chart-tip';
    this.wrap.appendChild(this.tip);

    this._onMove = this._onMove.bind(this);
    this._onLeave = this._onLeave.bind(this);
    canvas.addEventListener('pointermove', this._onMove);
    canvas.addEventListener('pointerleave', this._onLeave);

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(this.wrap);
    this.resize();
  }

  setData(data) {
    this.data = data && Array.isArray(data.t) ? data : { t: [] };
    this.render();
  }

  destroy() {
    this._ro.disconnect();
    this.canvas.removeEventListener('pointermove', this._onMove);
    this.canvas.removeEventListener('pointerleave', this._onLeave);
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const rect = this.wrap.getBoundingClientRect();
    this.w = Math.max(120, Math.floor(rect.width));
    this.h = Math.max(80, Math.floor(rect.height));
    this.canvas.width = Math.floor(this.w * dpr);
    this.canvas.height = Math.floor(this.h * dpr);
    this.canvas.style.width = this.w + 'px';
    this.canvas.style.height = this.h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.render();
  }

  _plot() {
    const { pad } = this.cfg;
    return { x0: pad.l, y0: pad.t, x1: this.w - pad.r, y1: this.h - pad.b };
  }

  _domain() {
    const { series, thresholds, yMin, yMax } = this.cfg;
    let lo = Infinity;
    let hi = -Infinity;
    for (const s of series) {
      const arr = this.data[s.key];
      if (!arr) continue;
      for (const v of arr) {
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    for (const th of thresholds) {
      if (Number.isFinite(th.value)) { lo = Math.min(lo, th.value); hi = Math.max(hi, th.value); }
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) { lo = 0; hi = 1; }
    if (hi - lo < 1e-6) { hi = lo + 1; }
    const padv = (hi - lo) * 0.14;
    lo -= padv; hi += padv;
    if (yMin !== null && Number.isFinite(yMin)) lo = yMin;
    if (yMax !== null && Number.isFinite(yMax)) hi = yMax;
    return { lo, hi };
  }

  render() {
    const ctx = this.ctx;
    if (!ctx || !this.w) return;
    const { x0, y0, x1, y1 } = this._plot();
    const W = x1 - x0;
    const H = y1 - y0;
    const t = this.data.t || [];
    const n = t.length;

    ctx.clearRect(0, 0, this.w, this.h);

    if (!n) {
      ctx.fillStyle = 'rgba(148,163,184,0.5)';
      ctx.font = '13px ui-sans-serif, system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Waiting for telemetry…', x0 + W / 2, y0 + H / 2);
      return;
    }

    const { lo, hi } = this._domain();
    const tMin = t[0];
    const tMax = t[n - 1];
    const span = Math.max(1, tMax - tMin);

    const X = (ms) => x0 + ((ms - tMin) / span) * W;
    const Y = (v) => y1 - ((v - lo) / (hi - lo)) * H;

    /* ---- grid + y labels ---- */
    const step = niceStep((hi - lo) / this.cfg.yTicks);
    const decimals = step < 0.1 ? 2 : step < 1 ? 1 : 0;
    ctx.font = '11px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) {
      const y = Y(v);
      if (y < y0 - 1 || y > y1 + 1) continue;
      ctx.strokeStyle = 'rgba(148,163,184,0.10)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(x0, Math.round(y) + 0.5);
      ctx.lineTo(x1, Math.round(y) + 0.5);
      ctx.stroke();
      ctx.fillStyle = 'rgba(148,163,184,0.65)';
      ctx.fillText(v.toFixed(decimals), x0 - 10, y);
    }

    /* ---- x axis labels ---- */
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = 'rgba(148,163,184,0.65)';
    const xTicks = this.w < 420 ? 3 : 5;
    for (let i = 0; i < xTicks; i++) {
      const frac = i / (xTicks - 1);
      const ms = tMin + span * frac;
      const x = x0 + W * frac;
      ctx.strokeStyle = 'rgba(148,163,184,0.07)';
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, y0);
      ctx.lineTo(Math.round(x) + 0.5, y1);
      ctx.stroke();
      ctx.fillText(this._timeLabel(ms, span), Math.min(x1 - 14, Math.max(x0 + 14, x)), y1 + 8);
    }

    /* ---- threshold lines ---- */
    for (const th of this.cfg.thresholds) {
      if (!Number.isFinite(th.value) || th.value < lo || th.value > hi) continue;
      const y = Y(th.value);
      ctx.save();
      ctx.setLineDash([5, 4]);
      ctx.strokeStyle = th.color || 'rgba(248,113,113,0.7)';
      ctx.globalAlpha = 0.85;
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.moveTo(x0, y);
      ctx.lineTo(x1, y);
      ctx.stroke();
      ctx.restore();
      if (th.label) {
        ctx.font = '10px ui-monospace, Menlo, monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'bottom';
        ctx.fillStyle = th.color || '#f87171';
        ctx.fillText(th.label, x1 - 2, y - 3);
      }
    }

    /* ---- series ---- */
    for (const s of this.cfg.series) {
      const arr = this.data[s.key];
      if (!arr) continue;
      const pts = [];
      for (let i = 0; i < n; i++) {
        const v = arr[i];
        pts.push(v === null || v === undefined || !Number.isFinite(v) ? null : { x: X(t[i]), y: Y(v) });
      }
      const segments = splitNulls(pts);

      if (s.fill) {
        for (const seg of segments) {
          if (seg.length < 2) continue;
          const grad = ctx.createLinearGradient(0, y0, 0, y1);
          grad.addColorStop(0, hexA(s.color, 0.30));
          grad.addColorStop(1, hexA(s.color, 0.02));
          ctx.beginPath();
          ctx.moveTo(seg[0].x, y1);
          for (const p of seg) ctx.lineTo(p.x, p.y);
          ctx.lineTo(seg[seg.length - 1].x, y1);
          ctx.closePath();
          ctx.fillStyle = grad;
          ctx.fill();
        }
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width || 2;
      ctx.lineJoin = 'round';
      ctx.lineCap = 'round';
      if (s.dashed) ctx.setLineDash([4, 4]);
      for (const seg of segments) {
        if (seg.length === 1) {
          ctx.beginPath();
          ctx.arc(seg[0].x, seg[0].y, 1.6, 0, Math.PI * 2);
          ctx.fillStyle = s.color;
          ctx.fill();
          continue;
        }
        ctx.beginPath();
        ctx.moveTo(seg[0].x, seg[0].y);
        for (let i = 1; i < seg.length; i++) ctx.lineTo(seg[i].x, seg[i].y);
        ctx.stroke();
      }
      ctx.setLineDash([]);
    }

    /* ---- hover crosshair ---- */
    if (this.hoverIdx !== null && this.hoverIdx >= 0 && this.hoverIdx < n) {
      const hx = X(t[this.hoverIdx]);
      ctx.save();
      ctx.strokeStyle = 'rgba(226,232,240,0.35)';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(Math.round(hx) + 0.5, y0);
      ctx.lineTo(Math.round(hx) + 0.5, y1);
      ctx.stroke();
      ctx.restore();
      for (const s of this.cfg.series) {
        const v = this.data[s.key]?.[this.hoverIdx];
        if (v === null || v === undefined || !Number.isFinite(v)) continue;
        ctx.beginPath();
        ctx.arc(hx, Y(v), 3.4, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.strokeStyle = '#0b1016';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
  }

  _timeLabel(ms, span) {
    const d = new Date(ms);
    const p = (x) => String(x).padStart(2, '0');
    if (span > 20 * 3600e3) return `${p(d.getHours())}:${p(d.getMinutes())}`;
    if (span > 90e3) return `${p(d.getHours())}:${p(d.getMinutes())}`;
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  }

  _onMove(ev) {
    const rect = this.canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const { x0, x1 } = this._plot();
    const t = this.data.t || [];
    if (!t.length || x < x0 - 4 || x > x1 + 4) return this._onLeave();
    const tMin = t[0];
    const tMax = t[t.length - 1];
    const target = tMin + ((x - x0) / (x1 - x0)) * Math.max(1, tMax - tMin);

    // nearest sample index
    let lo = 0;
    let hi = t.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (t[mid] < target) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0 && Math.abs(t[lo - 1] - target) < Math.abs(t[lo] - target)) lo -= 1;

    this.hoverIdx = lo;
    this.render();
    this._tooltip(x, t[lo], lo);
  }

  _tooltip(x, ms, idx) {
    const rows = this.cfg.series
      .map((s) => {
        const v = this.data[s.key]?.[idx];
        if (v === null || v === undefined || !Number.isFinite(v)) return '';
        return `<div class="tip-row"><span class="tip-dot" style="background:${s.color}"></span>
          <span class="tip-label">${escapeHtml(s.label)}</span>
          <span class="tip-val">${fmtNum(v)}<i>${escapeHtml(s.unit ?? this.cfg.unit)}</i></span></div>`;
      })
      .join('');
    if (!rows) return this._onLeave();
    const d = new Date(ms);
    this.tip.innerHTML = `<div class="tip-time">${d.toLocaleTimeString()}</div>${rows}`;
    this.tip.classList.add('show');
    const tw = this.tip.offsetWidth || 150;
    const left = Math.min(this.w - tw - 8, Math.max(4, x - tw / 2));
    this.tip.style.transform = `translate(${left}px, 6px)`;
  }

  _onLeave() {
    this.hoverIdx = null;
    this.hoverX = null;
    this.tip.classList.remove('show');
    this.render();
  }
}

function niceStep(raw) {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const exp = Math.floor(Math.log10(raw));
  const f = raw / Math.pow(10, exp);
  const nf = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nf * Math.pow(10, exp);
}

function splitNulls(pts) {
  const out = [];
  let cur = [];
  for (const p of pts) {
    if (p === null) { if (cur.length) out.push(cur); cur = []; }
    else cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

function hexA(hex, a) {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const r = parseInt(full.slice(0, 2), 16);
  const g = parseInt(full.slice(2, 4), 16);
  const b = parseInt(full.slice(4, 6), 16);
  return `rgba(${r},${g},${b},${a})`;
}

function fmtNum(v) {
  const a = Math.abs(v);
  if (a >= 100) return v.toFixed(1);
  if (a >= 10) return v.toFixed(2);
  return v.toFixed(3).replace(/0$/, '');
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

window.TimeChart = TimeChart;
window.fmtNum = fmtNum;
window.escapeHtml = escapeHtml;
