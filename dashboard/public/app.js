'use strict';
/* global TimeChart */

const $ = (id) => document.getElementById(id);

const COLORS = {
  pv: '#34d399',
  load: '#fbbf24',
  bus: '#38bdf8',
  net: '#a78bfa',
  crit: '#fb7185',
  save: '#fb923c',
};

const state = {
  range: '15m',
  paused: false,
  feedFrozen: false,
  connected: false,
  summary: null,
  series: null,
  events: null,
  peakW: 5,
  es: null,
  lastMessageAt: 0,
  controlEnabled: false,
};

/* ───────────────────────────── charts ───────────────────────────── */

let chartPower;
let chartBus;
let chartCurrent;

function initCharts() {
  chartPower = new TimeChart($('chartPower'), {
    unit: 'W',
    series: [
      { key: 'pvP', label: 'PV harvest', color: COLORS.pv, fill: true, unit: 'W' },
      { key: 'loadP', label: 'Load demand', color: COLORS.load, fill: false, unit: 'W', width: 2 },
      { key: 'netP', label: 'Net', color: COLORS.net, fill: false, unit: 'W', width: 1.5, dashed: true },
    ],
  });
  chartBus = new TimeChart($('chartBus'), {
    unit: 'V',
    series: [{ key: 'bus', label: 'Bus voltage', color: COLORS.bus, fill: true, unit: 'V' }],
    thresholds: [
      { value: 12.4, label: 'LVD 12.40', color: 'rgba(251,113,133,0.85)' },
      { value: 12.45, label: 'gate 12.45', color: 'rgba(251,191,36,0.8)' },
    ],
  });
  chartCurrent = new TimeChart($('chartCurrent'), {
    unit: 'A',
    series: [
      { key: 'pvI', label: 'PV current', color: COLORS.pv, fill: true, unit: 'A' },
      { key: 'loadI', label: 'Load current', color: COLORS.load, fill: false, unit: 'A' },
    ],
  });

  buildLegend('legendPower', chartPower, [
    { key: 'pvP', label: 'PV harvest', color: COLORS.pv },
    { key: 'loadP', label: 'Load demand', color: COLORS.load },
    { key: 'netP', label: 'Net', color: COLORS.net },
  ]);
  buildLegend('legendBus', chartBus, [{ key: 'bus', label: 'Bus voltage', color: COLORS.bus }]);
  buildLegend('legendCurrent', chartCurrent, [
    { key: 'pvI', label: 'PV current', color: COLORS.pv },
    { key: 'loadI', label: 'Load current', color: COLORS.load },
  ]);
}

function buildLegend(elOrId, chart, defs) {
  const host = typeof elOrId === 'string' ? $(elOrId) : elOrId;
  if (!host) return;
  host.innerHTML = '';
  for (const d of defs) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.innerHTML = `<i style="background:${d.color}"></i>${d.label}`;
    btn.addEventListener('click', () => {
      const hidden = btn.classList.toggle('off');
      chart.cfg.series = chart.cfg.series.filter((s) => s.key !== d.key || !hidden);
      if (!chart.cfg.series.some((s) => s.key === d.key) && !hidden) {
        // re-add at original position
        const all = {
          pvP: { key: 'pvP', label: 'PV harvest', color: COLORS.pv, fill: true, unit: 'W' },
          loadP: { key: 'loadP', label: 'Load demand', color: COLORS.load, fill: false, unit: 'W' },
          netP: { key: 'netP', label: 'Net', color: COLORS.net, fill: false, unit: 'W', width: 1.5, dashed: true },
          bus: { key: 'bus', label: 'Bus voltage', color: COLORS.bus, fill: true, unit: 'V' },
          pvI: { key: 'pvI', label: 'PV current', color: COLORS.pv, fill: true, unit: 'A' },
          loadI: { key: 'loadI', label: 'Load current', color: COLORS.load, fill: false, unit: 'A' },
        };
        chart.cfg.series.push(all[d.key]);
      }
      chart.render();
    });
    host.appendChild(btn);
  }
}

/* ───────────────────────────── formatting ───────────────────────────── */

const DASH = '—';

function n(v, digits = 2) {
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return DASH;
  return Number(v).toFixed(digits);
}

function clock(ms) {
  if (!ms) return DASH;
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour12: false });
}

function dur(sec) {
  if (sec === null || sec === undefined) return DASH;
  const s = Math.round(sec);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function ago(ms) {
  if (ms === null || ms === undefined) return DASH;
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 2) return 'now';
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

const pvPowerOf = (s) => s?.pv?.p ?? (s?.pv?.v != null && s?.pv?.i != null ? s.pv.v * s.pv.i : null);
const loadPowerOf = (s) => s?.load?.p ?? (s?.load?.v != null && s?.load?.i != null ? s.load.v * s.load.i : null);

/* ───────────────────────────── data loading ───────────────────────────── */

const RANGE_MS = { '1m': 60e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3, '1h': 3600e3, '6h': 21600e3, '24h': 86400e3, all: Infinity };

async function loadSeries() {
  if (state.paused) return;
  try {
    const res = await fetch(`/api/series?range=${state.range}&points=520`);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();

    // derive net power series
    data.netP = (data.pvP || []).map((pv, i) => {
      const ld = data.loadP?.[i];
      if (pv === null && ld === null) return null;
      return (pv ?? 0) - (ld ?? 0);
    });

    let peak = 1;
    for (const arr of [data.pvP, data.loadP]) for (const v of arr || []) if (Number.isFinite(v)) peak = Math.max(peak, v);
    state.peakW = Math.max(5, peak * 1.15);

    state.series = data;
    chartPower.setData(data);
    chartBus.setData(data);
    chartCurrent.setData(data);
    renderRibbon(data);
    updateRateAndShare(data);
  } catch (e) {
    console.warn('[series]', e.message);
  }
}

async function loadEvents() {
  try {
    const res = await fetch(`/api/events?range=${state.range === 'all' ? 'all' : state.range}`);
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    state.events = data;
    renderEvents(data);
    if (!state.paused) updateShedKpi(data);
  } catch (e) {
    console.warn('[events]', e.message);
  }
}

/* ───────────────────────────── rendering ───────────────────────────── */

function applySummary(s) {
  if (!s) return;
  state.summary = s;
  const last = s.latest;
  const now = Date.now();

  /* connection / source */
  const ageMs = s.ageMs ?? (last ? now - last.t : null);
  setConn(ageMs === null ? 'down' : ageMs < 15000 ? 'live' : ageMs < 60000 ? 'stale' : 'down', ageMs);

  const srcs = Object.keys(s.sources || {});
  const srcLabel = s.server?.simulate ? 'simulation' : srcs.includes('serial') ? 'serial bridge' : srcs.includes('thingspeak') ? 'ThingSpeak' : srcs[0] || 'none';
  $('sourceText').textContent = srcLabel;
  $('stSource').textContent = srcLabel;
  $('stBuffer').textContent = s.buffer ? `${s.buffer.toLocaleString()} samples` : DASH;
  $('stUptime').textContent = dur(s.uptimeS);

  state.controlEnabled = Boolean(s.control?.enabled);
  document.querySelectorAll('.cbtn').forEach((b) => { b.disabled = !state.controlEnabled; });
  $('controlHint').textContent = state.controlEnabled
    ? 'Queued for the bridge · applies in ≤2 s'
    : 'Control disabled on this server';

  renderAlerts(s.alerts || []);

  if (state.paused) return;

  /* KPIs */
  const pvP = pvPowerOf(last);
  const ldP = loadPowerOf(last);
  const net = pvP !== null && ldP !== null ? pvP - ldP : null;

  $('kpiPvP').textContent = n(pvP, 2);
  $('kpiPvV').textContent = n(last?.pv?.v, 2);
  $('kpiPvI').textContent = n(last?.pv?.i, 3);
  $('kpiLoadP').textContent = n(ldP, 2);
  $('kpiLoadV').textContent = n(last?.load?.v, 2);
  $('kpiLoadI').textContent = n(last?.load?.i, 3);
  $('kpiNet').textContent = net === null ? DASH : (net >= 0 ? '+' : '') + n(net, 2);
  $('kpiNetSub').textContent = net === null ? 'harvest − demand'
    : net >= 0 ? `surplus → charging storage` : `deficit → drawing from storage`;
  $('netTag').textContent = net === null ? '—' : net >= 0 ? 'charging' : 'discharging';

  const bus = last?.bus ?? last?.load?.v ?? null;
  $('kpiBus').textContent = n(bus, 3);
  $('kpiBusSub').textContent = bus === null ? 'LVD 12.40 V · gate 12.45 V'
    : bus < 12.4 ? 'below LVD — protection active'
    : bus < 12.45 ? 'between LVD and restore gate'
    : 'healthy — above 12.45 V gate';

  $('kpiPvWh').textContent = n(s.energy?.pvWh, 1);
  $('kpiLoadWh').textContent = n(s.energy?.loadWh, 1);
  $('kpiNetWh').textContent = n(s.energy?.netWh, 1);

  /* bars */
  $('kpiPvBar').style.width = pct(pvP, state.peakW);
  $('kpiLoadBar').style.width = pct(ldP, state.peakW);
  const netPct = net === null ? 50 : 50 + Math.max(-50, Math.min(50, (net / state.peakW) * 50));
  $('kpiNetBar').style.left = Math.min(50, netPct) + '%';
  $('kpiNetBar').style.width = Math.abs(netPct - 50) + '%';
  $('kpiNetBar').style.right = 'auto';
  $('kpiBusBar').style.width = bus === null ? '0%' : Math.max(0, Math.min(100, ((bus - 11.8) / 1.0) * 100)) + '%';
  const e = s.energy || {};
  $('kpiEnergyBar').style.width = pct(e.pvWh, (e.pvWh || 0) + (e.loadWh || 0) || 1);

  /* state chip + pipeline */
  const mode = last?.mode || (last?.relay ? 'NORMAL' : last?.relay === false ? 'SAVE' : null);
  renderModeChip(mode);
  renderPipeline(last, mode);

  /* stats */
  $('stLast').textContent = last ? `${clock(last.t)} · ${ago(now - last.t)}` : DASH;
  $('stSamples').textContent = s.windowSamples != null ? s.windowSamples.toLocaleString() : DASH;

  renderModeShare(s.modes || {});
}

function pct(v, max) {
  if (v === null || v === undefined || !Number.isFinite(v) || !max) return '0%';
  return Math.max(0, Math.min(100, (Math.abs(v) / max) * 100)).toFixed(1) + '%';
}

function setConn(kind, ageMs) {
  const pill = $('connPill');
  const txt = $('connText');
  pill.classList.remove('live', 'demo', 'down');
  if (kind === 'live') {
    pill.classList.add(state.summary?.server?.simulate ? 'demo' : 'live');
    txt.textContent = state.summary?.server?.simulate ? 'demo data' : 'live';
  } else if (kind === 'stale') {
    pill.classList.add('demo');
    txt.textContent = `stale · ${ago(ageMs)}`;
  } else {
    pill.classList.add('down');
    txt.textContent = 'offline';
  }
}

function renderAlerts(alerts) {
  const wrap = $('alerts');
  if (!alerts.length) { wrap.hidden = true; wrap.innerHTML = ''; return; }
  wrap.hidden = false;
  wrap.innerHTML = alerts
    .slice(0, 4)
    .map((a) => `<div class="alert ${a.level}">${escapeHtml(a.msg)}</div>`)
    .join('');
}

function renderModeChip(mode) {
  const chip = $('modeChip');
  const m = String(mode || '').toUpperCase();
  chip.textContent = m || '—';
  chip.className = 'mode-chip';
  if (/SAVE/.test(m)) chip.classList.add('save');
  else if (/NORMAL|AUTO/.test(m)) chip.classList.add('normal');
  else if (/MANUAL/.test(m)) chip.classList.add('manual');
  document.querySelectorAll('.cbtn').forEach((b) => {
    b.classList.toggle('is-active', m.includes(b.dataset.cmd));
  });
}

function renderPipeline(last, mode) {
  const pvP = pvPowerOf(last);
  const ldP = loadPowerOf(last);
  const set = (id, cls, val) => {
    const li = document.querySelector(`.pipeline li[data-node="${id}"]`);
    if (!li) return;
    li.classList.remove('on', 'warn', 'off');
    if (cls) li.classList.add(cls);
    const el = $(`node${id[0].toUpperCase()}${id.slice(1)}`);
    if (el) el.textContent = val;
  };

  set('panel', pvP > 0.05 ? 'on' : 'off', pvP === null ? DASH : `${n(pvP, 2)} W`);
  set('ina41', last?.pv?.v != null ? 'on' : 'off', last?.pv?.v == null ? 'no data' : `${n(last.pv.v, 2)} V`);
  set('esp32', mode ? 'on' : 'warn', mode || 'waiting');
  const relay = last?.relay;
  set('relay', relay === true ? 'on' : relay === false ? 'off' : 'warn', relay === true ? 'ON' : relay === false ? 'OFF' : '—');
  set('primary', ldP !== null ? 'on' : 'warn', ldP === null ? DASH : `${n(ldP, 2)} W bus`);
  set('ina40', last?.load?.v != null ? 'on' : 'off', last?.load?.v == null ? 'no data' : `${n(last.load.v, 2)} V`);
}

function renderModeShare(modes) {
  let normal = 0;
  let save = 0;
  for (const [k, v] of Object.entries(modes)) {
    if (/SAVE/.test(k)) save += v;
    else if (/NORMAL|AUTO/.test(k)) normal += v;
  }
  const total = normal + save;
  const np = total ? (normal / total) * 100 : 0;
  const sp = total ? (save / total) * 100 : 0;
  $('splitNormal').style.width = np + '%';
  $('splitSave').style.width = sp + '%';
  $('splitNormalTxt').textContent = `NORMAL ${np.toFixed(0)}%`;
  $('splitSaveTxt').textContent = `SAVE ${sp.toFixed(0)}%`;
}

function renderRibbon(data) {
  const el = $('ribbon');
  const t = data.t || [];
  const modes = data.mode || [];
  if (t.length < 2) { el.innerHTML = ''; return; }
  const segs = [];
  for (let i = 1; i < t.length; i++) {
    const label = modes[i] || modes[i - 1] || null;
    const kind = !label ? 'idle' : /SAVE/.test(label) ? 'save' : 'normal';
    const dt = Math.max(0, t[i] - t[i - 1]);
    const prev = segs[segs.length - 1];
    if (prev && prev.kind === kind) prev.dt += dt;
    else segs.push({ kind, dt, label, from: t[i - 1], to: t[i] });
  }
  const totalDt = segs.reduce((a, s) => a + s.dt, 0) || 1;
  el.innerHTML = segs
    .map((s) => `<span class="r-${s.kind}" style="flex:${(s.dt / totalDt) * 100} 1 0"
      title="${clock(s.from)} → ${clock(s.to)} · ${escapeHtml(s.label || 'no data')}"></span>`)
    .join('');
}

function updateRateAndShare(data) {
  const t = data.t || [];
  if (t.length > 1) {
    const spanS = (t[t.length - 1] - t[0]) / 1000;
    const rate = spanS > 0 ? (data.points - 1) / spanS : 0;
    $('stRate').textContent = rate >= 0.5 ? `${rate.toFixed(1)} /s` : `${(rate * 60).toFixed(1)} /min`;
  } else {
    $('stRate').textContent = DASH;
  }
}

function renderEvents(data) {
  const body = $('eventsBody');
  const rows = (data.intervals || []).slice().reverse().slice(0, 60);
  $('eventBadge').textContent = `${(data.sheddingEvents || []).length} shed events`;
  if (!rows.length) {
    body.innerHTML = '<tr class="empty"><td colspan="6">No transitions recorded yet.</td></tr>';
    return;
  }
  body.innerHTML = rows
    .map((iv) => {
      const isSave = /SAVE/.test(iv.label) || iv.relay === false;
      const red = iv.reductionPct;
      const redTxt = red === null || red === undefined ? '—' : `${red > 0 ? '−' : '+'}${Math.abs(red).toFixed(1)}%`;
      return `<tr>
        <td>${clock(iv.from)}</td>
        <td><span class="state-pill ${isSave ? 'save' : 'normal'}">${escapeHtml(iv.label)}</span></td>
        <td>${dur(iv.durationS)}</td>
        <td class="num">${n(iv.meanLoadW, 2)} W</td>
        <td class="num">${n(iv.meanBusV, 3)} V</td>
        <td class="num"><span class="shed-badge ${red == null ? 'none' : ''}">${redTxt}</span></td>
      </tr>`;
    })
    .join('');
}

function updateShedKpi(data) {
  const red = data.avgReductionPct;
  const count = (data.sheddingEvents || []).length;
  $('kpiShed').textContent = red === null || red === undefined ? DASH : red.toFixed(1);
  $('kpiShedSub').textContent = count
    ? `${count} shed interval${count === 1 ? '' : 's'} · vs last NORMAL`
    : 'no shedding in window';
  $('kpiShedBar').style.width = red ? Math.max(0, Math.min(100, red)) + '%' : '0%';
}

/* ───────────────────────────── live feed ───────────────────────────── */

let feedLines = 0;

function appendFeed(s) {
  if (state.feedFrozen) return;
  const pre = $('feed');
  if (feedLines === 0) pre.innerHTML = '';
  const mode = String(s.mode || '—');
  const cls = /SAVE/.test(mode) ? 'mode-save' : 'mode-normal';
  const pvP = pvPowerOf(s);
  const ldP = loadPowerOf(s);
  const line =
    `<span class="ts">${clock(s.t)}</span>  ` +
    `PV <span class="v-pv">${pad(n(s.pv?.v, 2), 6)}V ${pad(n(s.pv?.i, 3), 6)}A ${pad(n(pvP, 2), 6)}W</span>` +
    `  │  LOAD <span class="v-load">${pad(n(s.load?.v, 2), 6)}V ${pad(n(s.load?.i, 3), 6)}A ${pad(n(ldP, 2), 6)}W</span>` +
    `  │  BUS <span class="v-bus">${pad(n(s.bus, 3), 7)}V</span>` +
    `  │  <span class="${cls}">${escapeHtml(mode)}</span>` +
    ` relay=${s.relay === true ? 'ON' : s.relay === false ? 'OFF' : '?'}`;

  const div = document.createElement('span');
  div.className = 'ln';
  div.innerHTML = line;
  pre.appendChild(div);
  feedLines++;
  while (pre.childElementCount > 250) pre.removeChild(pre.firstElementChild);
  const nearBottom = pre.scrollHeight - pre.scrollTop - pre.clientHeight < 80;
  if (nearBottom) pre.scrollTop = pre.scrollHeight;
  $('feedBadge').textContent = `${feedLines} lines`;
}

const pad = (s, len) => String(s).padStart(len, ' ');

/* ───────────────────────────── live connection ───────────────────────────── */

function connect() {
  if (state.es) state.es.close();
  const es = new EventSource(`/api/stream?range=${state.range}`);
  state.es = es;

  es.addEventListener('hello', (ev) => {
    state.connected = true;
    const d = safeParse(ev.data);
    if (d?.summary) applySummary(d.summary);
  });

  es.addEventListener('summary', (ev) => {
    state.lastMessageAt = Date.now();
    const d = safeParse(ev.data);
    if (d) applySummary(d);
  });

  es.addEventListener('sample', (ev) => {
    state.lastMessageAt = Date.now();
    const d = safeParse(ev.data);
    if (d) appendFeed(d);
  });

  es.onopen = () => { state.connected = true; };
  es.onerror = () => {
    state.connected = false;
    setConn('down', null);
  };
}

function safeParse(str) {
  try { return JSON.parse(str); } catch { return null; }
}

/* polling fallback if SSE is blocked by a proxy */
setInterval(async () => {
  if (state.lastMessageAt && Date.now() - state.lastMessageAt < 25000) return;
  try {
    const r = await fetch(`/api/summary?range=${state.range}`);
    if (r.ok) applySummary(await r.json());
  } catch { /* ignore */ }
}, 5000);

/* ───────────────────────────── controls ───────────────────────────── */

function initControls() {
  document.querySelectorAll('.seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.seg-btn').forEach((b) => b.classList.toggle('is-active', b === btn));
      state.range = btn.dataset.range;
      $('btnExport').href = `/api/export.csv?range=${state.range}`;
      connect();
      loadSeries();
      loadEvents();
    });
  });

  $('btnPause').addEventListener('click', () => {
    state.paused = !state.paused;
    $('btnPause').textContent = state.paused ? 'Resume' : 'Pause';
    $('btnPause').classList.toggle('is-on', state.paused);
    if (!state.paused) { loadSeries(); loadEvents(); }
  });

  $('btnFeedPause').addEventListener('click', () => {
    state.feedFrozen = !state.feedFrozen;
    $('btnFeedPause').textContent = state.feedFrozen ? 'Unfreeze' : 'Freeze';
    $('btnFeedPause').classList.toggle('is-on', state.feedFrozen);
  });

  document.querySelectorAll('.cbtn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const cmd = btn.dataset.cmd;
      try {
        const res = await fetch('/api/command', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ cmd, by: 'dashboard' }),
        });
        const d = await res.json();
        if (!d.ok) throw new Error(d.error || 'rejected');
        $('controlHint').textContent = `${cmd} queued at ${clock(Date.now())}`;
      } catch (e) {
        $('controlHint').textContent = `failed: ${e.message}`;
      }
    });
  });

  // keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea')) return;
    if (e.key === ' ') { e.preventDefault(); $('btnPause').click(); }
    if (/^[1-5]$/.test(e.key)) {
      const btns = document.querySelectorAll('.seg-btn');
      btns[Number(e.key) - 1]?.click();
    }
  });
}

/* ───────────────────────────── boot ───────────────────────────── */

function tickClock() {
  $('footClock').textContent = new Date().toLocaleTimeString([], { hour12: false });
  // smooth "x s ago" without a server round-trip
  const last = state.summary?.latest;
  if (last && !state.paused) $('stLast').textContent = `${clock(last.t)} · ${ago(Date.now() - last.t)}`;
}

function boot() {
  initCharts();
  initControls();
  connect();
  loadSeries().then(loadEvents);
  setInterval(() => { if (!state.paused) loadSeries(); }, 4000);
  setInterval(loadEvents, 15000);
  setInterval(tickClock, 1000);
  tickClock();
}

if (document.readyState === 'loading')document.addEventListener('DOMContentLoaded', boot);
else boot();
