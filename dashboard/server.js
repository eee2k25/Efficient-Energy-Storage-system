'use strict';
/**
 * Efficient Energy Storage System — live telemetry dashboard server.
 *
 * Zero npm dependencies (Node >= 18). Run:  node dashboard/server.js
 *
 * Data in:   POST /api/ingest            <- bridge/serial_bridge.py, ESP32, or any HTTP client
 *            ThingSpeak poller          <- enable with THINGSPEAK_CHANNEL=...
 *            built-in simulator         <- SIMULATE=1
 * Data out:  GET  /api/stream            <- Server-Sent Events (live push)
 *            GET  /api/summary | /api/series | /api/events | /api/export.csv
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Store } = require('./lib/store');
const { Simulator } = require('./lib/simulator');
const { startThingSpeak } = require('./lib/thingspeak');

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');
const INGEST_KEY = process.env.INGEST_KEY || '';
const SIMULATE = /^(1|true|yes)$/i.test(process.env.SIMULATE || '') || process.argv.includes('--simulate');
const ALLOW_CONTROL = !/^(0|false|no)$/i.test(process.env.ALLOW_CONTROL || 'true');
const MAX_BODY = 1024 * 1024;

const store = new Store();
const startedAt = Date.now();

/* ------------------------------------------------------------------ helpers */

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
};

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Error('payload too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* -------------------------------------------------------------- SSE clients */

const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try { res.write(payload); } catch { clients.delete(res); }
  }
}

setInterval(() => {
  for (const res of clients) { try { res.write(': ping\n\n'); } catch { clients.delete(res); } }
}, 20000).unref?.();

function summaryPayload(range) {
  const now = Date.now();
  return {
    ...store.kpis(range, now),
    alerts: store.alerts(now),
    control: { enabled: ALLOW_CONTROL, pending: store.commands.slice(-5) },
    buffer: store.samples.length,
    simulating: Boolean(simTimer),
    server: { uptimeS: Math.round((now - startedAt) / 1000), simulate: Boolean(simTimer), version: 1 },
  };
}

function publish(sample, reason) {
  if (!sample) return;
  broadcast('sample', sample);
  broadcast('summary', summaryPayload(currentRange));
}

let currentRange = '15m';

/* ------------------------------------------------------------ simulator run */

let lastMode = null;
let simTimer = null;

/** Real hardware overrides the demo generator — never mix the two on one chart. */
function haltSimulator(reason) {
  if (!simTimer) return;
  clearInterval(simTimer);
  simTimer = null;
  console.log(`[sim] stopped — ${reason}`);
  broadcast('notice', { level: 'info', msg: `Demo simulator stopped: ${reason}. Showing real hardware data.` });
}

if (SIMULATE) {
  const BACKFILL = 900;
  const BACKFILL_STEP_S = 3;
  const sim = new Simulator({
    soc: 0.42,
    phase: 0.15,
    backfillSteps: BACKFILL,
    backfillStepS: BACKFILL_STEP_S,
  });
  // Backfill ~45 min of virtual history so the charts are populated the moment
  // the page opens instead of showing an empty canvas.
  for (let i = 0; i < BACKFILL; i++) store.add(sim.step(BACKFILL_STEP_S), 'sim');
  console.log(`[sim] backfilled 900 samples, soc=${(sim.soc * 100).toFixed(1)}%`);

  const tickMs = Number(process.env.SIM_TICK_MS || 1500);
  simTimer = setInterval(() => {
    const s = sim.step(tickMs / 1000);
    const added = store.add(s, 'sim');
    if (added && added.mode !== lastMode) {
      lastMode = added.mode;
      console.log(`[sim] state -> ${added.mode} (bus ${added.bus} V, load ${added.load.p} W)`);
      broadcast('event', { type: 'state', sample: added });
    }
    publish(added);
  }, tickMs);
  simTimer.unref?.();
}

if (process.env.THINGSPEAK_CHANNEL) {
  startThingSpeak({
    store,
    channel: process.env.THINGSPEAK_CHANNEL,
    readKey: process.env.THINGSPEAK_READ_KEY,
    intervalMs: Number(process.env.THINGSPEAK_POLL_MS || 15000),
    fieldSpec: process.env.THINGSPEAK_FIELDS,
  });
}

/* ------------------------------------------------------------------ routing */

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type,x-api-key',
      'access-control-max-age': '86400',
    });
    return res.end();
  }

  try {
    /* ---------------- ingest ---------------- */
    if (p === '/api/ingest' && req.method === 'POST') {
      if (INGEST_KEY) {
        const key = req.headers['x-api-key'] || url.searchParams.get('key');
        if (key !== INGEST_KEY) return json(res, 401, { ok: false, error: 'bad api key' });
      }
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw); } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }

      const items = Array.isArray(body) ? body : Array.isArray(body?.samples) ? body.samples : [body];
      let accepted = 0;
      let last = null;
      for (const item of items) {
        const s = store.add(item, item?.src || 'serial');
        if (s) { accepted++; last = s; }
      }
      if (last) {
        if (last.src !== 'sim') haltSimulator('real hardware data received');
        publish(last);
      }
      return json(res, accepted ? 200 : 422, { ok: accepted > 0, accepted, rejected: items.length - accepted });
    }

    /* ---------------- live stream ---------------- */
    if (p === '/api/stream') {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
        'access-control-allow-origin': '*',
      });
      res.write('retry: 3000\n\n');
      const range = url.searchParams.get('range') || currentRange;
      currentRange = range;
      res.write(`event: hello\ndata: ${JSON.stringify({ summary: summaryPayload(range) })}\n\n`);
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    /* ---------------- queries ---------------- */
    if (p === '/api/summary') return json(res, 200, summaryPayload(url.searchParams.get('range') || '15m'));

    if (p === '/api/series') {
      const range = url.searchParams.get('range') || '15m';
      const points = Math.min(4000, Math.max(60, Number(url.searchParams.get('points') || 480)));
      return json(res, 200, store.series(range, points));
    }

    if (p === '/api/events') return json(res, 200, store.events(url.searchParams.get('range') || 'all'));

    if (p === '/api/export.csv') {
      const csv = store.toCsv(url.searchParams.get('range') || 'all');
      res.writeHead(200, {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="ees_telemetry_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv"`,
        'access-control-allow-origin': '*',
      });
      return res.end(csv);
    }

    if (p === '/api/health') {
      const last = store.lastSample;
      return json(res, 200, {
        ok: true,
        simulate: Boolean(simTimer),
        thingspeak: Boolean(process.env.THINGSPEAK_CHANNEL),
        samples: store.samples.length,
        lastSeen: last ? last.t : null,
        lastAgeMs: last ? Date.now() - last.t : null,
        clients: clients.size,
        uptimeS: Math.round((Date.now() - startedAt) / 1000),
      });
    }

    /* ---------------- control ----------------
     * Queue NORMAL / SAVE / AUTO for the serial bridge to write to the ESP32.
     * Only used when the bridge runs with --allow-control.               */
    if (p === '/api/command' && req.method === 'POST') {
      if (!ALLOW_CONTROL) return json(res, 403, { ok: false, error: 'control disabled' });
      const raw = await readBody(req);
      let body;
      try { body = JSON.parse(raw || '{}'); } catch { return json(res, 400, { ok: false, error: 'invalid JSON' }); }
      const cmd = String(body.cmd || '').toUpperCase();
      if (!['AUTO', 'NORMAL', 'SAVE'].includes(cmd)) {
        return json(res, 400, { ok: false, error: 'cmd must be AUTO, NORMAL or SAVE' });
      }
      const c = store.queueCommand(cmd, { by: body.by || 'dashboard' });
      console.log(`[control] queued ${cmd} (id ${c.id})`);
      broadcast('command', c);
      return json(res, 200, { ok: true, command: c });
    }

    if (p === '/api/commands' && req.method === 'GET') {
      const since = Number(url.searchParams.get('since') || 0);
      const list = store.takeCommands(since);
      if (url.searchParams.get('ack') === '1') store.commands = store.commands.filter((c) => !list.some((l) => l.id === c.id));
      return json(res, 200, { commands: list });
    }

    /* ---------------- static ----------------- */
    let filePath = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p);
    if (!filePath.startsWith(PUBLIC_DIR)) return json(res, 403, { ok: false, error: 'forbidden' });
    if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      if (!path.extname(filePath)) filePath = path.join(PUBLIC_DIR, 'index.html');
      else return json(res, 404, { ok: false, error: 'not found' });
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    return fs.createReadStream(filePath).pipe(res);
  } catch (e) {
    console.error('[http]', e);
    if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
    else res.end();
  }
});

server.listen(PORT, HOST, () => {
  console.log('');
  console.log('  ┌───────────────────────────────────────────────────────────┐');
  console.log('  │  Efficient Energy Storage System — Telemetry Dashboard     │');
  console.log('  └───────────────────────────────────────────────────────────┘');
  console.log(`  URL        : http://localhost:${PORT}`);
  console.log(`  Mode       : ${SIMULATE ? 'SIMULATION (no hardware)' : 'LIVE (waiting for data)'}`);
  console.log(`  Ingest key : ${INGEST_KEY ? 'required' : 'open (set INGEST_KEY to secure)'}`);
  console.log(`  ThingSpeak : ${process.env.THINGSPEAK_CHANNEL ? 'channel ' + process.env.THINGSPEAK_CHANNEL : 'off'}`);
  console.log(`  Control    : ${ALLOW_CONTROL ? 'enabled (AUTO/NORMAL/SAVE)' : 'disabled'}`);
  console.log('');
});

function shutdown() {
  console.log('\n[server] flushing telemetry…');
  store.flush();
  setTimeout(() => process.exit(0), 250);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
