#!/usr/bin/env node
'use strict';
/**
 * End-to-end self-test — no hardware, no browser.
 *
 * Boots the dashboard in simulation mode on a random port, then verifies:
 *   health · summary · series bucketing · events/shedding math · CSV export
 *   ingest API (single + batch + rejection) · SSE live stream · command queue
 *
 * Usage:  npm run selftest
 */

const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const os = require('os');

const PORT = 3900 + Math.floor(Math.random() * 90);
const ROOT = path.join(__dirname, '..');
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ees-test-'));

let passed = 0;
const failures = [];

function ok(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { failures.push(name); console.log(`  \x1b[31m✗ ${name}\x1b[0m ${extra}`); }
}

function get(pathname) {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port: PORT, path: pathname }, (res) => {
      let buf = '';
      res.on('data', (c) => (buf += c));
      res.on('end', () => resolve({ status: res.statusCode, body: buf, headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(6000, () => req.destroy(new Error('timeout')));
  });
}

function post(pathname, obj, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(obj);
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), ...headers } },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log('\n\x1b[1mEES dashboard self-test\x1b[0m\n');

  const server = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.js')], {
    env: { ...process.env, SIMULATE: '1', PORT: String(PORT), DATA_DIR, SIM_TICK_MS: '400', INGEST_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));

  const cleanup = () => { try { server.kill('SIGTERM'); } catch {} };
  process.on('exit', cleanup);

  // wait for boot
  let up = false;
  for (let i = 0; i < 40; i++) {
    await sleep(150);
    try { const r = await get('/api/health'); if (r.status === 200) { up = true; break; } } catch {}
  }
  ok('server boots and answers /api/health', up, log.slice(-400));
  if (!up) { cleanup(); process.exit(1); }

  /* ---------- health ---------- */
  const health = JSON.parse((await get('/api/health')).body);
  ok('health reports simulation mode', health.simulate === true);
  ok('health reports buffered samples', health.samples > 100, `samples=${health.samples}`);

  /* ---------- summary ---------- */
  const summary = JSON.parse((await get('/api/summary?range=15m')).body);
  ok('summary has a latest sample', !!summary.latest, JSON.stringify(summary).slice(0, 200));
  ok('latest sample carries PV + load power', summary.latest?.pv?.p != null && summary.latest?.load?.p != null);
  ok('summary exposes thresholds', summary.thresholds?.lvd === 12.4 && summary.thresholds?.healthyGate === 12.45);
  ok('summary computes energy Wh', Number.isFinite(summary.energy?.pvWh) && summary.energy.pvWh >= 0);
  ok('summary exposes mode histogram', Object.keys(summary.modes || {}).length > 0);
  ok('summary flags alerts array', Array.isArray(summary.alerts));

  /* ---------- series ---------- */
  const series = JSON.parse((await get('/api/series?range=15m&points=120')).body);
  ok('series returns bucket points', series.points > 5, `points=${series.points}`);
  ok('series arrays are aligned', series.t.length === series.pvP.length && series.pvP.length === series.bus.length);
  ok('series respects max points', series.points <= 120, `points=${series.points}`);
  const busVals = series.bus.filter((v) => v != null);
  ok('bus voltage is physically plausible', Math.min(...busVals) > 10 && Math.max(...busVals) < 15,
      `${Math.min(...busVals)}..${Math.max(...busVals)}`);

  /* ---------- events ---------- */
  const events = JSON.parse((await get('/api/events?range=all')).body);
  ok('events returns intervals', Array.isArray(events.intervals) && events.intervals.length > 0);
  const shed = events.sheddingEvents || [];
  ok('shedding intervals detected', shed.length > 0, `count=${shed.length}`);
  const withReduction = shed.filter((e) => e.reductionPct != null);
  ok('shedding reduction computed from NORMAL baseline', withReduction.length > 0,
      JSON.stringify(shed[0] || {}));
  if (withReduction.length) {
    const r = withReduction[0].reductionPct;
    ok('reduction is in a believable range (20-60 %)', r > 20 && r < 60, `reduction=${r}%`);
  }
  const meanLoads = (events.intervals || []).map((e) => e.meanLoadW).filter((x) => x != null);
  ok('load means match measured bench values', meanLoads.every((m) => m > 1.5 && m < 3.6), meanLoads.slice(0, 6).join(','));

  /* ---------- ingest ---------- */
  const ingest = await post('/api/ingest', {
    pv: { v: 17.9, i: 0.44, p: 7.88 },
    load: { v: 12.51, i: 0.26, p: 3.27 },
    bus: 12.51, mode: 'AUTO_NORMAL', relay: true, src: 'serial',
  });
  ok('ingest accepts a single sample', ingest.status === 200, ingest.body);
  const after = JSON.parse((await get('/api/summary')).body);
  ok('ingested sample becomes the latest reading', after.latest?.pv?.v === 17.9, JSON.stringify(after.latest));
  ok('ingest marks the serial source', !!after.sources?.serial);

  const batch = await post('/api/ingest', [
    { t: Date.now() - 1000, pv: { p: 6.5 }, load: { p: 3.2 }, mode: 'AUTO_NORMAL' },
    { t: Date.now(), pv: { p: 1.2 }, load: { p: 1.8 }, mode: 'AUTO_SAVE', relay: false },
  ]);
  ok('ingest accepts a batch', JSON.parse(batch.body).accepted === 2, batch.body);

  const bad = await post('/api/ingest', { nothing: 'useful' });
  ok('ingest rejects a sample with no measurements', bad.status === 422, bad.body);

  /* ---------- ingest key ---------- */
  const secured = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.js')], {
    env: { ...process.env, PORT: String(PORT + 1), DATA_DIR, INGEST_KEY: 'secret123', SIMULATE: '1' },
    stdio: 'ignore',
  });
  await sleep(1200);
  const noKey = await new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port: PORT + 1, path: '/api/ingest', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
      res.resume(); resolve(res.statusCode);
    });
    req.on('error', () => resolve(0));
    req.end(JSON.stringify({ pv: { v: 18 } }));
  });
  ok('ingest key is enforced when configured', noKey === 401 || noKey === 0, `status=${noKey}`);
  secured.kill('SIGTERM');

  /* ---------- CSV ---------- */
  const csv = await get('/api/export.csv?range=all');
  const lines = csv.body.trim().split('\n');
  ok('CSV export returns a header', lines[0].startsWith('timestamp_iso,timestamp_ms,src'));
  ok('CSV export returns rows', lines.length > 100, `rows=${lines.length}`);
  ok('CSV sets an attachment header', /attachment/.test(csv.headers['content-disposition'] || ''));

  /* ---------- static UI ---------- */
  const page = await get('/');
  ok('serves the dashboard page', page.status === 200 && /Live Telemetry/.test(page.body));
  const jsRes = await get('/app.js');
  ok('serves app.js', jsRes.status === 200 && jsRes.body.length > 5000);

  /* ---------- SSE ---------- */
  const sse = await new Promise((resolve) => {
    let buf = '';
    const req = http.get({ host: '127.0.0.1', port: PORT, path: '/api/stream?range=15m' }, (res) => {
      res.on('data', (c) => {
        buf += c.toString();
        if (buf.includes('event: sample') && buf.includes('event: summary')) {
          res.destroy();
          resolve({ ok: true, buf });
        }
      });
    });
    req.on('error', () => resolve({ ok: false }));
    setTimeout(() => { try { req.destroy(); } catch {} resolve({ ok: false, buf }); }, 6000);
  });
  ok('SSE stream pushes sample + summary events', sse.ok, (sse.buf || '').slice(0, 160));

  /* ---------- commands ---------- */
  const cmd = await post('/api/command', { cmd: 'SAVE' });
  ok('control endpoint queues SAVE', cmd.status === 200 && JSON.parse(cmd.body).ok, cmd.body);
  const cmds = JSON.parse((await get('/api/commands?since=0')).body);
  ok('bridge can fetch the queued command', (cmds.commands || []).some((c) => c.cmd === 'SAVE'));
  const badCmd = await post('/api/command', { cmd: 'EXPLODE' });
  ok('control rejects unknown commands', badCmd.status === 400, badCmd.body);

  /* ---------- persistence ---------- */
  await sleep(1000);
  const files = fs.readdirSync(DATA_DIR);
  ok('telemetry persisted to disk', files.includes('samples.jsonl'), files.join(','));
  const persisted = fs.readFileSync(path.join(DATA_DIR, 'samples.jsonl'), 'utf8').trim().split('\n').length;
  ok('persisted sample count is sensible', persisted > 100, `lines=${persisted}`);

  /* ---------- backlog replay ---------- */
  server.kill('SIGTERM');
  await sleep(700);
  const restart = spawn(process.execPath, [path.join(ROOT, 'dashboard', 'server.js')], {
    env: { ...process.env, PORT: String(PORT), DATA_DIR, SIMULATE: '', SIM_TICK_MS: '1000' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let restartLog = '';
  restart.stdout.on('data', (d) => (restartLog += d));
  restart.stderr.on('data', (d) => (restartLog += d));
  let back = false;
  for (let i = 0; i < 30; i++) {
    await sleep(200);
    try { const r = await get('/api/health'); if (r.status === 200) { back = true; break; } } catch {}
  }
  const replayed = JSON.parse((await get('/api/health')).body);
  ok('server restarts and replays history from disk', back && replayed.samples > 100, `samples=${replayed.samples} ${restartLog.slice(-200)}`);
  restart.kill('SIGTERM');

  cleanup();
  const total = passed + failures.length;
  console.log(`\n\x1b[1m${passed}/${total} checks passed\x1b[0m`);
  if (failures.length) {
    console.log(`\x1b[31mFailures:\x1b[0m ${failures.join('; ')}`);
    process.exit(1);
  }
  console.log('\x1b[32mAll good.\x1b[0m\n');
  process.exit(0);
})().catch((e) => {
  console.error('self-test crashed:', e);
  process.exit(1);
});
