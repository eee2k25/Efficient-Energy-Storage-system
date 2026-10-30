'use strict';
/**
 * Physics-ish demo simulator.
 *
 * Purpose: let the dashboard be demonstrated (and hosted publicly) without the
 * ESP32 attached. It reproduces the measured bench numbers from the project
 * checkpoint:
 *   primary LED only (SAVE)      -> ~1.759 W
 *   primary + secondary (NORMAL) -> ~3.271 W   (secondary ~1.512 W)
 * and the firmware v10 relay rule:
 *   bus < 12.40 V  -> SAVE   (shed secondary LED)
 *   bus > 12.45 V  -> NORMAL (restore secondary LED)
 *
 * A compressed solar day is used so a viewer sees charge / discharge / shedding
 * behaviour within the first couple of minutes instead of waiting hours.
 */

const LVD = 12.4;        // firmware v10 low-bus protection
const GATE = 12.45;      // healthy-NORMAL restore gate
const PRIMARY_W = 1.759; // measured primary LED load
const SECONDARY_W = 1.512;
const PANEL_PEAK_W = 6.0;

/* The demo day is *compressed* (one simulated day per ~45 minutes of runtime),
 * so the storage energy is scaled down to match: a physical 12 V 7 Ah SLA would
 * change state-of-charge far too slowly to show anything on screen. Only the
 * voltage-vs-SOC shape and the 12.40/12.45 V thresholds are physical. */
const BATTERY_WH = 2.8;
const DWELL = 2;         // consecutive samples required before switching

class Simulator {
  constructor(opts = {}) {
    this.soc = opts.soc ?? 0.42;
    this._dwellLow = 0;
    this._dwellHigh = 0;
    this.mode = 'AUTO';
    this.relay = false;           // boot state: AUTO + secondary OFF
    this.phase = opts.phase ?? 0.62; // 0..1 through the compressed day
    // anchor the virtual clock so the last backfilled sample lands on "now"
    const backfillSteps = opts.backfillSteps || 0;
    const stepS = opts.backfillStepS ?? 3;
    this.t = Date.now() - backfillSteps * stepS * 1000;
    this._cloud = 0;
  }

  _irradiance() {
    // slow sweep + clouds. compressed "day" loops every ~40 simulated minutes
    const angle = this.phase * Math.PI * 2;
    const swing = 0.5 + 0.5 * Math.sin(angle);
    // smooth pseudo-clouds
    this._cloud = this._cloud * 0.94 + (Math.random() - 0.5) * 0.09;
    const cloud = Math.max(-0.45, Math.min(0.25, this._cloud));
    const irr = Math.max(0, Math.min(1, 0.22 + 0.9 * swing + cloud));
    return irr;
  }

  _busVoltage(loadW, pvW) {
    // open-circuit-ish curve for a 12 V SLA + surface charge while charging
    const base = 11.75 + 1.55 * this.soc;
    const sag = loadW * 0.012;
    const surface = pvW > loadW ? Math.min(0.16, (pvW - loadW) * 0.02) : 0;
    return base - sag + surface;
  }

  step(dtS = 1) {
    const irr = this._irradiance();
    // panel: ~17-19 V, current limited
    const pvP = Math.round(PANEL_PEAK_W * irr * 1000) / 1000;
    const pvV = 15.8 + 2.4 * irr + (Math.random() - 0.5) * 0.05;
    const pvI = pvV > 1 ? pvP / pvV : 0;

    let loadW = PRIMARY_W + (this.relay ? SECONDARY_W : 0);
    let bus = this._busVoltage(loadW, pvP);

    // --- firmware v10 relay policy (AUTO) --------------------------------
    this._dwellLow = bus < LVD ? this._dwellLow + 1 : 0;
    this._dwellHigh = bus > GATE ? this._dwellHigh + 1 : 0;
    if (this.mode === 'AUTO') {
      if (this._dwellLow >= DWELL && this.relay) { this.relay = false; this._dwellLow = 0; this._dwellHigh = 0; }
      else if (this._dwellHigh >= DWELL && !this.relay) { this.relay = true; this._dwellLow = 0; this._dwellHigh = 0; }
    }
    if (this.mode === 'SAVE') this.relay = false;
    if (this.mode === 'NORMAL') this.relay = true;

    // recompute after switching so the reported sample is self-consistent
    loadW = PRIMARY_W + (this.relay ? SECONDARY_W : 0);
    bus = this._busVoltage(loadW, pvP);

    // charge balance -> soc
    const netW = pvP * 0.85 - loadW;
    this.soc = Math.max(0.02, Math.min(1, this.soc + (netW * (dtS / 3600)) / BATTERY_WH));

    // compressed day: one full solar day per ~45 simulated minutes
    this.phase = (this.phase + (dtS / 3600) * 1.35) % 1;

    const loadV = bus - 0.004;
    const loadI = loadW / Math.max(1, loadV);

    this.t += dtS * 1000;

    return {
      t: this.t,
      pv: { v: round(pvV), i: round(pvI), p: round(pvP) },
      load: { v: round(loadV), i: round(loadI), p: round(loadW) },
      bus: round(bus),
      mode: this.mode === 'AUTO' ? (this.relay ? 'AUTO_NORMAL' : 'AUTO_SAVE') : this.mode,
      relay: this.relay,
      soc: round(this.soc * 100, 1),
      src: 'sim',
    };
  }
}

function round(n, d = 3) {
  const m = Math.pow(10, d);
  return Math.round(n * m) / m;
}

module.exports = { Simulator, LVD, GATE };
