/* ────────────────────────────────────────────────────────────────────────────
   telemetry_addon.ino — OPTIONAL telemetry for SOLAR_PROJECT_CODE_v10
   ────────────────────────────────────────────────────────────────────────────

   THIS DOES NOT TOUCH YOUR CONTROL LOGIC.
   It only *prints* (and optionally *posts*) the readings you already compute.
   Your AUTO / NORMAL / SAVE policy, the 12.40 V LVD protection and the relay
   handling stay exactly as they are in v10.

   ── Which variant do I need? ────────────────────────────────────────────────

   VARIANT A (recommended, default below):
       Serial only. The laptop runs bridge/serial_bridge.py which forwards the
       readings to the dashboard. No WiFi, no blocking, no risk to the loop.
       → keep ENABLE_WIFI_TELEMETRY at 0

   VARIANT B (only if the ESP32 must reach the cloud with no laptop):
       Adds WiFi + ThingSpeak. WARNING: ThingSpeak.writeFields() BLOCKS for
       roughly 0.2-2 s. In a control loop that can delay PWM updates and the
       LVD reaction. If you enable it:
         • post at most every 20 s (ThingSpeak's free limit is 15 s)
         • measure your loop time before and after
         • keep the LVD protection as the safety net, as it is today
       → set ENABLE_WIFI_TELEMETRY to 1 and fill in the four constants

   ── How to install (both variants) ──────────────────────────────────────────

   1. Copy the whole block between the "BEGIN COPY" and "END COPY" markers
      into SOLAR_PROJECT_CODE_v10.ino, above setup().
   2. In setup(), add:            telemetrySetup();
   3. In loop(), at the END, add:

          telemetryLoop(pvBusVoltage_V, pvCurrent_mA / 1000.0, pvPower_mW / 1000.0,
                        loadBusVoltage_V, loadCurrent_mA / 1000.0, loadPower_mW / 1000.0,
                        loadBusVoltage_V, currentStateName, relayOn);

      …using YOUR existing variable names — the ones above are illustrative.
      Note how current/power are divided by 1000 when the INA219 library
      reports current_mA / power_mW.

   4. Upload, close the Arduino Serial Monitor, then run:
          py bridge/serial_bridge.py --port COM3 --sniff
      You should see one JSON line every 2 s, parsed as "ok".
   ──────────────────────────────────────────────────────────────────────────── */

// ═══════════════════════ BEGIN COPY ═══════════════════════
// ── configuration ──────────────────────────────────────────────────────────
#define ENABLE_WIFI_TELEMETRY 0      // 1 = also POST to ThingSpeak (blocks!)
#define TELEMETRY_INTERVAL_MS 2000UL // serial print period (A)
#define THINGSPEAK_INTERVAL_MS 20000UL

#if ENABLE_WIFI_TELEMETRY
  #include <WiFi.h>
  #include <ThingSpeak.h>

  const char* WIFI_SSID     = "YOUR_WIFI_NAME";
  const char* WIFI_PASSWORD = "YOUR_WIFI_PASSWORD";
  const unsigned long TS_CHANNEL_ID = 3551777;
  const char* TS_WRITE_KEY  = "YOUR_WRITE_API_KEY";   // keep this out of GitHub
  WiFiClient tsClient;
#endif

static unsigned long lastTelemetryMs = 0;
static unsigned long lastThingSpeakMs = 0;

void telemetrySetup() {
  // Serial is normally started by your own setup(); beginSerial is safe to skip.
#if ENABLE_WIFI_TELEMETRY
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  Serial.print(F("# telemetry: connecting to WiFi"));
  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < 15000) {
    delay(400);
    Serial.print('.');
  }
  Serial.println();
  if (WiFi.status() == WL_CONNECTED) {
    Serial.print(F("# telemetry: WiFi OK, IP "));
    Serial.println(WiFi.localIP());
    ThingSpeak.begin(tsClient);
  } else {
    Serial.println(F("# telemetry: WiFi FAILED - continuing without cloud posting"));
  }
#else
  Serial.println(F("# telemetry: serial JSON enabled (bridge mode)"));
#endif
}

// One compact JSON line — this is what the bridge parses.
void telemetryPrint(float pvV, float pvI, float pvP,
                    float loadV, float loadI, float loadP,
                    float busV, const char* modeName, bool relayOn) {
  Serial.printf(
    "{\"pv\":{\"v\":%.2f,\"i\":%.3f,\"p\":%.2f},"
    "\"load\":{\"v\":%.3f,\"i\":%.3f,\"p\":%.2f},"
    "\"bus\":%.3f,\"mode\":\"%s\",\"relay\":%s}\n",
    pvV, pvI, pvP,
    loadV, loadI, loadP,
    busV, modeName ? modeName : "UNKNOWN",
    relayOn ? "true" : "false");
}

void telemetryLoop(float pvV, float pvI, float pvP,
                   float loadV, float loadI, float loadP,
                   float busV, const char* modeName, bool relayOn) {
  unsigned long now = millis();

  // ── serial (non-blocking, cheap) ─────────────────────────────────────────
  if (now - lastTelemetryMs >= TELEMETRY_INTERVAL_MS) {
    lastTelemetryMs = now;
    telemetryPrint(pvV, pvI, pvP, loadV, loadI, loadP, busV, modeName, relayOn);
  }

  // ── ThingSpeak (BLOCKING — see the warning at the top) ───────────────────
#if ENABLE_WIFI_TELEMETRY
  if (now - lastThingSpeakMs >= THINGSPEAK_INTERVAL_MS && WiFi.status() == WL_CONNECTED) {
    lastThingSpeakMs = now;
    ThingSpeak.setField(1, pvV);
    ThingSpeak.setField(2, pvI);
    ThingSpeak.setField(3, pvP);
    ThingSpeak.setField(4, loadV);
    ThingSpeak.setField(5, loadI);
    ThingSpeak.setField(6, loadP);
    ThingSpeak.setField(7, busV);
    ThingSpeak.setField(8, modeName ? modeName : "UNKNOWN");
    ThingSpeak.setStatus(relayOn ? "relay ON (both loads)" : "relay OFF (primary only)");
    int code = ThingSpeak.writeFields(TS_CHANNEL_ID, TS_WRITE_KEY);
    if (code != 200) Serial.printf("# telemetry: ThingSpeak write failed (%d)\n", code);
  }
#endif
}
// ═══════════════════════ END COPY ═══════════════════════
