# FaceGate V4.7.8 — Patch Guide for facedocs.bond

This guide migrates the app from
- `https://standing-panther-214.convex.site` (activation.cpp / ApiService)
- `https://grateful-mule-939.convex.site` (license_client.cpp)

to **https://facedocs.bond** (single domain, all 8 endpoints).

---

## 1) What the app currently does (activation files only)

**Found activation-related files (you asked to scope only these):**
- `app/src/main/cpp/activation.cpp` — JNI HTTP + XOR-obfuscated Base URL `standing-panther-214.convex.site`, endpoints `/api/validate_key`, `/api/verify_token`, plus encrypted local file `fg_lic.bin` (XOR with `android_id`+SALT + anti-debug Frida check).
- `app/src/main/cpp/license/license_client.cpp` + `.h` + `sha256.h` — HMAC-verified client. Base `grateful-mule-939.convex.site`, endpoints `/api/activate`, `/api/verify`, `/api/heartbeat`. Envelope verification via `FACEGATE_HMAC_SECRET = a7f3c9e1b8d4025f6a4b9c0e7d1f8a3b5c2e6d9f0a1b4c7d8e2f5a9b3c6d0e7f`.
- `app/src/main/java/com/itsme/amkush/license/LicenseClient.kt` — Kotlin wrapper for `nativeActivate / nativeVerify / nativeHeartbeat`, parses JSON response `{ok, access, token, expires_at, remaining_seconds, reason, destruct}`.
- `app/src/main/java/com/itsme/amkush/network/ApiClient.kt` + `ApiService.kt` + `models/ValidateRequest.kt` / `ValidateResponse.kt` — Retrofit client using `LicenseGuard.nativeGetBaseUrl()` for `/api/validate_key`, `/api/verify_token`, `/api/check_trial`, `/api/activate_trial`, `GET /api/key_status/{key}`.
- `app/src/main/java/com/itsme/amkush/security/LicenseGuard.kt` — wrapper for `nativeValidateKey / nativeVerifyToken / nativeIsActivated / nativeSaveActivation / nativeClearActivation / nativeGetBaseUrl / nativeGetDownloadUrl / nativeGetTgBot…`.
- `app/src/main/java/com/itsme/amkush/utils/SharedPrefs.kt` — stores `activation_token`, `is_paid`, `is_trial`, `trial_expiry`, `device_id`, `trial_wifi_ip`.

All URLs are **XOR 0x5A obfuscated** — no plaintext in binary.

---

## 2) New domain bytes (XOR 0x5A)

New base: `https://facedocs.bond` → 21 bytes

### For `activation.cpp` — `BASE_URL_OBF`
```cpp
static const uint8_t BASE_URL_OBF[] = {
    0x32,0x2e,0x2e,0x2a,0x29,0x60,0x75,0x75,
    0x3c,0x3b,0x39,0x3f,0x3e,0x35,0x39,0x29,
    0x74,0x38,0x35,0x34,0x3e
};
```
Replace the 38-byte `standing-panther...` array with this 21-byte array.

### For `license/license_client.cpp` — `LC_BASE_URL_OBF`
```cpp
static const uint8_t LC_BASE_URL_OBF[] = {
    0x32,0x2e,0x2e,0x2a,0x29,0x60,0x75,0x75,
    0x3c,0x3b,0x39,0x3f,0x3e,0x35,0x39,0x29,
    0x74,0x38,0x35,0x34,0x3e
};
```
Same bytes (identical decode).

### Optional: `DOWNLOAD_URL_OBF` in `activation.cpp`
Old: `https://grateful-mule-939.convex.site/download`
New: `https://facedocs.bond/download`
```cpp
static const uint8_t DOWNLOAD_URL_OBF[] = {
    0x32,0x2e,0x2e,0x2a,0x29,0x60,0x75,0x75,
    0x3c,0x3b,0x39,0x3f,0x3e,0x35,0x39,0x29,
    0x74,0x38,0x35,0x34,0x3e,0x75,0x3e,0x35,
    0x2d,0x34,0x36,0x35,0x3b,0x3e
};
```

`TG_BOT_OBF` / `TG_CHANNEL_OBF` / `TG_OWNER_OBF` can stay or be pointed to your new channel — leave as-is if you still use Convex bots.

---

## 3) Step-by-step patch

### A) Quick Python patch script (run in repo root)
```bash
python3 << 'PY'
import re, pathlib

def xor_encode(s): return [ord(c) ^ 0x5A for c in s]

new_b = xor_encode("https://facedocs.bond")
new_dl = xor_encode("https://facedocs.bond/download")
def fmt(arr, name):
    hexs = ",".join(f"0x{b:02x}" for b in arr)
    # split every 8
    parts=[]
    for i in range(0,len(arr),8):
        parts.append(", ".join(f"0x{b:02x}" for b in arr[i:i+8]))
    body=",\n    ".join(parts)
    return f"static const uint8_t {name}[] = {{\n    {body}\n}};"

act = pathlib.Path("app/src/main/cpp/activation.cpp")
txt = act.read_text()

# Replace BASE_URL_OBF
txt = re.sub(r"static const uint8_t BASE_URL_OBF\[\] = \{[^}]+\};",
             fmt(new_b,"BASE_URL_OBF"), txt, flags=re.S)

# Replace DOWNLOAD_URL_OBF
txt = re.sub(r"static const uint8_t DOWNLOAD_URL_OBF\[\] = \{[^}]+\};",
             fmt(new_dl,"DOWNLOAD_URL_OBF"), txt, flags=re.S)

act.write_text(txt)
print("patched activation.cpp")

lc = pathlib.Path("app/src/main/cpp/license/license_client.cpp")
t2 = lc.read_text()
t2 = re.sub(r"static const uint8_t LC_BASE_URL_OBF\[\] = \{[^}]+\};",
            fmt(new_b,"LC_BASE_URL_OBF"), t2, flags=re.S)
lc.write_text(t2)
print("patched license_client.cpp")
PY
```

### B) Manual edit (Android Studio)
1. Open `activation.cpp`, find `BASE_URL_OBF` (line ~21), replace array.
2. Open `license_client.cpp`, find `LC_BASE_URL_OBF` (line ~24), replace.
3. Optional: update `DOWNLOAD_URL_OBF`.
4. **Save**, then `Build → Clean Project`.
5. `Build → Generate Signed Bundle / APK → release`.

### C) Verify decode (on-device logcat)
After install, filter logcat:
```bash
adb logcat | grep -i "fg_lic\|license\|amkush"
```
You should see `http_post: https://facedocs.bond/api/validate_key code=200` etc.

If you still see `convex.site`, the .so was cached — full clean required.

---

## 4) Server-side compatibility

The new server at `facedocs.bond` implements **both** APIs so either old or patched app works:

| Endpoint | Method | Body | Response |
|---|---|---|---|
| `/api/validate_key` | POST | `{key, device_id, wifi_ip?}` | `{success, message, token, is_trial, is_paid, expires_at, remaining_devices, max_devices}` |
| `/api/verify_token` | POST | `{token, device_id}` | `{valid, message, is_trial, is_paid, expires_at}` |
| `/api/check_trial` | POST | `{device_id}` | `{available, message, expires_at}` |
| `/api/activate_trial` | POST | `{device_id, key?}` | same as validate_key |
| `GET /api/key_status/:key` | GET | — | `{key, max_devices, used_count, remaining, status, devices}` |
| `/api/activate` | POST | `{key, device_id, android_id, wifi_bssid, wifi_ip, build_fp, rid}` | **enveloped** `{p:{ok, access, token, expires_at, remaining_seconds, reason}, t, rid, n, s}` |
| `/api/verify` | POST | `{device_id, android_id, token?, rid}` | enveloped `{p:{ok, access, token, remaining_seconds, expires_at, destruct, reason}, …}` |
| `/api/heartbeat` | POST | `{device_id, android_id, rid}` | enveloped `{p:{ok, destruct, remaining_seconds, reason}, …}` |

HMAC envelope details:
```
p_canonical = JSON with keys sorted alphabetically, json_escape() as in C++
ph = sha256_hex(p_canonical)
canonical = ph + "." + t + "." + rid + "." + n   // t=Date.now(), n=random 16hex, rid=client rid
s = hmac_sha256_hex("a7f3c9e1b8d4025f6a4b9c0e7d1f8a3b5c2e6d9f0a1b4c7d8e2f5a9b3c6d0e7f", canonical)
Response JSON = {"p": <original obj>, "t":t, "rid":rid, "n":n, "s":s}
Native verify_envelope() recomputes and hex_eq() — mismatch = empty return → activation fails.
```

---

## 5) Kotlin side — nothing to change if you patch the .so

`ApiClient.BASE_URL` lazily calls `LicenseGuard.nativeGetBaseUrl()` — after patch it returns `https://facedocs.bond/` automatically.

If you want a Kotlin fallback (for debug builds without native lib):
```kotlin
// in ApiClient.kt
private val BASE_URL: String by lazy {
    try {
        val url = LicenseGuard.nativeGetBaseUrl()
        if (url.isNotEmpty()) url.trimEnd('/') + "/"
        else "https://facedocs.bond/"
    } catch (t: Throwable) {
        "https://facedocs.bond/"
    }
}
```

---

## 6) Testing after patch
```bash
# health
curl https://facedocs.bond/api/health

# legacy activate
curl -X POST https://facedocs.bond/api/validate_key \
  -H "Content-Type: application/json" \
  -d '{"key":"NOWORNEVER","device_id":"test-abc-123"}'

# new HMAC activate
curl -X POST https://facedocs.bond/api/activate \
  -H "Content-Type: application/json" \
  -d '{"key":"NOWORNEVER","device_id":"test-abc-123","android_id":"abc","wifi_bssid":"","wifi_ip":"1.2.3.4","build_fp":"test","rid":"rid123"}'

# verify
curl -X POST https://facedocs.bond/api/verify_token \
  -H "Content-Type: application/json" \
  -d '{"token":"<from previous>","device_id":"test-abc-123"}'
```

---

## 7) Security note
Revoke the Convex-side keys if you fully migrate. Keep `FACEGATE_HMAC_SECRET` identical on server (`envelope.js`) and native (`license_client.h`). Changing it requires re-patching the app again.

Invalidate GitHub PAT `ghp_yiicR1k...52De` after clone — it was pasted in plaintext.
