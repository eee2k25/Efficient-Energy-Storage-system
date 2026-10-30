#!/usr/bin/env node
'use strict';
/**
 * Frontend smoke test — runs the real index.html + chart.js + app.js inside
 * jsdom against a running dashboard server, with canvas/SSE stubbed.
 *
 * This exists because a single bad DOM call in app.js renders the whole page
 * blank with no server-side error; the API self-test cannot catch that.
 *
 *   npm i --no-save jsdom
 *   node dashboard/server.js --simulate &      # or POST some samples
 *   node scripts/ui-smoke-test.js
 *
 * Exit code 0 = every check passed.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const APP = path.join(__dirname, '..', 'dashboard', 'public');
const PORT = Number(process.env.PORT || 3000);
const BASE = `http://127.0.0.1:${PORT}`;

let JSDOM;
try {
  ({ JSDOM } = require('jsdom'));
} catch {
  console.error('jsdom is required:  npm i --no-save jsdom');
  process.exit(2);
}

const errors = [];
const results = [];
const check = (name, cond, extra = '') => results.push({ name, ok: !!cond, extra });

const html = fs.readFileSync(path.join(APP, 'index.html'), 'utf8');
const dom = new JSDOM(html, { url: BASE, runScripts: 'outside-only', pretendToBeVisual: true });
const { window } = dom;
window.devicePixelRatio = 1;

/* canvas 2D stub */
const gradient = { addColorStop() {} };
const ctx = new Proxy({}, {
  get(_, prop) {
    if (prop === 'createLinearGradient') return () => gradient;
    if (prop === 'measureText') return () => ({ width: 20 });
    if (prop === 'canvas') return { width: 600, height: 300 };
    return () => {};
  },
  set() { return true; },
});
window.HTMLCanvasElement.prototype.getContext = () => ctx;
window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

/* jsdom reports zero-size boxes; the chart needs a real size to render */
for (const [prop, value] of Object.entries({
  getBoundingClientRect: { width: 800, height: 300, top: 0, left: 0, right: 800, bottom: 300, x: 0, y: 0 },
})) {
  Object.defineProperty(window.HTMLElement.prototype, prop, { value: () => value, configurable: true });
}
for (const [prop, value] of Object.entries({ offsetWidth: 160, clientHeight: 200, scrollHeight: 200 })) {
  Object.defineProperty(window.HTMLElement.prototype, prop, { get: () => value, configurable: true });
}

window.fetch = (url, opts) => fetch(String(url).startsWith('http') ? url : BASE + url, opts);

/* minimal EventSource over node http */
class EventSourceStub {
  constructor(url) {
    this.listeners = {};
    this.readyState = 0;
    const target = new URL(url, BASE);
    this.req = http.get({ host: target.hostname, port: target.port, path: target.pathname + target.search }, (res) => {
      this.readyState = 1;
      if (this.onopen) this.onopen();
      let buf = '';
      res.on('data', (chunk) => {
        buf += chunk.toString();
        let idx;
        while ((idx = buf.indexOf('\n\n')) >= 0) {
          const raw = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = /event: (.+)/.exec(raw);
          const data = /data: (.+)/.exec(raw);
          if (ev && data) (this.listeners[ev[1].trim()] || []).forEach((fn) => fn({ data: data[1] }));
        }
      });
    });
    this.req.on('error', () => { this.readyState = 2; if (this.onerror) this.onerror(); });
  }
  addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); }
  close() { try { this.req.destroy(); } catch {} this.readyState = 2; }
}
window.EventSource = EventSourceStub;

window.console.error = (...a) => errors.push(a.join(' '));
window.addEventListener('error', (e) => errors.push('window error: ' + e.message));

window.eval(fs.readFileSync(path.join(APP, 'chart.js'), 'utf8'));
window.eval(fs.readFileSync(path.join(APP, 'app.js'), 'utf8'));

const text = (id) => window.document.getElementById(id)?.textContent?.trim();
const doc = window.document;

setTimeout(() => {
  check('no runtime errors', errors.length === 0, errors.slice(0, 3).join(' | '));
  for (const [label, id] of [
    ['PV', 'kpiPvP'], ['load', 'kpiLoadP'], ['bus', 'kpiBus'], ['net', 'kpiNet'], ['energy', 'kpiPvWh'],
  ]) {
    check(`${label} KPI populated`, text(id) && text(id) !== '—', `value=${text(id)}`);
  }
  check('mode chip shows controller state', /AUTO|SAVE|NORMAL/.test(text('modeChip') || ''), text('modeChip'));
  check('connection pill switched state', /live|demo/.test(doc.getElementById('connPill').className), doc.getElementById('connPill').className);
  check('events table rendered rows', doc.querySelectorAll('#eventsBody tr').length > 0, `${doc.querySelectorAll('#eventsBody tr').length} rows`);
  check('state ribbon has segments', doc.querySelectorAll('#ribbon span').length > 1, `${doc.querySelectorAll('#ribbon span').length} segments`);
  check('live feed received lines', doc.querySelectorAll('#feed .ln').length > 0, `${doc.querySelectorAll('#feed .ln').length} lines`);
  check('mode share split computed', /NORMAL \d+%/.test(text('splitNormalTxt') || ''), text('splitNormalTxt'));
  check('legend buttons built', doc.querySelectorAll('#legendPower button').length === 3);

  try {
    doc.querySelectorAll('#legendPower button')[0].click();
    check('legend toggle works', true);
  } catch (e) { check('legend toggle works', false, e.message); }

  try {
    doc.querySelectorAll('.seg-btn')[0].click();
    check('range switch works', true);
  } catch (e) { check('range switch works', false, e.message); }

  let pass = 0;
  for (const r of results) {
    console.log(`  ${r.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${r.name}${r.ok ? '' : '  ' + (r.extra || '')}`);
    if (r.ok) pass++;
  }
  console.log(`\n${pass}/${results.length} frontend checks passed`);
  if (errors.length) console.log('\nerrors:', errors.slice(0, 5));
  process.exit(pass === results.length ? 0 : 1);
}, 4000);
