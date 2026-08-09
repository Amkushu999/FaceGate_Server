/**
 * facedocs.bond — FaceGate License Server
 * Replaces: https://standing-panther-214.convex.site  & https://grateful-mule-939.convex.site
 * Serves both legacy (validate_key/verify_token) and new HMAC envelope (activate/verify/heartbeat)
 *
 * Deploy to VPS 82.25.90.196 — Node 18+
 *   npm install
 *   ADMIN_USER=admin ADMIN_PASS=87877878@Kk## PORT=3000 node server.js
 */

const express = require('express');
const cors = require('cors');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const { buildEnvelope } = require('./envelope');

const app = express();
const PORT = process.env.PORT || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || '87877878@Kk##';

app.use(cors());
app.use(express.json({ limit: '256kb' }));
app.use(express.urlencoded({ extended: true }));

// simple logger
app.use((req, _, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${req.ip}`);
  next();
});

// serve frontend
app.use(express.static(path.join(__dirname, 'public')));

// helpers
function remainingSeconds(expiresAt) {
  if (!expiresAt) return -1;
  const diff = new Date(expiresAt).getTime() - Date.now();
  return diff > 0 ? Math.floor(diff / 1000) : 0;
}
function isExpired(expiresAt) {
  if (!expiresAt) return false; // null = lifetime or trial per activation
  return new Date(expiresAt).getTime() <= Date.now();
}
function keyStatus(k) {
  if (k.status === 'revoked') return 'revoked';
  if (isExpired(k.expires_at)) return 'expired';
  return 'active';
}

// ─────────────────────────────────────────────
// HEALTH
// ─────────────────────────────────────────────
app.get('/api/health', (req, res) => {
  db.removeExpired();
  res.json({ ok: true, domain: 'facedocs.bond', vps: '82.25.90.196', time: new Date().toISOString(), stats: db.stats() });
});

app.get('/health', (req, res) => res.json({ ok: true, domain: 'facedocs.bond' }));

// ─────────────────────────────────────────────
// LEGACY API — used by LicenseGuard (activation.cpp)
//   POST /api/validate_key   {key, device_id, wifi_ip?, app_version?}
//   POST /api/verify_token   {token, device_id}
//   POST /api/check_trial    {device_id}
//   POST /api/activate_trial {key, device_id, wifi_ip?}
//   GET  /api/key_status/:key
// ─────────────────────────────────────────────

app.post('/api/validate_key', (req, res) => {
  db.removeExpired();
  const { key, device_id, deviceId, wifi_ip, wifiIp, app_version } = req.body || {};
  const device = device_id || deviceId;
  const wifi = wifi_ip || wifiIp;

  if (!key || !device) {
    return res.json({ success: false, message: "Missing key or device_id", token: null });
  }

  const rec = db.findKey(key);
  if (!rec) {
    return res.json({ success: false, message: "Invalid key", token: null });
  }
  if (keyStatus(rec) !== 'active') {
    return res.json({ success: false, message: `Key ${keyStatus(rec)}`, token: null });
  }

  // device limit check — allow re-activation for same device
  const existing = db.findActivation(device, key);
  const used = db.countActiveDevices(key);
  if (!existing && used >= rec.max_devices) {
    return res.json({ success: false, message: "Device limit reached", token: null, max_devices: rec.max_devices, remaining_devices: 0 });
  }

  // generate token (HMAC)
  const token = db.generateToken(device, rec.key, rec.id);
  const expiresAt = rec.is_trial
    ? new Date(Date.now() + 24*3600*1000).toISOString() // trial: 24h per device
    : rec.expires_at;

  db.upsertActivation({
    keyId: rec.id,
    keyText: rec.key,
    deviceId: device,
    androidId: "",
    wifiIp: wifi || "",
    bssid: "",
    buildFp: app_version || "",
    token,
    expiresAt
  });

  return res.json({
    success: true,
    message: rec.is_trial ? "Trial activated (24h)" : "Key activated",
    token,
    is_trial: !!rec.is_trial,
    is_paid: !!rec.is_paid,
    expires_at: expiresAt,
    remaining_devices: Math.max(0, rec.max_devices - db.countActiveDevices(key)),
    max_devices: rec.max_devices
  });
});

app.post('/api/verify_token', (req, res) => {
  db.removeExpired();
  const { token, device_id, deviceId } = req.body || {};
  const device = device_id || deviceId;
  if (!token || !device) return res.json({ valid: false, message: "Missing token or device_id" });

  const act = db.findActivationByToken(token);
  if (!act) return res.json({ valid: false, message: "Invalid token" });
  if (act.deviceId !== device) return res.json({ valid: false, message: "Device mismatch" });

  const rec = db.findKeyById(act.keyId) || db.findKey(act.keyText);
  if (!rec) return res.json({ valid: false, message: "Key not found" });
  if (keyStatus(rec) !== 'active') return res.json({ valid: false, message: `Key ${keyStatus(rec)}` });
  if (isExpired(act.expiresAt)) return res.json({ valid: false, message: "Activation expired", is_trial: !!rec.is_trial, is_paid: !!rec.is_paid });

  db.touchActivation(token);
  return res.json({
    valid: true,
    message: "Token valid",
    is_trial: !!rec.is_trial,
    is_paid: !!rec.is_paid,
    expires_at: act.expiresAt
  });
});

app.post('/api/check_trial', (req, res) => {
  const { device_id, deviceId } = req.body || {};
  const device = device_id || deviceId;
  // trial availability check — if NOWORNEVER key exists and device not already used beyond limit
  const rec = db.findKey("NOWORNEVER");
  if (!rec || keyStatus(rec) !== 'active') {
    return res.json({ available: false, message: "Trial not available" });
  }
  const used = db.countActiveDevices("NOWORNEVER");
  // if device already has trial, report available false
  if (device && db.findActivation(device, "NOWORNEVER")) {
    const act = db.findActivation(device, "NOWORNEVER");
    return res.json({ available: false, message: "Trial already used", expires_at: act.expiresAt });
  }
  if (used >= rec.max_devices && rec.max_devices !== 0) {
    // for trial key max_devices usually 999 but we check
  }
  return res.json({ available: true, message: "Trial available", expires_at: null });
});

app.post('/api/activate_trial', (req, res) => {
  // alias to validate_key with trial key
  req.body.key = req.body.key || "NOWORNEVER";
  // forward to same logic - reuse handler by direct call
  // simple: just call validate_key logic
  const { device_id, deviceId, wifi_ip, wifiIp } = req.body || {};
  const device = device_id || deviceId;
  if (!device) return res.json({ success: false, message: "Missing device_id", token: null });
  // force trial key
  const rec = db.findKey("NOWORNEVER");
  if (!rec) return res.json({ success: false, message: "Trial disabled", token: null });
  if (keyStatus(rec) !== 'active') return res.json({ success: false, message: "Trial unavailable", token: null });
  const existing = db.findActivation(device, rec.key);
  if (existing) return res.json({ success: false, message: "Trial already used for this device", token: null });

  const token = db.generateToken(device, rec.key, rec.id);
  const expiresAt = new Date(Date.now() + 24*3600*1000).toISOString();
  db.upsertActivation({
    keyId: rec.id, keyText: rec.key, deviceId: device, androidId: "", wifiIp: wifi_ip || wifiIp || "", bssid: "", buildFp: "", token, expiresAt
  });
  return res.json({
    success: true, message: "Trial activated (24h)", token, is_trial: true, is_paid: false, expires_at: expiresAt, remaining_devices: 0, max_devices: 1
  });
});

app.get('/api/key_status/:key', (req, res) => {
  db.removeExpired();
  const rec = db.findKey(req.params.key);
  if (!rec) return res.status(404).json({ error: "Key not found" });
  const acts = db.getActivationsForKey(rec.key);
  res.json({
    key: rec.key,
    max_devices: rec.max_devices,
    used_count: acts.length,
    remaining: Math.max(0, rec.max_devices - acts.length),
    status: keyStatus(rec),
    devices: acts.map(a => a.deviceId),
    is_trial: !!rec.is_trial,
    is_paid: !!rec.is_paid,
    expires_at: rec.expires_at
  });
});

// ─────────────────────────────────────────────
// NEW HMAC API — used by LicenseClient (license_client.cpp)
//   POST /api/activate   {key, device_id, android_id, wifi_bssid, wifi_ip, build_fp, rid}
//   POST /api/verify     {device_id, android_id, token?, rid}
//   POST /api/heartbeat  {device_id, android_id, rid}
// Responses are enveloped: {p:{...}, t, rid, n, s}
// where s = hmac(secret, sha256(canonical(p)) + "." + t + "." + rid + "." + n)
// ─────────────────────────────────────────────

function denyEnveloped(rid, reason, extra = {}) {
  const payload = {
    ok: false,
    access: "none",
    reason: reason,
    remaining_seconds: -1,
    destruct: true,
    ...extra
  };
  const { envelope } = buildEnvelope(payload, rid);
  return envelope;
}

app.post('/api/activate', (req, res) => {
  db.removeExpired();
  const { key, device_id, android_id, wifi_bssid, wifi_ip, build_fp, rid } = req.body || {};
  const deviceId = device_id;
  if (!rid) return res.status(400).json({ error: "rid required" });
  if (!key || !deviceId) {
    const env = denyEnveloped(rid, "missing_fields");
    return res.json(env);
  }

  const rec = db.findKey(key);
  if (!rec) {
    const env = denyEnveloped(rid, "invalid_key");
    return res.json(env);
  }
  if (keyStatus(rec) !== 'active') {
    const env = denyEnveloped(rid, keyStatus(rec));
    return res.json(env);
  }

  const existing = db.findActivation(deviceId, key);
  const used = db.countActiveDevices(key);
  if (!existing && used >= rec.max_devices) {
    const env = denyEnveloped(rid, "device_limit");
    return res.json(env);
  }

  const token = db.generateToken(deviceId, rec.key, rec.id);
  const expiresAt = rec.is_trial
    ? new Date(Date.now() + 24*3600*1000).toISOString()
    : rec.expires_at;
  const expiresMs = expiresAt ? new Date(expiresAt).getTime() : 0;
  const remaining = expiresAt ? Math.max(0, Math.floor((new Date(expiresAt).getTime() - Date.now())/1000)) : 999999;

  db.upsertActivation({
    keyId: rec.id,
    keyText: rec.key,
    deviceId,
    androidId: android_id || "",
    wifiIp: wifi_ip || "",
    bssid: wifi_bssid || "",
    buildFp: build_fp || "",
    token,
    expiresAt
  });

  const payload = {
    ok: true,
    access: rec.is_trial ? "trial" : "paid",
    token,
    expires_at: expiresAt || "",
    remaining_seconds: remaining,
    reason: "ok"
  };
  const { envelope } = buildEnvelope(payload, rid);
  return res.json(envelope);
});

app.post('/api/verify', (req, res) => {
  db.removeExpired();
  const { device_id, android_id, token, rid } = req.body || {};
  const deviceId = device_id;
  if (!rid) return res.status(400).json({ error: "rid required" });
  if (!deviceId) {
    const env = denyEnveloped(rid, "missing_device");
    return res.json(env);
  }

  // find activation by device
  let act = null;
  if (token) act = db.findActivationByToken(token);
  if (!act) act = db.findActivationByDevice(deviceId);

  if (!act) {
    const env = denyEnveloped(rid, "not_activated");
    return res.json(env);
  }

  // ensure device matches if token provided
  if (token && act.token !== token) {
    const env = denyEnveloped(rid, "token_mismatch");
    return res.json(env);
  }
  if (act.deviceId !== deviceId) {
    // allow android_id mismatch? strictly device_id must match
    const env = denyEnveloped(rid, "device_mismatch");
    return res.json(env);
  }

  const rec = db.findKeyById(act.keyId) || db.findKey(act.keyText);
  if (!rec) {
    const env = denyEnveloped(rid, "key_not_found");
    return res.json(env);
  }
  if (keyStatus(rec) !== 'active') {
    const env = denyEnveloped(rid, keyStatus(rec), { destruct: true });
    return res.json(env);
  }
  if (isExpired(act.expiresAt)) {
    // clean up expired
    db.revokeDevice(deviceId, act.keyText);
    const env = denyEnveloped(rid, "expired", { destruct: true, remaining_seconds: 0 });
    return res.json(env);
  }

  db.touchActivation(act.token);
  const remaining = act.expiresAt ? Math.max(0, Math.floor((new Date(act.expiresAt).getTime() - Date.now())/1000)) : 999999;

  const payload = {
    ok: true,
    access: rec.is_trial ? "trial" : "paid",
    token: act.token,
    remaining_seconds: remaining,
    expires_at: act.expiresAt || "",
    destruct: false,
    reason: "ok"
  };
  const { envelope } = buildEnvelope(payload, rid);
  return res.json(envelope);
});

app.post('/api/heartbeat', (req, res) => {
  db.removeExpired();
  const { device_id, android_id, rid } = req.body || {};
  const deviceId = device_id;
  if (!rid) return res.status(400).json({ error: "rid required" });
  if (!deviceId) {
    const env = buildEnvelope({ ok: false, destruct: true, remaining_seconds: 0, reason: "missing_device" }, rid).envelope;
    return res.json(env);
  }

  const act = db.findActivationByDevice(deviceId);
  if (!act) {
    const env = buildEnvelope({ ok: false, destruct: true, remaining_seconds: 0, reason: "not_activated" }, rid).envelope;
    return res.json(env);
  }
  const rec = db.findKeyById(act.keyId) || db.findKey(act.keyText);
  if (!rec || keyStatus(rec) !== 'active' || isExpired(act.expiresAt)) {
    const env = buildEnvelope({ ok: false, destruct: true, remaining_seconds: 0, reason: "expired" }, rid).envelope;
    return res.json(env);
  }

  db.touchActivation(act.token);
  const remaining = act.expiresAt ? Math.max(0, Math.floor((new Date(act.expiresAt).getTime() - Date.now())/1000)) : 999999;
  const payload = { ok: true, destruct: false, remaining_seconds: remaining, reason: "ok" };
  const { envelope } = buildEnvelope(payload, rid);
  return res.json(envelope);
});

// ─────────────────────────────────────────────
// ADMIN API — simple Basic Auth via header
// ─────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  // support Bearer token = base64(user:pass) or Basic
  let ok = false;
  if (auth) {
    try {
      let decoded = "";
      if (auth.startsWith('Basic ')) decoded = Buffer.from(auth.slice(6), 'base64').toString();
      else if (auth.startsWith('Bearer ')) decoded = Buffer.from(auth.slice(7), 'base64').toString();
      else decoded = Buffer.from(auth, 'base64').toString();
      const [u, p] = decoded.split(':');
      if (u === ADMIN_USER && p === ADMIN_PASS) ok = true;
    } catch {}
  }
  // also allow query ?admin=...
  if (!ok && req.query.admin_user === ADMIN_USER && req.query.admin_pass === ADMIN_PASS) ok = true;
  // also allow JSON body admin
  if (!ok && req.body && req.body.admin_user === ADMIN_USER && req.body.admin_pass === ADMIN_PASS) ok = true;

  if (!ok) {
    res.setHeader('WWW-Authenticate', 'Basic realm="Admin"');
    return res.status(401).json({ error: "Unauthorized — provide Admin credentials" });
  }
  next();
}

app.post('/admin/login', (req, res) => {
  const { user, pass, admin_user, admin_pass } = req.body || {};
  const u = user || admin_user;
  const p = pass || admin_pass;
  if (u === ADMIN_USER && p === ADMIN_PASS) {
    const token = Buffer.from(`${u}:${p}`).toString('base64');
    return res.json({ ok: true, token });
  }
  return res.status(401).json({ ok: false, message: "Invalid credentials" });
});

app.get('/admin/stats', requireAdmin, (req, res) => {
  db.removeExpired();
  res.json({ ...db.stats(), keys: db.listKeys().length, time: new Date().toISOString() });
});

app.get('/admin/keys', requireAdmin, (req, res) => {
  db.removeExpired();
  const keys = db.listKeys().map(k => ({
    ...k,
    used_count: db.countActiveDevices(k.key),
    remaining: Math.max(0, k.max_devices - db.countActiveDevices(k.key)),
    status_computed: keyStatus(k)
  }));
  res.json(keys);
});

app.post('/admin/keys', requireAdmin, (req, res) => {
  try {
    const { key, max_devices, is_trial, is_paid, days, note } = req.body;
    if (!key) return res.status(400).json({ error: "key required" });
    const rec = db.createKey({ key, max_devices: parseInt(max_devices) || 1, is_trial: !!is_trial, is_paid: is_paid !== false, days: parseInt(days) || 30, note: note || "" });
    res.json(rec);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.put('/admin/keys/:id', requireAdmin, (req, res) => {
  try {
    const id = parseInt(req.params.id);
    const patch = req.body;
    if (patch.max_devices) patch.max_devices = parseInt(patch.max_devices);
    if (patch.days !== undefined) {
      const days = parseInt(patch.days);
      patch.expires_at = days === 0 ? null : new Date(Date.now() + days*24*3600*1000).toISOString();
      delete patch.days;
    }
    const rec = db.updateKey(id, patch);
    res.json(rec);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.delete('/admin/keys/:id', requireAdmin, (req, res) => {
  try {
    db.deleteKey(parseInt(req.params.id));
    res.json({ ok: true });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.get('/admin/activations', requireAdmin, (req, res) => {
  db.removeExpired();
  res.json(db.listActivations());
});

app.delete('/admin/activations', requireAdmin, (req, res) => {
  const { device_id, key } = req.body;
  if (!device_id || !key) return res.status(400).json({ error: "device_id and key required" });
  const ok = db.revokeDevice(device_id, key);
  res.json({ ok, message: ok ? "Revoked" : "Not found" });
});

app.post('/admin/generate', requireAdmin, (req, res) => {
  // quick generate random key
  const { prefix = "FACE", count = 1, max_devices = 1, is_trial = false, days = 30 } = req.body;
  const out = [];
  for (let i = 0; i < Math.min(count, 50); i++) {
    const rand = crypto.randomBytes(3).toString('hex').toUpperCase();
    const key = `${prefix}-${rand}-${crypto.randomBytes(2).toString('hex').toUpperCase()}`;
    try {
      out.push(db.createKey({ key, max_devices, is_trial, is_paid: !is_trial, days, note: "auto-generated" }));
    } catch (e) { /* duplicate */ }
  }
  res.json(out);
});

// fallback to index.html for SPA
app.get('*', (req, res) => {
  // if API 404, already handled above; this is for frontend routes
  if (req.path.startsWith('/api/') || req.path.startsWith('/admin/')) {
    return res.status(404).json({ error: "Not found" });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// error handler
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: "Internal error", detail: err.message });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`
╔════════════════════════════════════════════════════╗
║  FaceDocs License Server — facedocs.bond         ║
║  Listening 0.0.0.0:${String(PORT).padEnd(33)}║
║  VPS 82.25.90.196                                 ║
║  Health: http://localhost:${PORT}/api/health        ║
╚════════════════════════════════════════════════════╝
`);
  console.log(`Admin: ${ADMIN_USER} / ${ADMIN_PASS.replace(/./g,'*')}`);
});
