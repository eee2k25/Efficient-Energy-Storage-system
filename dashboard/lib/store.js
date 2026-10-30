'use strict';
/**
 * In-memory ring buffer + append-only JSONL persistence for telemetry samples.
 *
 * A "sample" is one snapshot of the microgrid:
 * {
 *   t:     epoch milliseconds
 *   pv:    { v, i, p }   PV INA219 (0x41)  -- panel voltage / current / power
 *   load:  { v, i, p }   Load INA219 (0x40) -- load-bus voltage / current / power
 *   bus:   volts         battery-voltage proxy (load INA bus volts unless supplied)
 *   mode:  'AUTO' | 'SAVE' | 'NORMAL' | 'MANUAL'
 *   relay: true | false  secondary LED relay state
 *   soc:   percent|null  estimated state of charge (optional)
 *   src:   'serial' | 'thingspeak' | 'sim'
 * }
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const SAMPLES_FILE = path.join(DATA_DIR, 'samples.jsonl');
const STATE_FILE = path.join(DATA_DIR, 'state.json');

const RING_MAX = Number(process.env.RING_MAX || 250000); // ~2.9 days @ 1 Hz
const FLUSH_MS = 4000;

const num = (x) => {
  if (x === null || x === undefined || x === '') return null;
  const n = Number(x);
  return Number.isFinite(n) ? n : null;
};
const r3 = (n) => (n === null ? null : Math.round(n * 1000) / 1000);

function normalize(raw, fallbackSrc) {
  if (!raw || typeof raw !== 'object') return null;

  const pvV = num(raw.pv?.v ?? raw.pvV ?? raw.pv_voltage);
  const pvI = num(raw.pv?.i ?? raw.pvI ?? raw.pv_current);
  const pvP = num(raw.pv?.p ?? raw.pvP ?? raw.pv_power);
  const ldV = num(raw.load?.v ?? raw.loadV ?? raw.load_voltage ?? raw.bus);
  const ldI = num(raw.load?.i ?? raw.loadI ?? raw.load_current);
  const ldP = num(raw.load?.p ?? raw.loadP ?? raw.load_power);

  // A sample is only useful if it carries at least one real measurement.
  if (pvV === null && pvI === null && pvP === null && ldV === null && ldI === null && ldP === null) {
    return null;
  }

  let t = raw.t ?? raw.ts ?? raw.timestamp;
  if (typeof t === 'string') {
    const parsed = Date.parse(t);
    t = Number.isFinite(parsed) ? parsed : Number(t);
  } else if (typeof t === 'number' && t < 1e12) {
    t = t * 1000; // tolerate unix seconds
  }
  t = Number.isFinite(t) ? Math.round(t) : Date.now();

  const mode = String(raw.mode ?? raw.state ?? raw.command ?? '').trim().toUpperCase() || null;
  let relay = raw.relay;
  if (typeof relay === 'string') relay = /^(1|true|on|closed)$/i.test(relay.trim());

  const bus = r3(num(raw.bus) ?? ldV);

  return {
    t,
    pv: { v: r3(pvV), i: r3(pvI), p: r3(pvP) },
    load: { v: r3(ldV), i: r3(ldI), p: r3(ldP) },
    bus,
    mode: mode || null,
    relay: typeof relay === 'boolean' ? relay : null,
    soc: r3(num(raw.soc)),
    src: String(raw.src || fallbackSrc || 'serial'),
  };
}

class Store {
  constructor() {
    this.samples = [];
    this.seq = 0;
    this.lastSample = null;
    this.sources = {};       // src -> last seen epoch ms
    this.commands = [];      // queued control commands for the bridge
    this.nextCommandId = 1;
    this.pending = [];
    this.energy = { pvWh: 0, loadWh: 0, day: this.today() };
    this.startedAt = Date.now();
    this._loadState();
    this._replayTail();
    this._flushTimer = setInterval(() => this.flush(), FLUSH_MS);
    this._flushTimer.unref?.();
  }

  today() {
    return new Date().toISOString().slice(0, 10);
  }

  /* ---------------------------------------------------------------- ingest */

  add(raw, src) {
    const s = normalize(raw, src);
    if (!s) return null;

    const prev = this.lastSample;
    if (prev) {
      const dtH = Math.max(0, (s.t - prev.t) / 3600000);
      // ignore absurd gaps (>10 min) so a laptop-off overnight does not fake energy
      if (dtH > 0 && dtH < 10 / 60) {
        const pvPrev = prev.pv.p ?? (prev.pv.v != null && prev.pv.i != null ? prev.pv.v * prev.pv.i : null);
        const pvNow = s.pv.p ?? (s.pv.v != null && s.pv.i != null ? s.pv.v * s.pv.i : null);
        const ldPrev = prev.load.p ?? (prev.load.v != null && prev.load.i != null ? prev.load.v * prev.load.i : null);
        const ldNow = s.load.p ?? (s.load.v != null && s.load.i != null ? s.load.v * s.load.i : null);
        if (pvNow != null && pvPrev != null) this.energy.pvWh += ((pvPrev + pvNow) / 2) * dtH;
        if (ldNow != null && ldPrev != null) this.energy.loadWh += ((ldPrev + ldNow) / 2) * dtH;
        if (this.energy.day !== this.today()) {
          this.energy = { pvWh: 0, loadWh: 0, day: this.today() };
        }
      } else if (dtH >= 10 / 60) {
        this.energy = { pvWh: this.energy.pvWh, loadWh: this.energy.loadWh, day: this.today() };
      }
    }

    // monotonic ordering: never let an out-of-order packet corrupt charts
    if (prev && s.t < prev.t) s.t = prev.t + 1;

    this.samples.push(s);
    if (this.samples.length > RING_MAX) this.samples.splice(0, this.samples.length - RING_MAX);

    this.lastSample = s;
    this.sources[s.src] = Date.now();
    this.pending.push(s);
    this.seq += 1;
    return s;
  }

  /* ----------------------------------------------------------- query APIs */

  /** Samples newer than `fromMs` (inclusive). */
  since(fromMs) {
    const arr = this.samples;
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].t < fromMs) lo = mid + 1;
      else hi = mid;
    }
    return arr.slice(lo);
  }

  range(rangeKey, now = Date.now()) {
    const map = {
      '1m': 60e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3,
      '1h': 3600e3, '6h': 21600e3, '24h': 86400e3, all: Infinity,
    };
    const ms = map[rangeKey] ?? map['15m'];
    if (ms === Infinity) return this.samples.slice();
    return this.since(now - ms);
  }

  /**
   * Bucket-average a window down to <= maxPoints so the browser never has to
   * draw 100k points. Each bucket keeps avg/min/max so peaks are not hidden.
   */
  series(rangeKey, maxPoints = 480, now = Date.now()) {
    const src = this.range(rangeKey, now);
    const out = {
      range: rangeKey,
      points: 0,
      t: [], pvP: [], pvV: [], pvI: [],
      loadP: [], loadV: [], loadI: [], bus: [],
      loadMax: [], mode: [], relay: [], soc: [],
      from: src.length ? src[0].t : now,
      to: src.length ? src[src.length - 1].t : now,
    };
    if (!src.length) return out;

    const buckets = Math.min(maxPoints, Math.max(1, src.length));
    const span = (src[src.length - 1].t - src[0].t) || 1;
    const size = span / buckets;

    const acc = [];
    for (let b = 0; b < buckets; b++) acc.push({ n: 0 });

    for (const s of src) {
      let idx = Math.floor((s.t - src[0].t) / size);
      if (idx < 0) idx = 0;
      if (idx >= buckets) idx = buckets - 1;
      const a = acc[idx];
      a.n++;
      a.t = a.t ? (a.t + s.t) / 2 : s.t;
      const add = (k, v) => {
        if (v === null || v === undefined || !Number.isFinite(v)) return;
        a[k] = (a[k] ?? 0) + v;
        a[k + 'n'] = (a[k + 'n'] || 0) + 1;
      };
      add('pvP', s.pv.p);
      add('pvV', s.pv.v);
      add('pvI', s.pv.i);
      add('loadP', s.load.p);
      add('loadV', s.load.v);
      add('loadI', s.load.i);
      add('bus', s.bus);
      add('soc', s.soc);
      if (s.load.p != null) a.loadMax = Math.max(a.loadMax ?? -Infinity, s.load.p);
      // keep the *last* discrete state seen inside the bucket
      if (s.mode) a.mode = s.mode;
      if (s.relay !== null) a.relay = s.relay;
    }

    for (const a of acc) {
      if (!a.n) continue;
      out.points++;
      out.t.push(Math.round(a.t));
      const avg = (k) => (a[k + 'n'] ? r3(a[k] / a[k + 'n']) : null);
      out.pvP.push(avg('pvP'));
      out.pvV.push(avg('pvV'));
      out.pvI.push(avg('pvI'));
      out.loadP.push(avg('loadP'));
      out.loadV.push(avg('loadV'));
      out.loadI.push(avg('loadI'));
      out.bus.push(avg('bus'));
      out.loadMax.push(a.loadMax === undefined ? null : r3(a.loadMax));
      out.mode.push(a.mode ?? null);
      out.relay.push(a.relay ?? null);
      out.soc.push(avg('soc'));
    }
    return out;
  }

  /** Battery proxy voltage thresholds from firmware v10. */
  static THRESHOLDS = { lvd: 12.40, healthyGate: 12.45 };

  kpis(rangeKey = '15m', now = Date.now()) {
    const win = this.range(rangeKey, now);
    const last = this.lastSample;
    const modes = {};
    for (const s of win) if (s.mode) modes[s.mode] = (modes[s.mode] || 0) + 1;

    const mean = (fn) => {
      let sum = 0, n = 0;
      for (const s of win) { const v = fn(s); if (v != null && Number.isFinite(v)) { sum += v; n++; } }
      return n ? r3(sum / n) : null;
    };

    const energyWin = this.windowEnergy(win);

    return {
      latest: last,
      lastSeen: last ? last.t : null,
      ageMs: last ? now - last.t : null,
      range: rangeKey,
      windowSamples: win.length,
      mean: {
        pvP: mean((s) => s.pv.p), loadP: mean((s) => s.load.p),
        bus: mean((s) => s.bus), pvV: mean((s) => s.pv.v),
        pvI: mean((s) => s.pv.i), loadI: mean((s) => s.load.i),
      },
      modes,
      energy: { ...energyWin, day: this.energy.day },
      totals: { pvWh: r3(this.energy.pvWh), loadWh: r3(this.energy.loadWh) },
      uptimeS: Math.round((now - this.startedAt) / 1000),
      sources: this.sources,
      thresholds: Store.THRESHOLDS,
    };
  }

  windowEnergy(win) {
    let pvWh = 0, loadWh = 0;
    for (let k = 1; k < win.length; k++) {
      const a = win[k - 1], b = win[k];
      const dtH = (b.t - a.t) / 3600000;
      if (!(dtH > 0) || dtH > 10 / 60) continue;
      const pa = a.pv.p ?? (a.pv.v != null && a.pv.i != null ? a.pv.v * a.pv.i : null);
      const pb = b.pv.p ?? (b.pv.v != null && b.pv.i != null ? b.pv.v * b.pv.i : null);
      if (pa != null && pb != null) pvWh += ((pa + pb) / 2) * dtH;
      const la = a.load.p ?? (a.load.v != null && a.load.i != null ? a.load.v * a.load.i : null);
      const lb = b.load.p ?? (b.load.v != null && b.load.i != null ? b.load.v * b.load.i : null);
      if (la != null && lb != null) loadWh += ((la + lb) / 2) * dtH;
    }
    return { pvWh: r3(pvWh), loadWh: r3(loadWh), netWh: r3(pvWh - loadWh) };
  }

  /**
   * Detect state intervals + shedding events. For every SAVE interval we compare
   * mean load against the preceding NORMAL interval => measured demand reduction.
   */
  events(rangeKey = 'all', now = Date.now()) {
    const win = this.range(rangeKey, now).filter((s) => s.mode || s.relay !== null);
    const intervals = [];
    for (const s of win) {
      const label = s.mode || (s.relay ? 'NORMAL' : 'SAVE');
      const prev = intervals[intervals.length - 1];
      const key = `${label}|${s.relay}`;
      if (!prev || prev.key !== key) {
        intervals.push({ key, label, relay: s.relay, from: s.t, to: s.t, n: 1, loadSum: 0, loadN: 0, busSum: 0, busN: 0, pvSum: 0, pvN: 0 });
      }
      const cur = intervals[intervals.length - 1];
      cur.to = s.t; cur.n++;
      if (s.load.p != null) { cur.loadSum += s.load.p; cur.loadN++; }
      if (s.bus != null) { cur.busSum += s.bus; cur.busN++; }
      if (s.pv.p != null) { cur.pvSum += s.pv.p; cur.pvN++; }
    }

    const isShed = (iv) => /SAVE/.test(iv.label) || iv.relay === false;
    const meanOf = (iv) => ({
      loadP: iv.loadN ? r3(iv.loadSum / iv.loadN) : null,
      bus: iv.busN ? r3(iv.busSum / iv.busN) : null,
      pvP: iv.pvN ? r3(iv.pvSum / iv.pvN) : null,
    });

    const list = intervals.map((iv, idx) => {
      const m = meanOf(iv);
      const item = {
        label: iv.label, relay: iv.relay, from: iv.from, to: iv.to,
        durationS: Math.max(1, Math.round((iv.to - iv.from) / 1000)),
        meanLoadW: m.loadP, meanBusV: m.bus, meanPvW: m.pvP,
        shed: isShed(iv), reductionPct: null, baselineLoadW: null,
      };
      if (isShed(iv)) {
        // baseline = most recent non-shed interval before this one
        for (let k = idx - 1; k >= 0; k--) {
          if (!isShed(intervals[k]) && intervals[k].loadN) {
            const base = meanOf(intervals[k]).loadP;
            item.baselineLoadW = base;
            if (base && m.loadP != null) item.reductionPct = r3(((base - m.loadP) / base) * 100);
            break;
          }
        }
      }
      return item;
    });

    const shedEvents = list.filter((e) => e.shed && e.reductionPct !== null);
    const avgReduction = shedEvents.length
      ? r3(shedEvents.reduce((a, e) => a + e.reductionPct, 0) / shedEvents.length)
      : null;

    return { intervals: list.slice(-400), sheddingEvents: list.filter((e) => e.shed).slice(-200), avgReductionPct: avgReduction };
  }

  /** Current alerts, derived from the newest sample. */
  alerts(now = Date.now(), offlineAfterMs = 20000) {
    const out = [];
    const s = this.lastSample;
    if (!s) {
      out.push({ level: 'info', code: 'no-data', msg: 'Waiting for the first reading from the serial bridge.' });
      return out;
    }
    const age = now - s.t;
    if (age > offlineAfterMs) {
      out.push({ level: 'warn', code: 'stale', msg: `No new reading for ${Math.round(age / 1000)} s — bridge or ESP32 is offline.` });
    }
    if (s.bus != null) {
      if (s.bus < Store.THRESHOLDS.lvd) {
        out.push({ level: 'critical', code: 'lvd', msg: `Load bus ${s.bus.toFixed(3)} V is below the 12.40 V LVD protection level.` });
      } else if (s.bus < Store.THRESHOLDS.healthyGate) {
        out.push({ level: 'warn', code: 'below-gate', msg: `Load bus ${s.bus.toFixed(3)} V is under the 12.45 V healthy-NORMAL gate; restoring both loads is unsafe.` });
      }
    }
    const pv = s.pv.p ?? (s.pv.v != null && s.pv.i != null ? s.pv.v * s.pv.i : null);
    const ld = s.load.p ?? (s.load.v != null && s.load.i != null ? s.load.v * s.load.i : null);
    if (pv != null && ld != null && ld > pv + 0.15) {
      out.push({ level: 'info', code: 'deficit', msg: `Demand ${ld.toFixed(2)} W exceeds harvest ${pv.toFixed(2)} W — running from storage.` });
    }
    if (s.mode && /SAVE/.test(s.mode)) {
      out.push({ level: 'info', code: 'shed', msg: 'Secondary load shed: primary critical load is still supplied.' });
    }
    return out;
  }

  /* -------------------------------------------------------------- commands */

  queueCommand(cmd, meta = {}) {
    const c = {
      id: this.nextCommandId++,
      cmd: String(cmd).toUpperCase(),
      t: Date.now(),
      ...meta,
    };
    this.commands.push(c);
    if (this.commands.length > 50) this.commands.shift();
    return c;
  }

  takeCommands(sinceId = 0) {
    return this.commands.filter((c) => c.id > sinceId);
  }

  /* ------------------------------------------------------------ persistence */

  _loadState() {
    try {
      const raw = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
      if (raw && raw.day === this.today()) {
        this.energy.pvWh = Number(raw.pvWh) || 0;
        this.energy.loadWh = Number(raw.loadWh) || 0;
      }
    } catch { /* first boot */ }
  }

  _replayTail(maxBytes = 24 * 1024 * 1024) {
    let fd;
    try {
      const stat = fs.statSync(SAMPLES_FILE);
      const start = Math.max(0, stat.size - maxBytes);
      fd = fs.openSync(SAMPLES_FILE, 'r');
      const len = stat.size - start;
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, start);
      const lines = buf.toString('utf8').split('\n');
      if (start > 0) lines.shift(); // drop partial first line
      let count = 0;
      for (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }
        const s = normalize(obj, obj.src);
        if (s) { this.samples.push(s); count++; }
      }
      if (this.samples.length > RING_MAX) this.samples.splice(0, this.samples.length - RING_MAX);
      if (this.samples.length) {
        this.lastSample = this.samples[this.samples.length - 1];
        this.seq = this.samples.length;
      }
      console.log(`[store] replayed ${count} historical samples from ${SAMPLES_FILE}`);
    } catch (e) {
      if (e.code !== 'ENOENT') console.warn('[store] replay failed:', e.message);
    } finally {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
    }
  }

  flush() {
    if (this.pending.length) {
      const chunk = this.pending.map((s) => JSON.stringify(s)).join('\n') + '\n';
      this.pending = [];
      try {
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.appendFile(SAMPLES_FILE, chunk, () => {});
      } catch (e) {
        console.warn('[store] append failed:', e.message);
      }
    }
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      fs.writeFile(STATE_FILE, JSON.stringify({ ...this.energy, savedAt: Date.now() }), () => {});
    } catch { /* non-fatal */ }
  }

  toCsv(rangeKey = 'all', now = Date.now()) {
    const rows = this.range(rangeKey, now);
    const head = 'timestamp_iso,timestamp_ms,src,pv_voltage_v,pv_current_a,pv_power_w,load_voltage_v,load_current_a,load_power_w,bus_voltage_v,mode,relay,soc_pct\n';
    const body = rows.map((s) => [
      new Date(s.t).toISOString(), s.t, s.src,
      s.pv.v ?? '', s.pv.i ?? '', s.pv.p ?? '',
      s.load.v ?? '', s.load.i ?? '', s.load.p ?? '',
      s.bus ?? '', s.mode ?? '', s.relay === null ? '' : (s.relay ? 1 : 0), s.soc ?? '',
    ].join(',')).join('\n');
    return head + body + '\n';
  }
}

module.exports = { Store, normalize, DATA_DIR, SAMPLES_FILE, STATE_FILE };
