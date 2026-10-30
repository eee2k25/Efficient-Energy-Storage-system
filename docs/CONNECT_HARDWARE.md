# Connect the real ESP32 — step by step

Goal: replace the demo data with your actual PV / load / bus readings.
Time needed: about 5 minutes. **No firmware change is required.**

---

## Before anything: rotate the ThingSpeak keys you shared

The write key and read key were visible in a screenshot/chat. Treat them as
public:

1. ThingSpeak → your channel → **API Keys**
2. **Generate New Write API Key** (this invalidates the old one)
3. Leave the read key alone if the channel is private, or regenerate it too
4. Put the new keys in `bridge/.env` (see step 6) — **never** in a file you commit

The dashboard repo does not contain your keys anywhere.

---

## Path A — laptop + USB cable (do this first)

### 1. Install the one Python dependency (once)

```bat
py -m pip install pyserial
```

### 2. Make sure the dashboard is running in **live** mode

```bat
node dashboard/server.js
```

> If you started it with `--simulate`, real data will now automatically stop the
> simulator, but it's cleaner to start it without `--simulate`.

Leave that terminal open. The dashboard is at <http://localhost:3000>.

### 3. Close the Arduino Serial Monitor

Only one program can own `COM3`. If the Arduino IDE's Serial Monitor (or
PuTTY / any other logger) is open, the bridge gets `PermissionError 13`.

### 4. Find the port

```bat
py bridge/serial_bridge.py --list
```

Typical ESP32 boards show up as:

| Port | Description | Chip |
|---|---|---|
| `COM3` | Silicon Labs CP210x USB to UART Bridge | most dev boards |
| `COM4` | USB-SERIAL CH340 | cheap clones |
| `COM5` | Espressif USB JTAG/serial | ESP32-S3 / C3 native USB |
| `/dev/ttyUSB0` | CP210x | Linux |
| `/dev/cu.usbserial-*` | CP210x | macOS |

The tool also prints the most likely one.

### 5. Prove the serial lines parse — **do this before streaming**

```bat
py bridge/serial_bridge.py --port COM3 --sniff
```

You should see a pair of lines every couple of seconds:

```
  raw  │ PV: 18.42 V, 0.41 A, 7.55 W | LOAD: 12.38 V, 0.27 A, 3.27 W | AUTO_SAVE | relay OFF
  ok   │ PV {'v': 18.42, 'i': 0.41, 'p': 7.55}  LOAD {'v': 12.38, ...}  mode=AUTO_SAVE relay=False
```

`--sniff` posts nothing, so it is safe to run on the live rig.

**If you see `unparsed`**, copy that raw line to me (or to
[FIRMWARE_SERIAL.md](FIRMWARE_SERIAL.md)) and we adjust the parser, or you paste
the small JSON print from `firmware/telemetry_addon.ino`.

**If you see nothing at all:** wrong baud rate. Try `--baud 9600`, then
`--baud 74880`. Press the EN/RST button on the board.

### 6. Stream for real

```bat
py bridge/serial_bridge.py --port COM3
```

Expected output:

```
  preflight
  ✓ dashboard reachable  (LIVE, 0 samples buffered)
  ✓ pyserial installed
  ✓ serial port COM3 @ 115200 baud

[bridge] posting to http://localhost:3000
[bridge] ✓ first sample accepted — the dashboard is now receiving live data
  → AUTO_SAVE    PV  18.420V  0.410A  7.550W  LOAD  12.384V  1.759W  relay=OFF
```

Open <http://localhost:3000> — the connect-hardware panel disappears and the
charts fill with your readings.

### 7. Keep a raw log (recommended for the report)

```bat
py bridge/serial_bridge.py --port COM3 --log logs\run_normal_01.txt
```

Replay it later without hardware:

```bat
py bridge/serial_bridge.py --stdin --file logs\run_normal_01.txt --rate 2
```

### Optional: dashboard buttons

```bat
py bridge/serial_bridge.py --port COM3 --allow-control
```

This lets the AUTO / NORMAL / SAVE buttons in the browser send commands to the
ESP32 through the same serial line you'd type in. Without `--allow-control` the
buttons return an error and nothing is sent.

---

## Path B — ThingSpeak

Your channel **3551777** currently shows **Entries: 0**. ThingSpeak only has data
once something POSTs to it, so right now there is nothing for the dashboard to
read. Two ways forward:

### 1. The bridge writes to ThingSpeak (easiest, keeps Path A working)

```bat
py bridge/serial_bridge.py --port COM3 --thingspeak-key NEW_WRITE_KEY
```

It mirrors one reading every ~16 s (ThingSpeak's free-tier limit) while the
dashboard still updates at full rate locally.

Verify from your machine:

```bat
py tools/thingspeak_check.py --channel 3551777 --read-key NEW_READ_KEY
py tools/thingspeak_check.py --channel 3551777 --read-key R --write-key W --test-write
```

### 2. The ESP32 posts directly (no laptop, needs WiFi)

See `firmware/telemetry_addon.ino`, `ENABLE_WIFI_TELEMETRY 1`. **Read the warning
in that file first:** the HTTP call blocks for up to ~2 s, which can disturb PWM
timing and the LVD reaction. The serial bridge does not have this problem.

Then read the channel instead of the serial port:

```bat
set THINGSPEAK_CHANNEL=3551777
set THINGSPEAK_READ_KEY=NEW_READ_KEY
node dashboard/server.js
```

Field layout expected by the dashboard:

| Field | Meaning |
|---|---|
| 1 | PV voltage (V) |
| 2 | PV current (A) |
| 3 | PV power (W) |
| 4 | Load voltage (V) |
| 5 | Load current (A) |
| 6 | Load power (W) |
| 7 | Battery / bus voltage (V) |
| 8 | Controller mode text (`AUTO_NORMAL` / `AUTO_SAVE` / …) |

Different layout? Pass `THINGSPEAK_FIELDS=pvV:field2,pvI:field3,...`.

---

## Path C — put the dashboard on the internet

Needed if you want to show it from another device (or in the viva) while the
laptop with the ESP32 stays at home. This project needs a **long-running
container**, not a serverless host.

```bat
docker build -t ees-dashboard .
docker run -p 3000:3000 -v ees-data:/app/dashboard/data ^
  -e INGEST_KEY=my-secret-key -e ALLOW_CONTROL=0 ees-dashboard
```

Then point the bridge at the public URL:

```bat
py bridge/serial_bridge.py --port COM3 --url https://your-app.onrender.com --ingest-key my-secret-key
```

`render.yaml` does the same on Render, with a 1 GB disk for the telemetry log.

> Vercel / Netlify **will not work**: no long-lived SSE stream and no persistent
> disk. Use Render, Railway, Fly.io, or your own VPS.

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `PermissionError 13` / `Access is denied` | another program owns the port | close Arduino Serial Monitor, PuTTY, another bridge |
| `could not open the port: FileNotFoundError` | wrong port name | run `--list`, use the exact name |
| `no data at all` after 8 s | wrong baud, or ESP32 not printing | try `--baud 9600` / `--baud 74880`, press EN |
| `received N line(s) but none parsed` | unfamiliar format | run `--sniff`, send me a raw line, or paste the JSON print |
| Data appears then freezes | USB hub / cable dropped | the bridge auto-reconnects in 5 s; check `--log` output |
| Charts show "demo data" badge | server still simulating | restart without `--simulate` (or just send real data — the simulator stops itself) |
| Dashboard shows values but bus voltage looks wrong | `bus` field missing from the frame | print `bus` = load INA bus voltage |
| `dashboard unreachable` in the bridge | server not running / wrong `--url` | start `node dashboard/server.js`, check the URL |
| ThingSpeak entry stays at 0 | nothing POSTs to it | use `--thingspeak-key`, or enable firmware variant B |

---

## What I still need from you

To finish the calibration I only need **one thing**: the output of

```bat
py bridge/serial_bridge.py --port COM3 --sniff
```

pasted back here (a few lines). That tells me your exact format, whether the
numbers are sane, and whether `bus` is being reported — the one value the
12.40 V / 12.45 V logic depends on.
