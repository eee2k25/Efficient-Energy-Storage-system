'use strict';
/**
 * ThingSpeak reader.
 *
 * If THINGSPEAK_CHANNEL is set, the server polls the channel's last entry and
 * feeds it into the same store as the serial bridge, so the dashboard works
 * whether your ESP32 is posting to ThingSpeak or to this server directly.
 *
 * Field mapping (default matches the recommended firmware snippet):
 *   field1 = PV voltage   field2 = PV current   field3 = PV power
 *   field4 = Load voltage field5 = Load current field6 = Load power
 *   field7 = Battery/bus voltage (optional)
 *   field8 = mode text       (optional, e.g. AUTO_SAVE)
 *
 * Override with THINGSPEAK_FIELDS="pvV:field1=field1,pvI:field2=..." only if you
 * need a different layout: THINGSPEAK_FIELDS=pvV:field2,pvI:field3,pvP:field4,loadV:field5,loadI:field6,loadP:field7
 */

const DEFAULT_MAP = {
  pvV: 'field1', pvI: 'field2', pvP: 'field3',
  loadV: 'field4', loadI: 'field5', loadP: 'field6',
  bus: 'field7',
};

function parseFieldMap(spec) {
  if (!spec) return { ...DEFAULT_MAP, mode: 'field8' };
  const map = {};
  for (const part of spec.split(',')) {
    const [key, field] = part.split(':').map((x) => x && x.trim());
    if (key && field) map[key] = field;
  }
  return map;
}

function feedToSample(feed, map) {
  const g = (k) => {
    if (!map[k]) return null;
    const v = Number(feed[map[k]]);
    return Number.isFinite(v) ? v : null;
  };
  const modeRaw = map.mode ? feed[map.mode] : null;
  const mode = modeRaw ? String(modeRaw).trim().toUpperCase() : null;
  const busV = g('bus');
  return {
    t: feed.created_at ? Date.parse(feed.created_at) : Date.now(),
    pv: { v: g('pvV'), i: g('pvI'), p: g('pvP') },
    load: { v: g('loadV'), i: g('loadI'), p: g('loadP') },
    bus: busV ?? g('loadV'),
    mode,
    src: 'thingspeak',
  };
}

function startThingSpeak({ store, channel, readKey, intervalMs = 15000, fieldSpec }) {
  if (!channel) return null;
  const map = parseFieldMap(fieldSpec);
  let lastEntryId = null;
  let failures = 0;

  const poll = async () => {
    const url = new URL(`https://api.thingspeak.com/channels/${encodeURIComponent(channel)}/feeds/last.json`);
    if (readKey) url.searchParams.set('api_key', readKey);
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(12000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const feed = await res.json();
      if (!feed || feed.entry_id === undefined || feed.entry_id === null) {
        if (failures++ === 0) console.warn('[thingspeak] channel returned no entries yet');
        return;
      }
      if (String(feed.entry_id) === String(lastEntryId)) return; // unchanged
      lastEntryId = feed.entry_id;
      const s = feedToSample(feed, map);
      if (store.add(s, 'thingspeak')) {
        if (failures) console.log('[thingspeak] connection restored');
        failures = 0;
      }
    } catch (e) {
      if (failures++ === 0) console.warn('[thingspeak] poll failed:', e.message);
      else if (failures % 20 === 0) console.warn(`[thingspeak] still failing (${failures}): ${e.message}`);
    }
  };

  poll();
  const timer = setInterval(poll, Math.max(5000, intervalMs));
  timer.unref?.();
  console.log(`[thingspeak] polling channel ${channel} every ${Math.round(Math.max(5000, intervalMs) / 1000)}s`);
  return timer;
}

module.exports = { startThingSpeak, feedToSample, parseFieldMap, DEFAULT_MAP };
