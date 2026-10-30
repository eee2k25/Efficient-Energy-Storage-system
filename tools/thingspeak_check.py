#!/usr/bin/env python3
"""
thingspeak_check.py — prove your ThingSpeak channel and API keys actually work,
then translate the channel's fields into the dashboard's schema.

Run this on your own machine (the sandbox this project was built in cannot reach
api.thingspeak.com, so this tool is how you verify the connection).

    # show the latest entries and how they would appear on the dashboard
    py tools/thingspeak_check.py --channel 3551777 --read-key YOUR_READ_KEY

    # also prove the write key works (adds one visible test entry)
    py tools/thingspeak_check.py --channel 3551777 --read-key R --write-key W --test-write

    # verify the field mapping logic without any network access
    py tools/thingspeak_check.py --offline-selftest

Field mapping used by the dashboard (change with --fields if yours differs):

    field1 PV voltage (V)   field2 PV current (A)    field3 PV power (W)
    field4 Load voltage (V) field5 Load current (A)  field6 Load power (W)
    field7 Battery / bus voltage (V)                 field8 controller mode text
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.parse
import urllib.request

DEFAULT_FIELDS = {
    "pv_v": "field1", "pv_i": "field2", "pv_p": "field3",
    "load_v": "field4", "load_i": "field5", "load_p": "field6",
    "bus": "field7", "mode": "field8",
}

SAMPLE_FEED = {
    "created_at": "2026-10-30T08:45:12Z",
    "entry_id": 42,
    "field1": "18.42", "field2": "0.410", "field3": "7.552",
    "field4": "12.384", "field5": "0.142", "field6": "1.759",
    "field7": "12.384", "field8": "AUTO_SAVE",
}

SAMPLE_EMPTY = {
    "created_at": "2026-10-30T08:45:12Z",
    "entry_id": None,
    "field1": None, "field2": None, "field3": None, "field4": None,
    "field5": None, "field6": None, "field7": None, "field8": None,
}


def get_json(url: str, timeout: float = 10.0):
    req = urllib.request.Request(url, headers={"user-agent": "ees-dashboard/1.0"})
    with urllib.request.urlopen(req, timeout=timeout) as res:
        return json.loads(res.read().decode() or "{}")


def parse_fields(spec: str | None) -> dict:
    if not spec:
        return dict(DEFAULT_FIELDS)
    mapping = {}
    alias = {"pv_v": "pv_v", "pvv": "pv_v", "pv_i": "pv_i", "load_v": "load_v", "bus": "bus"}
    for part in spec.split(","):
        key, _, field = part.partition("=")
        key, field = key.strip().lower(), field.strip()
        if key and field:
            mapping[alias.get(key, key)] = field
    return mapping or dict(DEFAULT_FIELDS)


def _num(v):
    try:
        if v in (None, ""):
            return None
        return float(v)
    except (TypeError, ValueError):
        return None


def feed_to_sample(feed: dict, mapping: dict) -> dict | None:
    """Convert a ThingSpeak entry into the dashboard's sample format."""
    g = lambda k: _num(feed.get(mapping.get(k, ""))) if mapping.get(k) else None
    pv = {"v": g("pv_v"), "i": g("pv_i"), "p": g("pv_p")}
    load = {"v": g("load_v"), "i": g("load_i"), "p": g("load_p")}
    bus = g("bus")
    mode = feed.get(mapping.get("mode", "")) if mapping.get("mode") else None
    if pv["v"] is None and pv["p"] is None and load["p"] is None and load["v"] is None and bus is None:
        return None
    return {
        "pv": pv,
        "load": load,
        "bus": bus if bus is not None else load["v"],
        "mode": (str(mode).strip().upper() if mode else None),
        "src": "thingspeak",
    }


def show(sample: dict) -> None:
    pv, load = sample["pv"], sample["load"]

    def f(v, d=3):
        return "  --  " if v is None else f"{v:.{d}f}"

    print(f"    PV   {f(pv['v'], 2)} V  {f(pv['i'])} A  {f(pv['p'], 2)} W")
    print(f"    LOAD {f(load['v'], 3)} V  {f(load['i'])} A  {f(load['p'], 2)} W")
    print(f"    BUS  {f(sample['bus'])} V     MODE {sample['mode'] or '--'}")
    bus = sample["bus"]
    if bus is not None:
        if bus < 12.40:
            print("    → dashboard would flag: BELOW 12.40 V LVD protection level")
        elif bus < 12.45:
            print("    → dashboard would flag: below the 12.45 V restore gate")
        else:
            print("    → dashboard sees a healthy bus (> 12.45 V)")


def offline_selftest() -> int:
    print("\noffline self-test of the field mapping\n")
    sample = feed_to_sample(SAMPLE_FEED, DEFAULT_FIELDS)
    ok = True

    def expect(name, cond, got=""):
        nonlocal ok
        print(f"  {'✓' if cond else '✗'} {name}{'' if cond else '  ' + str(got)}")
        ok = ok and cond

    expect("maps PV voltage from field1", sample and sample["pv"]["v"] == 18.42, sample)
    expect("maps PV power from field3", sample and sample["pv"]["p"] == 7.552, sample)
    expect("maps load power from field6", sample and sample["load"]["p"] == 1.759, sample)
    expect("maps bus voltage from field7", sample and sample["bus"] == 12.384, sample)
    expect("maps mode text from field8", sample and sample["mode"] == "AUTO_SAVE", sample)
    expect("falls back to load voltage when field7 is empty",
           feed_to_sample({**SAMPLE_FEED, "field7": None}, DEFAULT_FIELDS)["bus"] == 12.384)
    expect("returns None for an empty entry", feed_to_sample(SAMPLE_EMPTY, DEFAULT_FIELDS) is None)

    custom = parse_fields("pv_v=field2,pv_p=field3,load_p=field6")
    expect("supports a custom --fields mapping", custom["pv_v"] == "field2" and custom["pv_p"] == "field3")

    print(f"\n{'mapping logic OK' if ok else 'MAPPING BROKEN'}\n")
    return 0 if ok else 1


def main() -> int:
    ap = argparse.ArgumentParser(description="Verify a ThingSpeak channel and its API keys")
    ap.add_argument("--channel", help="channel ID, e.g. 3551777")
    ap.add_argument("--read-key", default="", help="channel read API key (needed for private channels)")
    ap.add_argument("--write-key", default="", help="channel write API key")
    ap.add_argument("--test-write", action="store_true", help="POST a visible test entry to prove the write key")
    ap.add_argument("--fields", help="custom mapping, e.g. pv_v=field2,pv_p=field3,load_p=field6")
    ap.add_argument("--offline-selftest", action="store_true", help="check the mapping logic, no network")
    args = ap.parse_args()

    if args.offline_selftest:
        return offline_selftest()
    if not args.channel:
        ap.error("--channel is required (or use --offline-selftest)")

    mapping = parse_fields(args.fields)
    base = f"https://api.thingspeak.com/channels/{urllib.parse.quote(str(args.channel))}"

    print(f"\nchecking ThingSpeak channel {args.channel}\n")

    # 1) channel metadata
    try:
        info = get_json(f"{base}.json")
        print(f"  ✓ channel found: {info.get('name', '(no name)')}")
        print(f"    visibility : {info.get('public', False) and 'public' or 'private'}")
        print(f"    entries    : {info.get('last_entry_id') or 0}")
        print(f"    fields     : {', '.join(f['name'] for f in info.get('field', []) if f.get('name')) or '(none named)'}")
        if not info.get("last_entry_id"):
            print("\n  ⚠ the channel has NO ENTRIES yet, so there is nothing to display.")
            print("    ThingSpeak only has data once something POSTs to it — the ESP32 has to")
            print("    run WiFi + HTTP code for that. Until then use the serial bridge:")
            print("      py bridge/serial_bridge.py --port COM3")
            print("    Or prove the write path right now:")
            print(f"      py tools/thingspeak_check.py --channel {args.channel} --write-key YOUR_WRITE_KEY --test-write")
            return 1
    except urllib.error.HTTPError as e:
        print(f"  ✗ channel lookup failed: HTTP {e.code} ({e.reason})")
        return 1
    except (urllib.error.URLError, TimeoutError) as e:
        print(f"  ✗ cannot reach api.thingspeak.com: {e}")
        print("    check your internet connection / firewall")
        return 1

    # 2) latest entry with the read key
    url = f"{base}/feeds/last.json"
    if args.read_key:
        url += "?" + urllib.parse.urlencode({"api_key": args.read_key})
    try:
        feed = get_json(url)
    except urllib.error.HTTPError as e:
        if e.code == 401:
            print("  ✗ read key rejected (401). Use the channel's Read API Key for private channels.")
        else:
            print(f"  ✗ could not read the feed: HTTP {e.code}")
        return 1

    sample = feed_to_sample(feed, mapping)
    if sample is None:
        print("  ⚠ the latest entry has no values in the mapped fields.")
        print(f"    current mapping: {json.dumps(mapping)}")
        print("    pass --fields if your channel uses a different layout")
        return 1

    print(f"\n  latest entry #{feed.get('entry_id')} at {feed.get('created_at')}")
    print("  as the dashboard would read it:")
    show(sample)

    # 3) optional write test
    if args.test_write:
        if not args.write_key:
            print("\n  ✗ --test-write needs --write-key")
            return 1
        payload = urllib.parse.urlencode({
            "api_key": args.write_key,
            "field8": "CONNECTIVITY_TEST",
            "status": "dashboard connectivity test",
        }).encode()
        print("\n  writing a test entry (uses one 15-second update slot)…")
        try:
            req = urllib.request.Request("https://api.thingspeak.com/update", data=payload, method="POST")
            with urllib.request.urlopen(req, timeout=12) as res:
                entry = res.read(32).decode().strip()
            if entry and entry != "0":
                print(f"  ✓ write key works — created entry #{entry}")
                print("    (delete it in Data Import / Export if you don't want it in the channel)")
            else:
                print("  ✗ write rejected (0). The key is wrong, or you are inside the 15 s rate limit.")
                return 1
        except (urllib.error.URLError, TimeoutError) as e:
            print(f"  ✗ write failed: {e}")
            return 1

    print("\n  to feed the dashboard straight from ThingSpeak:\n")
    print(f"    THINGSPEAK_CHANNEL={args.channel} THINGSPEAK_READ_KEY={args.read_key or 'YOUR_READ_KEY'} \\")
    print("      node dashboard/server.js\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
