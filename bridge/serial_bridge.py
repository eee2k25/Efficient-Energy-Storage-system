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

DEFAULTS = {
    "url": os.environ.get("DASHBOARD_URL", "http://localhost:3000"),
    "ingest_key": os.environ.get("INGEST_KEY", ""),
    "baud": 115200,
    "thingspeak_key": os.environ.get("THINGSPEAK_WRITE_KEY", ""),
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


def parse_line(line: str) -> dict | None:
    """Parse one serial line into a dashboard sample dict (or None)."""
    line = line.strip().strip("\r\n\x00")
    if not line or len(line) < 4:
        return None

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


def run_serial(args) -> int:
    try:
        import serial  # pyserial
    except ImportError:
        print("pyserial is not installed.  Run:  py -m pip install pyserial", file=sys.stderr)
        return 2

    print(f"[bridge] opening {args.port} @ {args.baud} baud …")
    try:
        ser = serial.Serial(args.port, args.baud, timeout=1)
    except serial.SerialException as e:
        msg = str(e)
        print(f"[bridge] could not open {args.port}: {msg}", file=sys.stderr)
        if "Permission" in msg or "Access is denied" in msg or "busy" in msg.lower():
            print("[bridge] The port is owned by another program. Close the Arduino Serial\n"
                  "         Monitor (or any other logger) and try again.", file=sys.stderr)
        return 1

    state = {"buffer": [], "ok": 0}
    send = (lambda cmd: (ser.write((cmd + "\n").encode()), ser.flush()))
    print(f"[bridge] posting to {args.url}  (Ctrl+C to stop)")
    try:
        while True:
            raw = ser.readline()
            if not raw:
                poll_commands(args, state, send)
                continue
            line = raw.decode("utf-8", errors="replace").strip()
            if not line:
                continue
            if args.sniff:
                print(f"  raw  │ {line}")
            sample = parse_line(line)
            if not sample:
                if args.sniff:
                    print("  !    │ unparsed — copy this line into the README and adjust the parser")
                continue
            if args.sniff:
                print(f"  ok   │ PV {sample.get('pv')}  LOAD {sample.get('load')}  mode={sample.get('mode')} relay={sample.get('relay')}")
            emit(sample, args, state)
            poll_commands(args, state, send)
    except KeyboardInterrupt:
        print("\n[bridge] stopped")
    finally:
        ser.close()
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
    ap.add_argument("--port", help="serial port, e.g. COM3 (Windows) or /dev/ttyUSB0 (Linux)")
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

    if args.sniff and not args.port and not args.stdin:
        ap.error("--sniff needs --port or --stdin")

    if args.stdin:
        return run_stdin(args)
    if not args.port:
        ap.error("--port is required (or use --stdin)")
    return run_serial(args)


if __name__ == "__main__":
    sys.exit(main())
