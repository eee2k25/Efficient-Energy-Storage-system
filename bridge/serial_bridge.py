#!/usr/bin/env python3
"""
serial_bridge.py — connect the ESP32 solar microgrid to the web dashboard.

Reads the ESP32's serial output (the same lines you see in the Arduino Serial
Monitor), parses the PV/load/mode/relay values, and POSTs them to the dashboard
server. Optionally mirrors every reading to ThingSpeak.

    # live ESP32 on COM3 -> dashboard on the same laptop
    py serial_bridge.py --port COM3

    # ESP32 -> dashboard hosted in the cloud, plus ThingSpeak
    py serial_bridge.py --port COM3 ^
        --url https://your-dashboard.onrender.com ^
        --ingest-key YOUR_KEY ^
        --thingspeak-key ABC123XYZ

    # look at raw lines and how they parsed (format calibration)
    py serial_bridge.py --port COM3 --sniff

    # replay a captured log file instead of hardware
    py bridge/serial_bridge.py --stdin --file docs/sample_serial_lines.txt

Install once:   py -m pip install pyserial

The parser accepts most human-readable layouts, e.g. all of these work:

    PV: 18.42 V, 0.41 A, 7.55 W | LOAD: 12.38 V, 0.27 A, 3.27 W | AUTO_SAVE | relay OFF
    PV 18.42V 0.41A 7.55W  LOAD 12.38V 0.27A 3.27W  BAT 12.38V  MODE=AUTO_SAVE RLY=OFF
    18.42,0.41,7.55,12.38,0.27,3.27,12.38,AUTO_SAVE,OFF
    {"pv":{"v":18.42,"i":0.41,"p":7.55}, "load":{"v":12.38,"i":0.27,"p":3.27}, "mode":"AUTO_SAVE"}
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

# ─────────────────────────── configuration ───────────────────────────

def load_env_file(path: str) -> None:
    """Minimal .env loader (no dependencies): KEY=VALUE lines, # comments."""
    if not path or not os.path.isfile(path):
        return
    with open(path, "r", encoding="utf-8") as fh:
        for raw in fh:
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip('"').strip("'")
            if key and key not in os.environ:      # real env wins over the file
                os.environ[key] = val


load_env_file(os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env"))

DEFAULTS = {
    "url": os.environ.get("DASHBOARD_URL", "http://localhost:3000"),
    "ingest_key": os.environ.get("INGEST_KEY", ""),
    "baud": int(os.environ.get("SERIAL_BAUD", "115200") or 115200),
    "thingspeak_key": os.environ.get("THINGSPEAK_WRITE_KEY", ""),
    "thingspeak_channel": os.environ.get("THINGSPEAK_CHANNEL", ""),
}

MODES = ("AUTO_NORMAL", "AUTO_SAVE", "AUTONORMAL", "AUTOSAVE", "NORMAL", "SAVE", "AUTO", "MANUAL")
MODE_CANON = {"AUTOSAVE": "AUTO_SAVE", "AUTONORMAL": "AUTO_NORMAL"}

# ───────────────────────────── parsing ─────────────────────────────

NUM = r"[-+]?\d+(?:\.\d+)?"

# Any of these words starts a new measurement group inside a line, so a single
# line may carry several groups separated only by spaces.
LABEL_TOKEN = re.compile(
    r"\b(PV|PANEL|SOLAR|LOAD|OUTPUT|LAMP|LED|BATTERY|VBAT|BAT|BUS|V ?BUS)\b",
    re.IGNORECASE,
)
UNIT_RE = re.compile(rf"(?<![\d.])({NUM})\s*(mV|V|mA|A|mW|W)\b", re.IGNORECASE)


def _label_group(label: str) -> str | None:
    """Map a label token to a measurement group."""
    l = label.lower().replace(" ", "")
    if l in ("pv", "panel", "solar"):
        return "pv"
    if l in ("load", "output", "lamp", "led"):
        return "load"
    if l in ("bat", "battery", "vbat", "bus", "vbus"):
        return "bus"
    return None


def _values_with_units(text: str) -> dict:
    """First value of each unit in a chunk -> {'v': .., 'a': .., 'w': ..}."""
    found = {}
    for m in UNIT_RE.finditer(text):
        val = float(m.group(1))
        unit = m.group(2).lower().lstrip("m")
        if unit in ("v", "a", "w") and unit not in found:
            found[unit] = val
    return found


def _order_values(text: str):
    """Positional fallback: every number in the text, in order."""
    return [float(x) for x in re.findall(NUM, text)]


KV_RE = re.compile(r"\b([A-Za-z][A-Za-z0-9_]{0,16})\s*=\s*([-+]?\d+(?:\.\d+)?)")
KV_UNIT = (("voltage", "v"), ("_v", "v"), ("volt", "v"), ("current", "a"), ("_i", "a"),
           ("_a", "a"), ("amp", "a"), ("power", "w"), ("_p", "w"), ("_w", "w"), ("watt", "w"))


def _parse_keyvals(line: str) -> dict:
    """Handle `pv_v=18.55 load_a=0.26 load_w=3.24 bat_v=12.44` style frames."""
    out: dict = {}
    for m in KV_RE.finditer(line):
        key = m.group(1).lower()
        try:
            val = float(m.group(2))
        except ValueError:
            continue
        group = _label_group(key.split("_")[0]) or ("bus" if "bat" in key or "bus" in key else None)
        if group is None:
            continue
        unit = next((u for suffix, u in KV_UNIT if key.endswith(suffix) or suffix in key), None)
        if unit is None:
            continue
        if group == "bus":
            if unit == "v":
                out["bus"] = val
            continue
        unit = {"a": "i", "w": "p"}.get(unit, unit)   # normalise to v/i/p slots
        slot = out.setdefault(group, {"v": None, "i": None, "p": None})
        slot[unit] = val
        if group == "load" and unit == "v" and out.get("bus") is None:
            out["bus"] = val
    return out


def _fill(group: str, vals: dict, out: dict) -> None:
    if group == "bus":
        if "v" in vals:
            out["bus"] = vals["v"]
        return
    if group not in ("pv", "load"):
        return
    v, a, w = vals.get("v"), vals.get("a"), vals.get("w")
    if v is None and a is None and w is None:
        return
    out[group] = {"v": v, "i": a, "p": w}
    if group == "load" and out.get("bus") is None and v is not None:
        out["bus"] = v


def _finite_field(text: str) -> float | None:
    """Convert a CSV field to a finite float; ESP32 uses `nan` for battery INA fields."""
    try:
        value = float(text.strip())
    except (TypeError, ValueError):
        return None
    return value if value == value and value not in (float("inf"), float("-inf")) else None


def _parse_v10_data(line: str) -> dict | None:
    """Parse the final v10 ESP32 DATA frame exactly.

    Final firmware emits:
      DATA,time_s,pv_V,pv_mA,pv_mW,bat_V,bat_mA,bat_mW,
           load_V,load_mA,load_mW,secondary_load

    Battery fields are intentionally `nan` in the two-INA final design.  The
    dashboard must *not* treat the first positional value (`time_s`) as PV
    voltage, nor present mA/mW as A/W.  This dedicated branch performs the
    required mA→A and mW→W conversions.
    """
    fields = [f.strip() for f in line.split(",")]
    if len(fields) != 12 or fields[0].upper() != "DATA":
        return None

    pv_v = _finite_field(fields[2])
    pv_ma = _finite_field(fields[3])
    pv_mw = _finite_field(fields[4])
    load_v = _finite_field(fields[8])
    load_ma = _finite_field(fields[9])
    load_mw = _finite_field(fields[10])
    secondary = fields[11].upper()

    # Reject the known INA/PWM power-up settling frames (around 0–2 V) while
    # retaining every plausible operating or safety-voltage frame.  A 12 V
    # SLA load bus should never be legitimately below 8 V in this prototype.
    if None in (pv_v, pv_ma, pv_mw, load_v, load_ma, load_mw):
        return None
    if not (0.0 <= pv_v <= 32.0 and 8.0 <= load_v <= 20.0):
        return None

    # The final firmware has documented polarity compensation for the
    # permanently reverse-mounted Load INA.  Refuse old negative-load frames
    # so the public dashboard cannot accidentally display pre-correction data.
    if load_ma < -0.5 or load_mw < -5.0:
        return None
    if secondary not in ("ON", "OFF"):
        return None

    relay_on = secondary == "ON"
    return {
        "pv": {"v": pv_v, "i": pv_ma / 1000.0, "p": pv_mw / 1000.0},
        "load": {"v": load_v, "i": load_ma / 1000.0, "p": load_mw / 1000.0},
        "bus": load_v,
        # DATA contains relay state rather than the controller's full command
        # mode.  The dashboard labels the two demonstrated operating states
        # from that state, without claiming ML or remote control authority.
        "mode": "NORMAL" if relay_on else "SAVE",
        "relay": relay_on,
        "src": "serial",
    }


def parse_line(line: str) -> dict | None:
    """Parse one serial line into a dashboard sample dict (or None)."""
    line = line.strip().strip("\r\n\x00")
    if not line or len(line) < 4:
        return None

    # 0) Final project v10 DATA CSV frame. This must precede the generic
    # positional fallback because DATA begins with a time_s field.
    if line.upper().startswith("DATA,"):
        return _parse_v10_data(line)

    # 1) JSON frame - the most robust option for the firmware
    if line.startswith("{"):
        try:
            obj = json.loads(line)
        except json.JSONDecodeError:
            obj = None
        if isinstance(obj, dict):
            parsed = _from_json(obj)
            if parsed:
                return parsed

    out: dict = {}
    labelled = 0

    # 2) labelled groups anywhere in the line
    marks = list(LABEL_TOKEN.finditer(line))
    for i, m in enumerate(marks):
        group = _label_group(m.group(1))
        if not group:
            continue
        end = marks[i + 1].start() if i + 1 < len(marks) else len(line)
        chunk = line[m.end():end]
        vals = _values_with_units(chunk)
        if vals:
            labelled += 1
            _fill(group, vals, out)

    # 2b) key=value frames (pv_v=18.55 load_a=0.26 ...), merged into whatever
    # the labelled pass already found so mixed frames still work.
    kv = _parse_keyvals(line)
    for group, vals in kv.items():
        if group == "bus":
            if out.get("bus") is None:
                out["bus"] = vals
            continue
        slot = out.setdefault(group, {"v": None, "i": None, "p": None})
        for k in ("v", "i", "p"):
            if slot.get(k) is None and vals.get(k) is not None:
                slot[k] = vals[k]
        labelled = 1

    # 2c) still nothing: assume the classic six-number order
    if labelled == 0:
        nums = _order_values(line)
        if len(nums) >= 6:
            out["pv"] = {"v": nums[0], "i": nums[1], "p": nums[2]}
            out["load"] = {"v": nums[3], "i": nums[4], "p": nums[5]}
            if len(nums) >= 7:
                out["bus"] = nums[6]
        elif len(nums) >= 3:
            out["pv"] = {"v": nums[0], "i": nums[1], "p": nums[2]}

    # 3) mode + relay, independent of the numeric layout
    upper = line.upper()
    for token in MODES:
        if re.search(rf"(?<![A-Z_]){token}(?![A-Z_])", upper):
            out["mode"] = MODE_CANON.get(token, token)
            break
    rm = re.search(r"(?:RELAY|RLY|SW)[\s:=]*(ON|OFF|1|0|TRUE|FALSE)", upper)
    if rm:
        out["relay"] = rm.group(1) in ("ON", "1", "TRUE")

    if "pv" in out or "load" in out or "bus" in out:
        out["src"] = "serial"
        return out
    return None


def _from_json(obj: dict) -> dict | None:
    """Normalise a JSON frame from the firmware."""
    out: dict = {}
    for key, alias in (("pv", "pv"), ("load", "load"), ("panel", "pv"), ("output", "load")):
        node = obj.get(alias) or obj.get(key)
        if isinstance(node, dict):
            out[alias] = {
                "v": _num(node.get("v", node.get("voltage"))),
                "i": _num(node.get("i", node.get("current"))),
                "p": _num(node.get("p", node.get("power"))),
            }
        elif isinstance(node, (int, float)):
            # flat form: pv = power in W
            out[alias] = {"v": None, "i": None, "p": float(node)}
    bus = _num(obj.get("bus", obj.get("bat", obj.get("vbat"))))
    if bus is not None:
        out["bus"] = bus
    elif "load" in out:
        out["bus"] = out["load"]["v"]
    mode = obj.get("mode", obj.get("state"))
    if mode:
        out["mode"] = str(mode).upper().replace(" ", "_")
    relay = obj.get("relay")
    if isinstance(relay, bool):
        out["relay"] = relay
    elif isinstance(relay, (int, float)):
        out["relay"] = bool(relay)
    elif isinstance(relay, str):
        out["relay"] = relay.strip().upper() in ("ON", "1", "TRUE")
    out["src"] = "serial"
    return out if any(k in out for k in ("pv", "load", "bus")) else None


def _num(v):
    try:
        if v is None or v == "":
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


# ───────────────────────────── transport ─────────────────────────────

def post_json(url: str, payload, key: str = "", timeout: float = 6.0):
    body = json.dumps(payload).encode()
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("content-type", "application/json")
    if key:
        req.add_header("x-api-key", key)
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return res.status, res.read(400).decode(errors="replace")


_last_ts_post = 0.0


def post_thingspeak(write_key: str, sample: dict, min_interval: float = 16.0) -> None:
    """Mirror the sample to ThingSpeak (free tier allows one update / 15 s)."""
    global _last_ts_post
    if not write_key or time.time() - _last_ts_post < min_interval:
        return
    pv, load = sample.get("pv") or {}, sample.get("load") or {}
    params = {
        "api_key": write_key,
        "field1": _fmt(pv.get("v")), "field2": _fmt(pv.get("i")), "field3": _fmt(pv.get("p")),
        "field4": _fmt(load.get("v")), "field5": _fmt(load.get("i")), "field6": _fmt(load.get("p")),
        "field7": _fmt(sample.get("bus")),
        "field8": (sample.get("mode") or "")[:255],
        "status": "ESP32 solar microgrid",
    }
    url = "https://api.thingspeak.com/update?" + urllib.parse.urlencode({k: v for k, v in params.items() if v not in (None, "")})
    try:
        with urllib.request.urlopen(url, timeout=8) as res:
            res.read(64)
        _last_ts_post = time.time()
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"  ! ThingSpeak update failed: {e}", file=sys.stderr)


def _fmt(v):
    return "" if v is None else f"{v:.3f}"


# ───────────────────────────── main loop ─────────────────────────────

def emit(sample: dict, args, state: dict) -> None:
    """Push a parsed sample to the dashboard, with retry-on-failure buffering."""
    state["count"] = state.get("count", 0) + 1
    state["buffer"].append(sample)
    if len(state["buffer"]) > 400:
        del state["buffer"][: len(state["buffer"]) - 400]

    payload = state["buffer"] if len(state["buffer"]) > 1 else sample
    try:
        code, body = post_json(args.url.rstrip("/") + "/api/ingest", payload, args.ingest_key)
        if code >= 400:
            print(f"  ! dashboard rejected ({code}): {body[:120]}", file=sys.stderr)
            return
        state["buffer"].clear()
        state["ok"] = state.get("ok", 0) + 1
        if state["ok"] % args.echo_every == 1:
            pv, load = sample.get("pv") or {}, sample.get("load") or {}
            print(
                f"  → {sample.get('mode') or '—':<12} "
                f"PV {_fmt(pv.get('v')) or '--':>7}V {_fmt(pv.get('i')) or '--':>6}A {_fmt(pv.get('p')) or '--':>6}W  "
                f"LOAD {_fmt(load.get('v')) or '--':>7}V {_fmt(load.get('p')) or '--':>6}W  "
                f"relay={'ON' if sample.get('relay') else 'OFF' if sample.get('relay') is False else '?'}"
            )
    except (urllib.error.URLError, TimeoutError, OSError) as e:
        state["fail"] = state.get("fail", 0) + 1
        if state["fail"] in (1, 10, 100) or state["fail"] % 50 == 0:
            print(f"  ! dashboard unreachable ({e}). Buffering {len(state['buffer'])} sample(s).", file=sys.stderr)

    if args.thingspeak_key:
        post_thingspeak(args.thingspeak_key, sample)


def poll_commands(args, state: dict, send) -> None:
    """Fetch queued AUTO/NORMAL/SAVE commands and write them to the ESP32."""
    if not args.allow_control or not send:
        return
    now = time.time()
    if now - state.get("last_cmd_poll", 0) < 2.0:
        return
    state["last_cmd_poll"] = now
    try:
        url = f"{args.url.rstrip('/')}/api/commands?since={state.get('last_cmd_id', 0)}&ack=1"
        req = urllib.request.Request(url)
        if args.ingest_key:
            req.add_header("x-api-key", args.ingest_key)
        with urllib.request.urlopen(req, timeout=4) as res:
            data = json.loads(res.read().decode() or "{}")
        for cmd in data.get("commands", []):
            state["last_cmd_id"] = max(state.get("last_cmd_id", 0), int(cmd.get("id", 0)))
            send(cmd["cmd"])
            print(f"  ← dashboard command: {cmd['cmd']} (sent to ESP32)")
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
        pass


def dashboard_health(url: str, key: str = "") -> dict | None:
    try:
        req = urllib.request.Request(url.rstrip("/") + "/api/health")
        if key:
            req.add_header("x-api-key", key)
        with urllib.request.urlopen(req, timeout=5) as res:
            return json.loads(res.read().decode() or "{}")
    except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError):
        return None


def preflight(args) -> bool:
    """Print a short checklist so the user knows what is and isn't ready."""
    print("\n  preflight")
    health = dashboard_health(args.url, args.ingest_key)
    if health is None:
        print(f"  ✗ dashboard not reachable at {args.url}")
        print("     start it with:  node dashboard/server.js")
        print("     (samples will be buffered until it comes up)")
    else:
        mode = "SIMULATION" if health.get("simulate") else "LIVE"
        print(f"  ✓ dashboard reachable  ({mode}, {health.get('samples', 0)} samples buffered)")
        if health.get("simulate"):
            print("     ⚠ the server is in simulation mode — restart it WITHOUT --simulate")
            print("       so the charts show only your real hardware.")

    try:
        import serial  # noqa: F401
        print("  ✓ pyserial installed")
    except ImportError:
        print("  ✗ pyserial missing — run:  py -m pip install pyserial")
        return False

    port = args.port or autodetect_port()
    if not port:
        print("  ✗ no serial port found — is the ESP32 plugged in?")
        list_ports_brief()
        return False
    print(f"  ✓ serial port {port} @ {args.baud} baud")
    print()
    return health is not None


def _usb_score(dev) -> int:
    desc = f"{dev.description or ''} {dev.manufacturer or ''} {dev.hwid or ''}".lower()
    score = 0
    for token in ("cp210", "ch340", "ch910", "silicon labs", "ftdi", "usb", "uart", "espressif"):
        if token in desc:
            score += 2
    if dev.device and ("usb" in dev.device.lower() or "acm" in dev.device.lower()):
        score += 1
    return score


def _ports():
    import serial.tools.list_ports as lp
    return sorted(lp.comports(), key=lambda d: d.device or "")


def list_ports_brief() -> None:
    ports = _ports()
    if not ports:
        print("     no serial ports detected")
        return
    for d in ports:
        print(f"     {d.device:<14} {d.description or 'unknown device'}")


def _is_legacy_port(dev) -> bool:
    """Motherboard UARTs (Linux ttyS*, some COM1) are never the ESP32."""
    name = (dev.device or "").lower()
    if re.match(r"/dev/tty(s|ama|acm-legacy)\d", name):
        return True
    if name in ("com1",) and not dev.description:
        return True
    return False


def autodetect_port() -> str | None:
    """Pick the most likely ESP32 port (CP210x / CH340 / USB serial)."""
    try:
        ports = _ports()
    except Exception:
        return None
    candidates = [d for d in ports if not _is_legacy_port(d)]
    scored = sorted(candidates, key=_usb_score, reverse=True)
    if scored and _usb_score(scored[0]) > 0:
        return scored[0].device
    if len(candidates) == 1:
        return candidates[0].device
    return None


def open_port(port: str, baud: int):
    import serial
    ser = serial.Serial()
    ser.port = port
    ser.baudrate = baud
    ser.timeout = 1
    ser.write_timeout = 2
    # Avoid the classic "ESP32 resets when the port opens" surprise.
    for attr, val in (("dtr", False), ("rts", False)):
        try:
            setattr(ser, attr, val)
        except Exception:
            pass
    ser.open()
    return ser


def _port_hint(err: Exception) -> None:
    msg = str(err)
    low = msg.lower()
    print(f"[bridge] could not open the port: {msg}", file=sys.stderr)
    if "permission" in low or "access is denied" in low or "busy" in low or "errno 16" in low:
        print("[bridge] The port is owned by another program. Close the Arduino IDE\n"
              "         Serial Monitor (or any other logger) and run this again.\n"
              "         On Windows you can check with:  py bridge/serial_bridge.py --list",
              file=sys.stderr)
    elif "file not found" in low or "no such file" in low or "cannot find" in low:
        print("[bridge] That port does not exist. Run:  py bridge/serial_bridge.py --list",
              file=sys.stderr)


def run_serial(args) -> int:
    try:
        import serial
    except ImportError:
        print("pyserial is not installed.  Run:  py -m pip install pyserial", file=sys.stderr)
        return 2

    port = args.port
    if not port or port.lower() == "auto":
        port = autodetect_port()
        if not port:
            print("[bridge] could not auto-detect the ESP32. Available ports:", file=sys.stderr)
            list_ports_brief()
            print("[bridge] pass one explicitly:  --port COM3", file=sys.stderr)
            return 1
        print(f"[bridge] auto-detected port {port}")

    preflight(args)
    if args.dry_run:
        print("[bridge] --dry-run: port and dashboard look usable, nothing was read.")
        return 0

    print(f"[bridge] opening {port} @ {args.baud} baud …")
    try:
        ser = open_port(port, args.baud)
    except Exception as e:  # SerialException, PermissionError, OSError
        _port_hint(e)
        return 1

    logfh = None
    if args.log:
        try:
            os.makedirs(os.path.dirname(os.path.abspath(args.log)), exist_ok=True)
            logfh = open(args.log, "a", encoding="utf-8")
            print(f"[bridge] capturing raw lines to {args.log}")
        except OSError as e:
            print(f"[bridge] cannot write log file: {e}", file=sys.stderr)

    state = {"buffer": [], "ok": 0}
    send = (lambda cmd: (ser.write((cmd + "\n").encode()), ser.flush()))
    print(f"[bridge] posting to {args.url}  (Ctrl+C to stop)\n")

    started = time.time()
    lines_seen = 0
    samples_seen = 0
    announce_idle = started + 8

    try:
        while True:
            try:
                raw = ser.readline()
            except (serial.SerialException, OSError) as e:
                print(f"\n[bridge] serial link lost ({e}); reconnecting in 5 s…", file=sys.stderr)
                try:
                    ser.close()
                except Exception:
                    pass
                time.sleep(5)
                try:
                    ser = open_port(port, args.baud)
                    print("[bridge] reconnected")
                except Exception as e2:
                    _port_hint(e2)
                    return 1
                continue

            if not raw:
                poll_commands(args, state, send)
                if time.time() > announce_idle and samples_seen == 0:
                    if lines_seen == 0:
                        print("[bridge] no data at all — is the ESP32 printing? Try a different\n"
                              "         --baud (9600 is common) or press the EN/RST button.")
                    else:
                        print(f"[bridge] received {lines_seen} line(s) but none parsed — run with\n"
                              "         --sniff to see the raw text and adjust the format.")
                    announce_idle = time.time() + 30
                continue

            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            lines_seen += 1
            if logfh:
                logfh.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {line}\n")
                logfh.flush()

            if args.sniff:
                print(f"  raw  │ {line}")
            sample = parse_line(line)
            if not sample:
                if args.sniff:
                    print("  !    │ unparsed — see docs/FIRMWARE_SERIAL.md")
                continue

            samples_seen += 1
            if args.sniff:
                print(f"  ok   │ PV {sample.get('pv')}  LOAD {sample.get('load')}  "
                      f"mode={sample.get('mode')} relay={sample.get('relay')}")
                continue

            emit(sample, args, state)
            if samples_seen == 1:
                print("[bridge] ✓ first sample accepted — the dashboard is now receiving live data")
                if state.get("fail"):
                    print("[bridge]   (dashboard was unreachable earlier; buffered samples will flush)")
            poll_commands(args, state, send)
    except KeyboardInterrupt:
        print("\n[bridge] stopped by user")
    finally:
        try:
            ser.close()
        except Exception:
            pass
        if logfh:
            logfh.close()
        print(f"[bridge] {samples_seen} sample(s) parsed from {lines_seen} line(s)")
    return 0


def run_stdin(args) -> int:
    src = open(args.file, "r", encoding="utf-8", errors="replace") if args.file else sys.stdin
    state = {"buffer": [], "ok": 0}

    # When replaying a file, spread timestamps over the recent past so the
    # dashboard charts show a real time axis instead of one stacked column.
    step_ms = 1000.0 / args.rate if args.rate else 1000.0
    t_cursor = None
    if args.file:
        with open(args.file, "r", encoding="utf-8", errors="replace") as fh:
            n_lines = sum(1 for ln in fh if ln.strip() and not ln.lstrip().startswith("#"))
        t_cursor = time.time() * 1000 - n_lines * step_ms
    print(f"[bridge] reading {'from ' + args.file if args.file else 'stdin'} → {args.url}")
    try:
        for line in src:
            line = line.rstrip("\n")
            if not line.strip() or line.lstrip().startswith("#"):
                continue
            sample = parse_line(line)
            if args.sniff or not sample:
                print(f"  raw │ {line}")
            if not sample:
                print("  !   │ unparsed")
                continue
            if t_cursor is not None and "t" not in sample:
                sample["t"] = int(t_cursor)
                t_cursor += step_ms
            if args.sniff:
                print(f"  ok  │ {sample}")
            else:
                emit(sample, args, state)
            if args.rate:
                time.sleep(1.0 / args.rate)
    except KeyboardInterrupt:
        pass
    finally:
        if args.file:
            src.close()
    print(f"[bridge] done — {state.get('ok', 0)} sample(s) accepted")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser(
        description="ESP32 solar microgrid → web dashboard serial bridge",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__.split("The parser accepts")[0],
    )
    ap.add_argument("--port", help="serial port, e.g. COM3 (Windows) or /dev/ttyUSB0 (Linux); 'auto' guesses")
    ap.add_argument("--list", action="store_true", help="list available serial ports and exit")
    ap.add_argument("--dry-run", action="store_true", help="check port + dashboard, then exit without reading")
    ap.add_argument("--log", help="append every raw serial line to this file (replay later with --stdin)")
    ap.add_argument("--baud", type=int, default=DEFAULTS["baud"])
    ap.add_argument("--url", default=DEFAULTS["url"], help="dashboard base URL (default %(default)s)")
    ap.add_argument("--ingest-key", default=DEFAULTS["ingest_key"], help="INGEST_KEY of the server, if set")
    ap.add_argument("--thingspeak-key", default=DEFAULTS["thingspeak_key"], help="ThingSpeak write API key (optional)")
    ap.add_argument("--allow-control", action="store_true",
                    help="accept AUTO/NORMAL/SAVE commands from the dashboard and send them to the ESP32")
    ap.add_argument("--sniff", action="store_true", help="print raw lines + parse result, do not post")
    ap.add_argument("--stdin", action="store_true", help="read lines from stdin (or --file) instead of a serial port")
    ap.add_argument("--file", help="log file to replay with --stdin")
    ap.add_argument("--rate", type=float, default=0, help="with --stdin, replay at N lines/second")
    ap.add_argument("--echo-every", type=int, default=10, help="print a confirmation every N samples")
    args = ap.parse_args()

    if args.list:
        print("Available serial ports:")
        list_ports_brief()
        guess = autodetect_port()
        if guess:
            print(f"\nMost likely ESP32 port: {guess}")
            print(f"  py bridge/serial_bridge.py --port {guess} --sniff")
        return 0

    if args.sniff and not args.port and not args.stdin:
        ap.error("--sniff needs --port or --stdin")

    if args.stdin:
        return run_stdin(args)
    if not args.port:
        ap.error("--port is required (or use --stdin)")
    return run_serial(args)


if __name__ == "__main__":
    sys.exit(main())
