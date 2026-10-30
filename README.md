# Solar Microgrid — Live Telemetry Dashboard

A web dashboard for the **ESP32 + dual INA219 solar microgrid** project. Instead of
watching numbers scroll past in the Arduino Serial Monitor, the readings are pushed
to a browser (or a cloud URL) where they are plotted, stored and analysed:

- **PV harvest, load demand, battery bus voltage, currents** — live charts + KPI cards
- **AUTO ↔ SAVE switching** — every relay transition logged, with the *measured*
  demand reduction of each shed interval (uses your real 1.759 W / 3.271 W numbers)
- **Protection view** — 12.40 V LVD trip and 12.45 V healthy-NORMAL gate drawn on the
  voltage chart, plus alerts when the bus falls into either band
- **Energy accounting** — Wh harvested / consumed / net for the window and for today
- **Live serial feed** — every parsed frame, colour-coded by controller state
- **Optional remote control** — queue `AUTO` / `NORMAL` / `SAVE` from the dashboard
- **CSV export** — one click, whole window, same schema as your bench logs
- **ThingSpeak support** — either push readings there or read them back from a channel

Works with **zero npm dependencies** (Node ≥ 18) and no build step.

---

## 1. Quick start

```bash
# demo mode — no hardware, simulated solar day with real bench load values
node dashboard/server.js --simulate

# open http://localhost:3000
```

Live mode (real ESP32 attached):

```bash
# terminal 1 — dashboard
node dashboard/server.js

# terminal 2 — serial bridge
py -m pip install pyserial
py bridge/serial_bridge.py --port COM3
```

That's it: whatever the ESP32 prints in the Serial Monitor now appears in the
browser as graphs. If your firmware prints in a different layout, the parser
handles most styles — see [docs/FIRMWARE_SERIAL.md](docs/FIRMWARE_SERIAL.md) and
run `--sniff` to check.

Run the end-to-end self-tests any time:

```bash
npm run selftest        # 36 checks: API, ingest, SSE, shedding math, persistence
npm run smoke           # 15 checks: boots the real page in jsdom, catches UI breakage
```

The UI smoke test needs one dev-only package: `npm i --no-save jsdom`.

---

## 2. How it fits together

```
  PV panel ──► INA219 0x41 ─┐
                            ├──► ESP32 (firmware v10, AUTO/SAVE policy)
  Load bus ──► INA219 0x40 ─┘            │
     ▲                                   │ USB serial (115200)
     │                                   ▼
  PWM controller ◄── relay ◄── secondary  serial_bridge.py
     │                                    │  HTTP POST /api/ingest
  primary LED (always on)                 ▼
                                  dashboard server  ──►  browser (SSE)
                                        │  ▲
                                        │  └── ThingSpeak channel (optional)
                                        └──► dashboard/data/samples.jsonl
```

Three ways to get data in — use any combination:

| Source | Enable with | Use when |
|---|---|---|
| Serial bridge (recommended) | `py bridge/serial_bridge.py --port COM3` | laptop is next to the hardware |
| ThingSpeak poller | `THINGSPEAK_CHANNEL=1234567 THINGSPEAK_READ_KEY=... node dashboard/server.js` | ESP32 already posts to ThingSpeak |
| Simulator | `node dashboard/server.js --simulate` | demos, report screenshots, UI work |

---

## 3. Connecting the ESP32

The bridge reads the same text lines the Arduino Serial Monitor shows, so you do
**not** need to change your control logic. Supported out of the box:

```
PV: 18.42 V, 0.41 A, 7.55 W | LOAD: 12.38 V, 0.27 A, 3.27 W | AUTO_SAVE | relay OFF
PV 18.42V 0.41A 7.55W  LOAD 12.38V 0.27A 3.27W  BAT 12.38V  MODE=AUTO_SAVE RLY=OFF
18.42,0.41,7.55,12.38,0.27,3.27,12.38,AUTO_SAVE,OFF
{"pv":{"v":18.42,"i":0.41,"p":7.55},"load":{"v":12.38,"i":0.27,"p":3.27},"mode":"AUTO_SAVE"}
```

Recommended: add **one** line to the firmware loop that prints JSON — most robust
and cheapest to parse. See [docs/FIRMWARE_SERIAL.md](docs/FIRMWARE_SERIAL.md) for
the exact snippet (it only adds `Serial.print`, nothing touches the relay policy).

Useful bridge options:

```bash
py bridge/serial_bridge.py --port COM3 --sniff          # show raw line + parse result
py bridge/serial_bridge.py --port COM3 --url https://my-dashboard.onrender.com
py bridge/serial_bridge.py --port COM3 --allow-control  # accept dashboard commands
py bridge/serial_bridge.py --stdin --file logs/run.csv  # replay a captured log
```

If the port is busy (`PermissionError 13` on Windows), close the Arduino Serial
Monitor first — only one program can own `COM3`.

---

## 4. ThingSpeak (optional)

**Push to ThingSpeak** from the bridge (free tier: one update / 15 s, handled
automatically):

```bash
py bridge/serial_bridge.py --port COM3 --thingspeak-key YOUR_WRITE_KEY
```

Field mapping: `field1..3` = PV V/I/W, `field4..6` = Load V/I/W, `field7` = bus
voltage, `field8` = controller state.

**Read from ThingSpeak** instead of serial:

```bash
THINGSPEAK_CHANNEL=1234567 THINGSPEAK_READ_KEY=ABC node dashboard/server.js
# override the mapping if your fields differ:
# THINGSPEAK_FIELDS=pvV:field1,pvI:field2,pvP:field3,loadV:field4,loadI:field5,loadP:field6
```

---

## 5. Remote control (optional)

The dashboard has `AUTO` / `NORMAL` / `SAVE` buttons. They only work when the
bridge is started with `--allow-control`, which then polls the server every 2 s and
writes the command to the ESP32 exactly as if you typed it in the Serial Monitor.

```bash
py bridge/serial_bridge.py --port COM3 --allow-control
```

Nothing is sent automatically: the buttons are manual, and your firmware's own
LVD protection remains the final authority. Disable the whole feature on a public
server with `ALLOW_CONTROL=0`.

---

## 6. Deploying to the cloud

The server needs a **long-lived process** (it holds an SSE stream, an in-memory
ring buffer and a JSONL file). Vercel/Netlify serverless functions are *not*
suitable — use a container host.

**Docker (anywhere):**

```bash
docker build -t ees-dashboard .
docker run -p 3000:3000 -v ees-data:/app/dashboard/data \
  -e INGEST_KEY=choose-a-key -e ALLOW_CONTROL=0 ees-dashboard
```

**Render / Railway / Fly.io:** deploy the repo as a Docker service, mount a
persistent disk at `/app/dashboard/data`, set `INGEST_KEY`, then point the bridge
at the public URL:

```bash
py bridge/serial_bridge.py --port COM3 --url https://your-app.onrender.com --ingest-key choose-a-key
```

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `HOST` | `0.0.0.0` | bind address |
| `SIMULATE` | off | `1` = demo generator, no hardware |
| `INGEST_KEY` | empty | if set, `/api/ingest` requires `x-api-key` |
| `ALLOW_CONTROL` | `true` | `0` disables the AUTO/NORMAL/SAVE endpoint |
| `DATA_DIR` | `dashboard/data` | where `samples.jsonl` lives (mount a volume) |
| `THINGSPEAK_CHANNEL` / `THINGSPEAK_READ_KEY` | — | read readings from ThingSpeak |
| `SIM_TICK_MS` | `1500` | simulated sample interval |

> **Security note:** the dashboard has no login. On a public URL set `INGEST_KEY`
> and `ALLOW_CONTROL=0`, or put it behind your host's auth/basic-auth.

---

## 7. HTTP API

| Method | Path | Purpose |
|---|---|---|
| `POST` | `/api/ingest` | accept one sample or an array (bridge / ESP32 / scripts) |
| `GET` | `/api/stream?range=15m` | SSE: `sample`, `summary`, `event` frames |
| `GET` | `/api/summary?range=15m` | latest sample, means, modes, energy, alerts |
| `GET` | `/api/series?range=15m&points=480` | bucket-averaged arrays for the charts |
| `GET` | `/api/events?range=all` | state intervals + shedding reduction |
| `GET` | `/api/export.csv?range=all` | CSV download (same columns as bench logs) |
| `POST` | `/api/command` | queue `AUTO` / `NORMAL` / `SAVE` |
| `GET` | `/api/commands?since=N` | bridge polls queued commands |
| `GET` | `/api/health` | uptime, buffer size, last-seen age |

Sample body (only one measurement is required, everything else is optional):

```json
{
  "t": 1793328342071,
  "pv":   { "v": 18.42, "i": 0.41, "p": 7.55 },
  "load": { "v": 12.38, "i": 0.27, "p": 3.27 },
  "bus": 12.38,
  "mode": "AUTO_SAVE",
  "relay": false
}
```

Ranges: `1m`, `5m`, `15m`, `30m`, `1h`, `6h`, `24h`, `all`.

---

## 8. Repository layout

```
dashboard/
  server.js            HTTP + SSE server (no dependencies)
  lib/store.js         ring buffer, JSONL persistence, bucketing, energy, events
  lib/simulator.js     demo generator (uses measured 1.759 W / 3.271 W values)
  lib/thingspeak.js    ThingSpeak channel reader
  public/              index.html · styles.css · app.js · chart.js (canvas charts)
bridge/
  serial_bridge.py     ESP32 serial → dashboard (+ ThingSpeak), --sniff, --allow-control
scripts/selftest.js    end-to-end API test (36 checks)
scripts/ui-smoke-test.js  runs the real page in jsdom (15 checks)
docs/
  FIRMWARE_SERIAL.md   exact print snippet + format calibration
  sample_serial_lines.txt  replayable example lines
Dockerfile
```

## 9. Notes on the data

- Persistence is append-only `dashboard/data/samples.jsonl`; it survives restarts and
  is replayed into the charts on boot (last ~24 MB). Delete it to start fresh.
- Energy uses trapezoidal integration and ignores gaps longer than 10 minutes, so
  closing the laptop overnight does not invent energy.
- The simulator reproduces the bench numbers from the project checkpoint
  (primary-only ≈ 1.759 W, both loads ≈ 3.271 W, ≈ 46 % shedding) and the firmware's
  12.40 V / 12.45 V hysteresis. It is clearly labelled **demo data** in the UI.
- This dashboard is **observation only** by default. It does not implement or
  replace the ML controller — the rule-based v10 firmware stays the active relay
  controller, exactly as recorded in the project checkpoint.
