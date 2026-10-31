# Deploy the dashboard for ₹0 — Render free tier + ESP32 over WiFi

This is the no-credit-card path. You get:

```
  ESP32 ══WiFi══►  https://<your-app>.onrender.com   ◄── phone / laptop / anywhere
    │                    ▲
    └── USB ── laptop ───┘   (same sketch, switch with "CLOUD OFF")
```

Two ways to feed the dashboard, **one firmware**, pick at runtime:

| Mode | Laptop needed | Latency | How you enter it |
|---|---|---|---|
| **WiFi cloud** | no | 2–5 s | Arduino Serial Monitor → `CLOUD ON` |
| **USB bridge** | yes | 2 s | Arduino Serial Monitor → `CLOUD OFF`, then run the bridge |

Nothing here needs a paid plan. Render's free tier needs **no card** — as long as the
blueprint asks only for free resources, which is what `render.yaml` now does.

---

## Before you start: read this, it is the actual blocker

Render's Hobby workspace gives **750 instance-hours per calendar month, shared by every
free service in the workspace**. Hours are only consumed **while a service is awake**.
A service that is asleep after 15 min of no traffic costs nothing.

```
one service awake 24/7          ≈  730 h/month   → eats the whole allowance
two services awake 24/7         ≈ 1460 h/month   → over the cap
```

**If the workspace hits 750 h, Render suspends *all* free web services until the 1st of
next month.** So with your two existing sites + this dashboard, all three cannot be
awake all month. Pick one:

- **Best:** leave this dashboard asleep most of the time — run the ESP32 in WiFi mode
  only during a session (`CLOUD ON`), then `CLOUD OFF` when you power down. A 3 h lab
  session × 20 sessions ≈ 60 h. Plenty left for the other two sites.
- Or delete / pause one of the two existing sites (Render Dashboard → the service →
  *Settings* → *Delete Service*). This also removes the "upgrade to add a card" prompt.
- Or accept that all free services get suspended near the end of a heavy month.

Check usage any time: Render Dashboard → **Billing** → free instance hours.

> This is also exactly why `render.yaml` used to demand a card: it asked for
> `plan: starter` and a 1 GB persistent disk. Free services **cannot** attach a disk,
> so that blueprint could never deploy on the free tier.

---

## Step 1 — deploy (about 5 minutes)

1. Merge this branch into `main` (or pick this branch in the next step).
2. Render Dashboard → **New +** → **Blueprint**.
3. Connect the `Efficient-Energy-Storage-system` repo, branch `main`, **Apply**.
4. Render shows one web service `ees-solar-dashboard` with instance type **Free**
   and region **Singapore**. If it asks for a card here, something still requests a
   paid resource or your workspace is out of hours — see the section above.
5. Wait for the first Docker build (~2–4 min). The log ends with:

```
  │  Efficient Energy Storage System — Telemetry Dashboard     │
  URL        : http://localhost:10000
  Mode       : LIVE (waiting for data)
  Ingest key : required
```

6. Note your URL, e.g. `https://ees-solar-dashboard-a1b2.onrender.com`.
7. **Copy the ingest key**: service → **Environment** → `INGEST_KEY` → reveal → copy.
   Every upload needs it. Treat it like a password; it is the only thing stopping
   strangers from pushing fake readings into your charts.

Health check (should be instant while the service is awake):

```
https://<your-app>.onrender.com/api/health
→ {"ok":true,"simulate":false,"samples":0,"lastSeen":null,...}
```

---

## Step 2 — prove the dashboard takes data (30 seconds, no ESP32)

Paste this in your **phone or laptop browser**, replacing the URL and key:

```
https://<your-app>.onrender.com/api/ingest?pvV=18.42&pvI=0.41&pvP=7.55&loadV=12.38&loadI=0.27&loadP=3.27&bus=12.38&mode=NORMAL&relay=1&key=<INGEST_KEY>
```

You should get `{"ok":true,"accepted":1,"rejected":0}`, and opening the dashboard shows
one reading. That single URL proves deploy + key + ingest all work before any firmware
debugging. (`GET /api/ingest` exists exactly for this; the firmware uses `POST`.)

---

## Step 3 — flash the firmware (WiFi mode)

Use **`firmware/telemetry_cloud_addon.ino`** — it replaces `telemetry_addon.ino`
(it is a superset: the same JSON serial line is still printed).

1. Copy the block between `BEGIN COPY` / `END COPY` into `SOLAR_PROJECT_CODE_v10.ino`,
   above `setup()`. **Do not include both addons.**
2. Fill in the four constants at the top of the block:

```cpp
#define CLOUD_URL        "https://ees-solar-dashboard-a1b2.onrender.com/api/ingest"
#define CLOUD_INGEST_KEY "the INGEST_KEY from Render"
#define CLOUD_WIFI_SSID  "your wifi name"
#define CLOUD_WIFI_PASS  "your wifi password"
```

3. In `setup()`, after `Serial.begin(115200);` add:

```cpp
telemetryCloudSetup();
```

4. At the **end of `loop()`**, add — using *your* variable names:

```cpp
telemetryCloudLoop(pvBusVoltage_V, pvCurrent_mA / 1000.0, pvPower_mW / 1000.0,
                   loadBusVoltage_V, loadCurrent_mA / 1000.0, loadPower_mW / 1000.0,
                   loadBusVoltage_V, currentStateName, relayOn);
```

5. Upload, open the Serial Monitor at **115200**. Within a second you see:

```
# telemetry: serial JSON every 2000 ms; cloud OFF (type CLOUD ON) every 5000 ms
# telemetry: target https://ees-solar-dashboard-a1b2.onrender.com/api/ingest
{"pv":{"v":18.42,"i":0.410,"p":7.55},"load":{"v":12.384,...},"mode":"AUTO_SAVE","relay":false}
```

6. Type **`CLOUD ON`** + Enter.

```
# telemetry: cloud mode ON (saved)
# telemetry: wifi: joining "your wifi name"
```

The dashboard starts moving 2–5 s later. Upload failures print
`# telemetry: upload failed (401)` etc. — see the troubleshooting table.

### Why this cannot hurt your control loop

The upload runs in its own FreeRTOS task on **core 0** with a 1-deep queue, so:

- `loop()` only writes 9 floats and returns — it never calls WiFi or TLS.
- TLS handshakes (~40 kB heap, ~1 s) happen on the other core.
- If WiFi dies, the queue keeps the newest reading and the task retries with
  back-off (10 s → 20 s → 40 s → 60 s) while your 12.40 V LVD protection keeps working.
- Nothing in your relay/PWM/AUTO-SAVE policy is referenced or changed.

---

## Step 4 — switching between WiFi and USB

Both modes live in the same sketch; you do not re-upload anything.

**Go laptop-free (USB unplugged):**

```
CLOUD ON        ← typed once in the Serial Monitor, remembered in NVS across reboots
```

Power the ESP32 from any 5 V source; it posts to Render every 5 s.

**Back to USB / Serial Monitor only:**

```
CLOUD OFF       ← stops posting and turns the WiFi radio off
```

Then, on the laptop:

```bash
node dashboard/server.js                      # local dashboard (optional)
py bridge/serial_bridge.py --port COM3        # USB readings → local dashboard
```

…or, if you want the **USB** readings on the **cloud** dashboard instead:

```bash
py bridge/serial_bridge.py --port COM3 ^
    --url https://<your-app>.onrender.com ^
    --ingest-key <INGEST_KEY>
```

`CLOUD STATUS` prints what is going on at any time:

```
# telemetry: cloud is ON, wifi up, url https://...
```

> Why `CLOUD OFF` before a USB session? Both paths would otherwise push the same
> reading twice (two sources, interleaved samples). You asked for one at a time —
> this is the switch.

### Remote buttons (optional)

`AUTO / NORMAL / SAVE` in the dashboard are enabled in `render.yaml`
(`ALLOW_CONTROL: "true"`). For the WiFi-only setup, the sketch polls the queue every
10 s and calls a handler you provide — nothing happens until you wire it to your
firmware's own mode variable:

```cpp
void onRemoteCommand(const char* cmd) {
  if      (strcmp(cmd, "SAVE")   == 0) currentStateName = "SAVE";
  else if (strcmp(cmd, "NORMAL") == 0) currentStateName = "NORMAL";
  else if (strcmp(cmd, "AUTO")   == 0) currentStateName = "AUTO";
}

// in setup():
telemetrySetRemoteCommandHandler(onRemoteCommand);
```

Your LVD trip should stay the final authority — a remote `NORMAL` must not be able to
overrule the 12.40 V protection.

**On a public URL, anyone with the link can press those buttons.** To keep the buttons
working for you and dead for strangers: Render → Environment → add
`CONTROL_KEY = <any long secret>`. The dashboard then asks for it once per browser and
remembers it. (Also keep `INGEST_KEY` set; rotate both if you ever screen-share them.)

---

## What the free plan actually means day to day

| Behaviour | Free tier | What it looks like |
|---|---|---|
| Sleep | after 15 min with no inbound traffic | first visit wakes it in ~30–60 s (Render's loading page) |
| RAM / CPU | 512 MB / 0.1 CPU | plenty: the server is ~40 MB and dependency-free |
| Disk | **none** — lost on restart/spin-down | after a wake, charts start empty and refill from your ESP32 |
| Hours | 750 / month / workspace | see the top of this page |
| Bandwidth | 5 GB / month | a browser tab is <5 MB/hour; fine |

Because there is no disk, `dashboard/data/samples.jsonl` only lives inside one
instance's lifetime. That is expected on the free plan. If you need history to survive,
use **Export CSV** while it is running, or move to a host with a volume, or write to
ThingSpeak from the bridge (`--thingspeak-key`).

The page is built for this: if the SSE stream drops (instance restarted), the UI falls
back to polling `/api/summary` every 5 s and re-draws `/api/series` every 4 s.

**Optional keep-alive:** pinging `/api/health` every 10 min from a free external
monitor (UptimeRobot, cron-job.org) keeps the service awake and kills the cold start —
but it also burns ~730 h/month, which will starve your other sites. For a demo, just
open the URL a minute before you present and let it warm up.

---

## If you outgrow Render free

- **Cloudflare Workers + D1** — never sleeps, needs no card, 100 k writes/day free.
  It is a port of `dashboard/server.js` (KV/D1 instead of the JSONL file); ask and I
  will do it. This is the clean upgrade when a sleeping dashboard stops being cute.
- **A ₹300/month VPS** with the existing `Dockerfile` — always on, real disk.
- ThingSpeak stays free and is a nice permanent archive regardless of host.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Blueprint asks for a credit card | a paid resource in the blueprint, or 750 h used | `render.yaml` must stay `plan: free` with no `disk:`; check Billing → instance hours |
| Build fails on `COPY dashboard ./dashboard` | wrong branch connected | deploy `main` (merged this branch), Dockerfile at repo root |
| `{"ok":false,"error":"bad api key"}` (401) | `INGEST_KEY` mismatch | copy it again from Render → Environment; no spaces |
| `{"ok":false,"accepted":0,"rejected":1}` (422) | no usable measurement in the body | field names must be `pv.v`, `load.v`, `bus`… or the GET short names |
| Dashboard stuck on "waiting for data" | nothing reaching the server | open `/api/health`, look at `lastSeen`/`lastAgeMs` |
| `# telemetry: cloud disabled` | placeholder still in the sketch | replace `YOUR_WIFI_NAME` / `PASTE_INGEST_KEY_HERE` / the URL |
| `# telemetry: upload failed (-1)` | TLS/WiFi | check `WiFi.status()`, try `http://` URL instead of `https://`, move closer to the router |
| `# telemetry: upload failed (401)` | wrong key | same fix as above |
| `# telemetry: upload failed (429/5xx)` | Render awake/rebuilding | retries are automatic with back-off |
| Page loads but charts empty | instance restarted (no disk) | wait for the next ESP32 samples, or press Export CSV next time |
| Buttons say `failed: control disabled` | `ALLOW_CONTROL=0` | set it to `true` in Environment |
| Buttons say `failed: control key required` | `CONTROL_KEY` is set | paste the key in the prompt |
| WiFi joins but nothing arrives | URL has a trailing space or `/api/ingest` missing | `CLOUD STATUS` prints the exact target it will use |

Local check without Render, same code path:

```bash
node dashboard/server.js                       # live mode
curl "http://localhost:3000/api/ingest?pvV=18.42&pvI=0.41&loadV=12.38&loadI=0.27&mode=NORMAL"
```
