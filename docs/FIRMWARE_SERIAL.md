# Serial format & firmware snippet

The dashboard never talks to the INA219s directly — it reads whatever the ESP32
prints. This page covers the recommended output, exactly what the parser
understands, and how to calibrate it for your existing firmware.

---

## 1. Recommended: one JSON line every 2 s

This is the most robust option and costs a handful of microseconds. It adds
**only** `Serial.print` calls — nothing here changes the relay policy, the LVD
protection or the PWM controller behaviour.

```cpp
// ── add near the top of loop() in SOLAR_PROJECT_CODE_v10 ──
static uint32_t lastTelemetryMs = 0;
if (millis() - lastTelemetryMs >= 2000) {
  lastTelemetryMs = millis();

  Serial.printf(
    "{\"pv\":{\"v\":%.2f,\"i\":%.3f,\"p\":%.2f},"
    "\"load\":{\"v\":%.3f,\"i\":%.3f,\"p\":%.2f},"
    "\"bus\":%.3f,\"mode\":\"%s\",\"relay\":%s}\n",
    pvBusVoltage_V, pvCurrent_mA / 1000.0, pvPower_mW / 1000.0,
    loadBusVoltage_V, loadCurrent_mA / 1000.0, loadPower_mW / 1000.0,
    loadBusVoltage_V,
    currentStateName,                       // "AUTO_NORMAL" / "AUTO_SAVE" / "NORMAL" / "SAVE"
    relayOn ? "true" : "false"
  );
}
```

Replace the variable names with the ones already used in your v10 sketch — the
INA219 library typically gives `busVoltage_V`, `current_mA` and `power_mW` per
sensor. Keep `bus` equal to the **Load INA bus voltage**, because that is the
battery-voltage proxy the 12.40 V / 12.45 V decisions are based on.

If you would rather keep the human-readable line you already have, that works too
— see the formats below.

---

## 2. Formats the parser accepts

All of these parse to the same sample:

```
PV: 18.42 V, 0.41 A, 7.55 W | LOAD: 12.38 V, 0.27 A, 3.27 W | AUTO_SAVE | relay OFF
PV 18.42V 0.41A 7.55W  LOAD 12.38V 0.27A 3.27W  BAT 12.38V  MODE=AUTO_SAVE RLY=OFF
PV=18.42V PV_A=0.41 LOAD=12.38V LOAD_A=0.27 LOAD_W=3.27 BUS=12.38 MODE=SAVE RELAY=0
pv_v=18.42 pv_a=0.41 pv_w=7.55 load_v=12.38 load_a=0.27 load_w=3.27
18.42,0.41,7.55,12.38,0.27,3.27,12.38,AUTO_SAVE,OFF
{"pv":{"v":18.42,"i":0.41,"p":7.55},"load":{"v":12.38,"i":0.27,"p":3.27},"bus":12.38}
```

Rules of thumb:

- **Labels** `PV | PANEL | SOLAR`, `LOAD | OUTPUT | LAMP | LED`, `BAT | BATTERY | BUS`
  start a new group; values with units (`V`, `A`, `W`) inside the group are assigned
  by their unit, so `PV 18.42V 0.41A 7.55W` is unambiguous.
- **Units matter** for labelled lines. A bare number with no unit is only used in
  the CSV/positional fallback (first six numbers = PV V,I,W then Load V,I,W).
- **Mode** is matched anywhere in the line: `AUTO_NORMAL`, `AUTO_SAVE`, `NORMAL`,
  `SAVE`, `AUTO`, `MANUAL` (case-insensitive, `AUTOSAVE` accepted).
- **Relay** is matched as `RELAY|RLY|SW` followed by `ON|OFF|1|0|TRUE|FALSE`, or a
  trailing `ON`/`OFF`.
- Anything that yields no measurements is ignored (boot banners are harmless).

Full test corpus: [`sample_serial_lines.txt`](sample_serial_lines.txt).

---

## 3. Calibrating against your real output

```bash
py bridge/serial_bridge.py --port COM3 --sniff
```

Each line is echoed with its parse result:

```
  raw  │ PV: 18.42 V, 0.41 A, 7.55 W | LOAD: 12.38 V, 0.27 A, 3.27 W | AUTO_SAVE | relay OFF
  ok   │ PV {'v': 18.42, 'i': 0.41, 'p': 7.55}  LOAD {'v': 12.38, 'i': 0.27, 'p': 3.27}  mode=AUTO_SAVE relay=False
  raw  │ gandalf boot ok
  !    │ unparsed — copy this line into the README and adjust the parser
```

`--sniff` never posts anything, so it is safe to run while the firmware is live.
Replay a captured log (or the bundled sample) without hardware:

```bash
py bridge/serial_bridge.py --stdin --file docs/sample_serial_lines.txt --sniff
py bridge/serial_bridge.py --stdin --file logs/normal_run_01.csv --rate 2
```

---

## 4. Things that would break the parse

| Symptom | Cause | Fix |
|---|---|---|
| Only PV appears on charts | Load group has no unit letters | print `LOAD 12.38V 0.27A 3.27W` or JSON |
| Bus voltage flat / missing | no `bus`/`BAT` field printed | include `bus` in the JSON frame |
| Load bus reported as 0.00 V | INA219 not initialised yet | bridge ignores it; wait for the first valid reading |
| Mode shows `—` | state not printed | include `"mode"` (text) in the frame |
| Relay chip shows `?` | no relay field | include `"relay":true/false` |
| Values look 1000× too big | mA/mW printed without converting | divide by 1000 in the firmware, or print `mA`/`mW` (parser treats them as A/W only when the unit letter says so — so prefer A/W) |

---

## 5. Don't change the control logic

This dashboard is a **monitor**. Keep the v10 firmware behaviour intact:
`AUTO` boot state with the secondary load OFF, LVD as the emergency protection,
relay only for the secondary LED, primary LED always connected.
