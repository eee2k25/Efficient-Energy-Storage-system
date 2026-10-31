/* ────────────────────────────────────────────────────────────────────────────
   telemetry_cloud_addon.ino — ESP32 → cloud dashboard, WITHOUT a laptop
   ────────────────────────────────────────────────────────────────────────────

   Use this INSTEAD of firmware/telemetry_addon.ino (it is a superset: the JSON
   serial print is still here, so the USB bridge keeps working too).

   What it does
   ────────────
   • Every 2 s it prints ONE json line to Serial  → Arduino Serial Monitor and
     bridge/serial_bridge.py keep working exactly as before (USB mode).
   • When cloud mode is ON it also POSTs the same reading to your Render
     dashboard from a **background FreeRTOS task on core 0**, so your control
     loop never waits for WiFi or TLS. LVD protection, PWM, relays: untouched.
   • Cloud mode is a RUNTIME switch — type in the Arduino Serial Monitor:

         CLOUD ON        → start posting to the dashboard (saved in NVS, survives reboot)
         CLOUD OFF       → stop posting (use this before a USB bridge session)
         CLOUD STATUS    → print the current state

     So: one sketch, two modes, picked whenever you want, no re-upload.
     Default at first boot is OFF (set CLOUD_DEFAULT_ON to 1 to flip it).

   Wiring into SOLAR_PROJECT_CODE_v10
   ──────────────────────────────────
   1. Copy the whole block between BEGIN COPY / END COPY above setup().
   2. In setup(), after Serial.begin(115200), add:
          telemetryCloudSetup();
   3. At the very END of loop(), add (use YOUR variable names):
          telemetryCloudLoop(pvBusVoltage_V, pvCurrent_mA / 1000.0, pvPower_mW / 1000.0,
                             loadBusVoltage_V, loadCurrent_mA / 1000.0, loadPower_mW / 1000.0,
                             loadBusVoltage_V, currentStateName, relayOn);
   4. Fill in CLOUD_WIFI_SSID / CLOUD_WIFI_PASS / CLOUD_URL / CLOUD_INGEST_KEY.
   5. (optional) remote buttons: see ENABLE_REMOTE_COMMANDS at the bottom.

   ⚠ Two things to know
   ────────────────────
   • This sketch reads Serial to see CLOUD commands typed in the Serial Monitor.
     If your v10 sketch already reads Serial for its own menu, set
     ENABLE_SERIAL_CONTROL to 0 (or make sure your parser ignores "CLOUD ...").
     The USB bridge sends nothing unless you run it with --allow-control.
   • While CLOUD is ON the ESP32 keeps the dashboard awake. On Render's free
     plan that burns instance-hours — turn it OFF overnight. See docs/DEPLOY_FREE.md.
   ──────────────────────────────────────────────────────────────────────────── */

#if defined(ESP32)

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Preferences.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "freertos/queue.h"

// ═══════════════════════ BEGIN COPY ═══════════════════════

/* ── 1. what to talk to ─────────────────────────────────────────────────── */

// Your Render URL + the ingest path. HTTP and HTTPS both work; HTTPS recommended.
#define CLOUD_URL "https://ees-solar-dashboard.onrender.com/api/ingest"

// Render → your service → Environment → INGEST_KEY → copy the value here.
// Leave as "" only if you did not set INGEST_KEY on the server.
#define CLOUD_INGEST_KEY "PASTE_INGEST_KEY_HERE"

/* ── 2. WiFi ────────────────────────────────────────────────────────────── */

#define CLOUD_WIFI_SSID "YOUR_WIFI_NAME"
#define CLOUD_WIFI_PASS "YOUR_WIFI_PASSWORD"

/* ── 3. behaviour ───────────────────────────────────────────────────────── */

#define TELEMETRY_INTERVAL_MS 2000UL   // serial print period (Serial Monitor + bridge)
#define CLOUD_INTERVAL_MS     5000UL   // min gap between uploads (2 s .. 60 s is sane)
#define CLOUD_TIMEOUT_MS      6000     // per HTTP request
#define CLOUD_RETRY_MS        10000UL  // first back-off after a failed upload
#define CLOUD_DEFAULT_ON      0        // 0 = boot in USB/bridge mode, 1 = boot posting
#define ENABLE_SERIAL_CONTROL 1        // 1 = parse "CLOUD ON/OFF/STATUS" from Serial
#define ENABLE_REMOTE_COMMANDS 1       // 1 = poll the dashboard's AUTO/NORMAL/SAVE queue
#define CLOUD_REMOTE_POLL_MS  10000UL  // how often to poll for commands
#define CLOUD_VERBOSE         1        // 1 = print "# telemetry:" status lines

/* ------------------------------------------------------------------ types */

struct CloudSample {
  float pvV, pvI, pvP;
  float loadV, loadI, loadP;
  float busV;
  bool  relay;
  char  mode[16];
};

static QueueHandle_t  cloudQueue      = nullptr;
static Preferences    cloudPrefs;
static volatile bool  cloudEnabled    = (CLOUD_DEFAULT_ON != 0);
static bool           cloudReady      = false;
static bool           cloudRadioUp    = false;
static unsigned long  lastSerialMs    = 0;
static char           cloudHost[96]   = {0};
static char           cloudPath[64]   = "/api/ingest";
static uint16_t       cloudPort       = 443;
static bool           cloudUseTls     = true;

static void (*cloudRemoteHandler)(const char*) = nullptr;

/* ------------------------------------------------------------------ utils */

#if CLOUD_VERBOSE
  #define CLOUD_LOG(x)        do { Serial.print(F("# telemetry: ")); Serial.println(F(x)); } while (0)
  #define CLOUD_LOGF(fmt, ...) do { Serial.print(F("# telemetry: ")); Serial.printf(fmt, ##__VA_ARGS__); Serial.println(); } while (0)
#else
  #define CLOUD_LOG(x)        do {} while (0)
  #define CLOUD_LOGF(fmt, ...) do {} while (0)
#endif

/** Split "https://host[:port]/path" into its pieces. Returns false if unusable. */
static bool cloudParseUrl(const char* url) {
  const char* p = url;
  if (strncmp(p, "https://", 8) == 0)      { cloudUseTls = true;  cloudPort = 443; p += 8; }
  else if (strncmp(p, "http://", 7) == 0)  { cloudUseTls = false; cloudPort = 80;  p += 7; }
  else return false;

  const char* slash = strchr(p, '/');
  size_t hostLen = slash ? (size_t)(slash - p) : strlen(p);
  const char* colon = (const char*)memchr(p, ':', hostLen);
  if (colon) {
    hostLen = (size_t)(colon - p);
    cloudPort = (uint16_t)atoi(colon + 1);
  }
  if (hostLen == 0 || hostLen >= sizeof(cloudHost)) return false;
  memcpy(cloudHost, p, hostLen);
  cloudHost[hostLen] = '\0';

  const char* path = slash ? slash : "/";
  if (strlen(path) >= sizeof(cloudPath)) return false;
  strcpy(cloudPath, path);
  return true;
}

static bool cloudPlaceholder(const char* s) {
  return strstr(s, "YOUR_") != nullptr || strstr(s, "PASTE_") != nullptr;
}

static bool cloudKeyConfigured() {
  return CLOUD_INGEST_KEY[0] != '\0' && !cloudPlaceholder(CLOUD_INGEST_KEY);
}

/* ------------------------------------------------------------------ radio */

static bool cloudEnsureWifi() {
  if (!cloudRadioUp) {
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.persistent(false);
    WiFi.begin(CLOUD_WIFI_SSID, CLOUD_WIFI_PASS);
    cloudRadioUp = true;
    CLOUD_LOGF("wifi: joining \"%s\"", CLOUD_WIFI_SSID);
    return false;
  }
  if (WiFi.status() == WL_CONNECTED) return true;

  static unsigned long lastKick = 0;
  if (millis() - lastKick > 20000UL) {           // never leave the station dead
    lastKick = millis();
    WiFi.disconnect();
    WiFi.begin(CLOUD_WIFI_SSID, CLOUD_WIFI_PASS);
    CLOUD_LOGF("wifi: retry (status %d)", (int)WiFi.status());
  }
  return false;
}

static void cloudRadioOff() {
  if (!cloudRadioUp) return;
  WiFi.disconnect(true);
  WiFi.mode(WIFI_OFF);
  cloudRadioUp = false;
  CLOUD_LOG("wifi: radio off");
}

/* ------------------------------------------------------------------- send */

static bool cloudPost(const CloudSample& s) {
  WiFiClientSecure tlsClient;
  WiFiClient       plainClient;
  HTTPClient       http;

  if (cloudUseTls) tlsClient.setInsecure();   // encrypted, certificate not pinned
  http.setTimeout(CLOUD_TIMEOUT_MS);
  http.setReuse(false);

  const bool began = cloudUseTls
    ? http.begin(tlsClient, cloudHost, cloudPort, cloudPath, true)
    : http.begin(plainClient, cloudHost, cloudPort, cloudPath, false);
  if (!began) { CLOUD_LOG("http.begin failed"); return false; }

  http.addHeader("content-type", "application/json");
  if (cloudKeyConfigured()) http.addHeader("x-api-key", CLOUD_INGEST_KEY);

  char body[208];
  snprintf(body, sizeof(body),
    "{\"src\":\"esp32wifi\","
    "\"pv\":{\"v\":%.2f,\"i\":%.3f,\"p\":%.2f},"
    "\"load\":{\"v\":%.3f,\"i\":%.3f,\"p\":%.2f},"
    "\"bus\":%.3f,\"mode\":\"%s\",\"relay\":%s}",
    s.pvV, s.pvI, s.pvP,
    s.loadV, s.loadI, s.loadP,
    s.busV, s.mode, s.relay ? "true" : "false");

  const int code = http.POST((uint8_t*)body, strlen(body));
  http.end();

  if (code == 200 || code == 201) return true;
  CLOUD_LOGF("upload failed (%d)", code);
  return false;
}

/* --------------------------------------------------------- remote commands */

#if ENABLE_REMOTE_COMMANDS
static uint32_t cloudLastCmdId = 0;

static void cloudPollCommands() {
  WiFiClientSecure tlsClient;
  WiFiClient       plainClient;
  HTTPClient       http;

  if (cloudUseTls) tlsClient.setInsecure();
  http.setTimeout(CLOUD_TIMEOUT_MS);
  http.setReuse(false);

  char uri[80];
  snprintf(uri, sizeof(uri), "/api/commands?since=%lu&ack=1", (unsigned long)cloudLastCmdId);

  const bool began = cloudUseTls
    ? http.begin(tlsClient, cloudHost, cloudPort, uri, true)
    : http.begin(plainClient, cloudHost, cloudPort, uri, false);
  if (!began) return;

  if (cloudKeyConfigured()) http.addHeader("x-api-key", CLOUD_INGEST_KEY);
  const int code = http.GET();
  if (code != 200) { http.end(); return; }

  String payload = http.getString();
  http.end();

  int from = 0;
  for (;;) {
    const int cmdPos = payload.indexOf("\"cmd\":\"", from);
    if (cmdPos < 0) break;
    const int valStart = cmdPos + 7;
    const int valEnd   = payload.indexOf('"', valStart);
    if (valEnd < 0) break;

    const int idPos = payload.lastIndexOf("\"id\":", cmdPos);
    if (idPos >= 0) {
      const uint32_t id = (uint32_t)payload.substring(idPos + 5, cmdPos).toInt();
      if (id > cloudLastCmdId) cloudLastCmdId = id;
    }

    const String cmd = payload.substring(valStart, valEnd);
    CLOUD_LOGF("remote command: %s", cmd.c_str());
    if (cloudRemoteHandler) cloudRemoteHandler(cmd.c_str());
    else CLOUD_LOG("no handler set — see telemetrySetRemoteCommandHandler()");

    from = valEnd + 1;
  }
}
#endif /* ENABLE_REMOTE_COMMANDS */

/* ------------------------------------------------------------------- task */

static void cloudTask(void* arg) {
  (void)arg;
  CloudSample latest = {};
  bool have = false;
  uint32_t nextSend = 0;
  uint32_t nextPoll = 0;
  uint32_t retryDelay = 0;

  for (;;) {
    CloudSample incoming;
    if (xQueueReceive(cloudQueue, &incoming, pdMS_TO_TICKS(200)) == pdTRUE) {
      latest = incoming;
      have = true;
    }

    if (!cloudEnabled) {
      if (have) have = false;
      cloudRadioOff();
      retryDelay = 0;
      vTaskDelay(pdMS_TO_TICKS(200));
      continue;
    }

    if (!cloudEnsureWifi()) { vTaskDelay(pdMS_TO_TICKS(200)); continue; }

    const uint32_t now = millis();

    if (have && (int32_t)(now - nextSend) >= 0) {
      if (cloudPost(latest)) {
        have = false;
        retryDelay = 0;
        nextSend = now + CLOUD_INTERVAL_MS;
      } else {
        retryDelay = retryDelay ? (retryDelay * 2 > 60000UL ? 60000UL : retryDelay * 2) : CLOUD_RETRY_MS;
        nextSend = now + retryDelay;
      }
    }

  #if ENABLE_REMOTE_COMMANDS
    if ((int32_t)(now - nextPoll) >= 0) {
      nextPoll = now + CLOUD_REMOTE_POLL_MS;
      cloudPollCommands();
    }
  #endif
  }
}

/* --------------------------------------------------------- public switches */

void telemetryCloudSet(bool on) {
  cloudEnabled = on;
  if (cloudReady) cloudPrefs.putBool("cloud", on);
  if (on) cloudRadioOff();   // forces a fresh join on the next tick
  CLOUD_LOGF("cloud mode %s (saved)", on ? "ON" : "OFF");
}

bool telemetryCloudOn() { return cloudEnabled; }

/** Optional: receive AUTO / NORMAL / SAVE pressed on the dashboard. */
void telemetrySetRemoteCommandHandler(void (*fn)(const char*)) {
  cloudRemoteHandler = fn;
}

#if ENABLE_SERIAL_CONTROL
static char    cloudCmdBuf[40];
static uint8_t cloudCmdLen = 0;

static void cloudHandleLine(char* line) {
  for (char* p = line; *p; ++p) *p = (char)toupper(*p);   // CLOUD on == CLOUD ON
  if (strncmp(line, "CLOUD", 5) != 0) return;             // ignore everything else
  const char* arg = line + 5;
  while (*arg == ' ') arg++;

  if      (strncmp(arg, "ON", 2) == 0)     telemetryCloudSet(true);
  else if (strncmp(arg, "OFF", 3) == 0)    telemetryCloudSet(false);
  else if (strncmp(arg, "STATUS", 6) == 0) CLOUD_LOGF("cloud is %s, wifi %s, url %s",
                                          cloudEnabled ? "ON" : "OFF",
                                          WiFi.status() == WL_CONNECTED ? "up" : "down",
                                          CLOUD_URL);
  else CLOUD_LOG("usage: CLOUD ON | CLOUD OFF | CLOUD STATUS");
}

static void cloudPollSerial() {
  while (Serial.available() > 0) {
    const int c = Serial.read();
    if (c == '\n' || c == '\r') {
      if (cloudCmdLen > 0) {
        cloudCmdBuf[cloudCmdLen] = '\0';
        cloudHandleLine(cloudCmdBuf);
        cloudCmdLen = 0;
      }
    } else if (cloudCmdLen < sizeof(cloudCmdBuf) - 1) {
      cloudCmdBuf[cloudCmdLen++] = (char)c;
    }
  }
}
#endif /* ENABLE_SERIAL_CONTROL */

/* ------------------------------------------------------------------ setup */

void telemetryCloudSetup() {
  if (cloudReady) return;

  if (!cloudParseUrl(CLOUD_URL)) {
    CLOUD_LOG("CLOUD_URL must start with https:// or http:// — cloud disabled");
    cloudEnabled = false;
    return;
  }
  if (cloudPlaceholder(CLOUD_WIFI_SSID) || cloudPlaceholder(CLOUD_WIFI_PASS)) {
    CLOUD_LOG("WiFi credentials are still placeholders — cloud disabled (USB mode only)");
    cloudEnabled = false;
    return;
  }

  cloudPrefs.begin("telemetry", false);
  cloudEnabled = cloudPrefs.getBool("cloud", CLOUD_DEFAULT_ON != 0);
  cloudReady = true;

  cloudQueue = xQueueCreate(1, sizeof(CloudSample));
  if (!cloudQueue) { CLOUD_LOG("queue alloc failed — cloud disabled"); cloudEnabled = false; return; }

  // core 0 = WiFi stack's core; the Arduino loop() runs on core 1, so TLS
  // handshakes can never delay a PWM update or the 12.40 V LVD reaction.
  xTaskCreatePinnedToCore(cloudTask, "cloud_telemetry", 12288, nullptr, 1, nullptr, 0);

  CLOUD_LOGF("serial JSON every %lu ms; cloud %s every %lu ms",
             (unsigned long)TELEMETRY_INTERVAL_MS,
             cloudEnabled ? "ON" : "OFF (type CLOUD ON)",
             (unsigned long)CLOUD_INTERVAL_MS);
  CLOUD_LOGF("target %s://%s%s", cloudUseTls ? "https" : "http", cloudHost, cloudPath);
  if (cloudKeyConfigured()) CLOUD_LOG("ingest key: set");
  else CLOUD_LOG("ingest key: empty — only OK if the server has no INGEST_KEY");
}

/* ------------------------------------------------------------------- loop */

void telemetryCloudLoop(float pvV, float pvI, float pvP,
                        float loadV, float loadI, float loadP,
                        float busV, const char* modeName, bool relayOn) {
  const unsigned long now = millis();

  // ── USB / Serial Monitor path: cheap, non-blocking, always on ────────────
  if (now - lastSerialMs >= TELEMETRY_INTERVAL_MS) {
    lastSerialMs = now;
    Serial.printf(
      "{\"pv\":{\"v\":%.2f,\"i\":%.3f,\"p\":%.2f},"
      "\"load\":{\"v\":%.3f,\"i\":%.3f,\"p\":%.2f},"
      "\"bus\":%.3f,\"mode\":\"%s\",\"relay\":%s}\n",
      pvV, pvI, pvP,
      loadV, loadI, loadP,
      busV, modeName ? modeName : "UNKNOWN",
      relayOn ? "true" : "false");
  }

#if ENABLE_SERIAL_CONTROL
  cloudPollSerial();
#endif

  // ── cloud path: hand the newest reading to the background task ──────────
  if (cloudEnabled && cloudQueue) {
    CloudSample s;
    s.pvV = pvV; s.pvI = pvI; s.pvP = pvP;
    s.loadV = loadV; s.loadI = loadI; s.loadP = loadP;
    s.busV = busV; s.relay = relayOn;
    strncpy(s.mode, modeName ? modeName : "UNKNOWN", sizeof(s.mode) - 1);
    s.mode[sizeof(s.mode) - 1] = '\0';
    xQueueOverwrite(cloudQueue, &s);   // depth 1 → the newest sample always wins
  }
}

// ═══════════════════════ END COPY ═══════════════════════

#endif /* ESP32 */
