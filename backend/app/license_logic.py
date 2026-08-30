"""
License business logic -- ported from
orangecontrib/custom/widgets/settings_business_logic.py (the Qt Settings
widget's bridge implementation) to run standalone under FastAPI instead of
inside a QWebChannel callback. Same machine-id derivation, same JWT
verification (RSA-2048 public key, verified locally, no network call needed
for a still-fresh token), same keyring storage, same license-server
endpoints (https://backend.alteradatasuite.com) -- this is the real,
production licensing flow, not a mock.

The original used a `send(dict)` callback (because Qt dispatch was
signal-based); every function here instead just returns the response dict
directly, since a FastAPI endpoint is naturally request/response.
"""

import os
import json
import hashlib
import platform
from datetime import datetime, timezone
from typing import Optional

import keyring
import keyring.errors
import requests


# ── Server URLs ───────────────────────────────────────────────────────────────

_BASE = "https://backend.alteradatasuite.com"
_ACT = f"{_BASE}/license/activate"
_DAC = f"{_BASE}/license/deactivate"
_TRL = f"{_BASE}/trial/activate"
_RNW = f"{_BASE}/token/renew"

# ── RSA Public Key ─────────────────────────────────────────────────────────────
# Verifies JWT signatures LOCALLY -- no network call needed for a fresh token.
# Matches the private key held only by the license server.

PUBLIC_KEY = """-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAoa+bb20BnwqcO3g+5xcj
n2Qd5JT4ZgbBi/a/v0xmZna2j2BOkc9NjFQrcuU7AJ21jay51APxKIFg3zfme+ey
KYdpw4O1srGsq6Mzn/lvK5wOUzBfr/WmQxZa1foGohpCFErGw3RUzW61ibfy1r8M
6r5JXB2rRLTrn6WiR2rbTMl0AsZqmTUbL4pBddMPUmTQ83wkkDWH5bP+bhNpDJDJ
Um3HqogFxDzMXaEifRpCCIKPV3FCqBhUGZyZAAQRh1TUIhT1cvB9ecOWjf7R/Yfm
r5D3HbKyUt8ciywZPci/OHHa/FiGOXYOq2gmINJbVhe9jGrOJI63hNCmFdXiLtXe
pQIDAQAB
-----END PUBLIC KEY-----"""

# ── Machine ID ────────────────────────────────────────────────────────────────


def _get_cpu_id() -> str:
    """Stable CPU identifier -- fallback only, used if py-machineid fails."""
    import subprocess
    sysname = platform.system()
    try:
        if sysname == "Windows":
            try:
                out = subprocess.check_output(
                    ["powershell", "-NoProfile", "-Command",
                     "Get-WmiObject Win32_Processor | Select-Object -ExpandProperty ProcessorId"],
                    text=True, stderr=subprocess.DEVNULL, timeout=5,
                )
                val = out.strip()
                if val:
                    return val
            except Exception:
                pass
            try:
                import winreg
                key = winreg.OpenKey(
                    winreg.HKEY_LOCAL_MACHINE,
                    r"HARDWARE\DESCRIPTION\System\CentralProcessor",
                )
                val, _ = winreg.QueryValueEx(key, "Identifier")
                winreg.CloseKey(key)
                if val:
                    return val.strip()
            except Exception:
                pass
        if sysname == "Darwin":
            return platform.processor()
        if sysname == "Linux":
            with open("/proc/cpuinfo") as f:
                for line in f:
                    if line.lower().startswith("serial"):
                        return line.split(":", 1)[1].strip()
            with open("/proc/cpuinfo") as f:
                for line in f:
                    if "model name" in line.lower():
                        return hashlib.md5(line.split(":", 1)[1].strip().encode()).hexdigest()
    except Exception:
        pass
    return ""


def get_machine_id() -> str:
    """
    Stable 4-block machine identifier (XXXX-XXXX-XXXX-XXXX).
    Priority: py-machineid's OS-level GUID (survives app reinstall, resets
    on OS reinstall), then CPU ID as a fallback. Deliberately no further
    fallback -- a random-file fallback was the actual hole an earlier
    version had (trivially reset by deleting the file).
    """
    primary_error: Exception
    try:
        import machineid
        digest = machineid.hashed_id("altera-data-suite").upper()
        d = digest[:16]
        return f"{d[0:4]}-{d[4:8]}-{d[8:12]}-{d[12:16]}"
    except Exception as e:
        primary_error = e

    cpu_id = _get_cpu_id()
    if cpu_id:
        digest = hashlib.sha256(cpu_id.encode()).hexdigest().upper()
        d = digest[:16]
        return f"{d[0:4]}-{d[4:8]}-{d[8:12]}-{d[12:16]}"

    raise primary_error


# ── Token Storage ─────────────────────────────────────────────────────────────

KEYRING_SERVICE = "AlteraDataSuite"
KEYRING_USER = "license"
LEGACY_TOKEN_FILE = os.path.join(os.path.expanduser("~"), ".altera_suite", "license.json")


def _migrate_legacy_token() -> None:
    if not os.path.exists(LEGACY_TOKEN_FILE):
        return
    try:
        with open(LEGACY_TOKEN_FILE) as f:
            data = json.load(f)
        if data.get("token"):
            keyring.set_password(KEYRING_SERVICE, KEYRING_USER, json.dumps(data))
            os.remove(LEGACY_TOKEN_FILE)
            print("[License] migrated legacy license.json -> keyring")
    except Exception as e:
        print(f"[License] migration error (ignored): {e}")


def load_stored_license() -> Optional[dict]:
    _migrate_legacy_token()
    try:
        val = keyring.get_password(KEYRING_SERVICE, KEYRING_USER)
        if not val:
            return None
        return json.loads(val)
    except Exception as e:
        print(f"[License] keyring read error: {e}")
        return None


def save_license(data: dict) -> None:
    try:
        keyring.set_password(KEYRING_SERVICE, KEYRING_USER, json.dumps(data))
    except Exception as e:
        print(f"[License] keyring write error: {e}")


def delete_license() -> None:
    try:
        keyring.delete_password(KEYRING_SERVICE, KEYRING_USER)
    except keyring.errors.PasswordDeleteError:
        pass
    except Exception as e:
        print(f"[License] keyring delete error: {e}")


# ── JWT Local Verification ────────────────────────────────────────────────────

def verify_token_locally(token: str) -> Optional[dict]:
    """Cryptographically verify a JWT via the embedded RSA public key (no
    network call). Does NOT enforce expiry -- caller checks that separately."""
    try:
        from jose import jwt as _jwt
        return _jwt.decode(
            token, PUBLIC_KEY, algorithms=["RS256"],
            options={"verify_exp": False},
        )
    except Exception as e:
        print(f"[License] JWT verification failed: {e}")
        return None


def is_token_expired(payload: dict) -> bool:
    """True if the JWT's own short-lived TTL ('exp') has passed -- needs a
    server renewal, does NOT mean the underlying license/trial is gone."""
    exp = payload.get("exp")
    if exp is None:
        return True
    return datetime.now(timezone.utc).timestamp() > float(exp)


def is_license_expired(payload: dict) -> bool:
    """True if the actual license/trial subscription has expired -- a hard
    block; renewal will not help."""
    raw = payload.get("license_expiry")
    if not raw:
        return True
    try:
        dt = datetime.fromisoformat(raw)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return datetime.now(timezone.utc) > dt
    except Exception:
        return True


# ── Trial Activation ──────────────────────────────────────────────────────────

def start_trial_sync(machine_id: str) -> dict:
    """{"success": True, ...} or {"success": False, "error": "offline" | "timeout" | <message>}."""
    print(f"[License] start_trial_sync: POST {_TRL}")
    try:
        username = os.environ.get("USERNAME") or os.environ.get("USER") or ""
        resp = requests.post(_TRL, json={"machine_id": machine_id, "username": username}, timeout=10)
        print(f"[License] start_trial_sync: HTTP {resp.status_code} -> {resp.text[:300]}")
        if resp.ok:
            data = resp.json()
            save_license({
                "token": data.get("token", ""),
                "plan": data.get("plan", "trial"),
                "email": "",
                "expiry": data.get("expiry_date", ""),
            })
            return {"success": True, "plan": "trial", "expiry_date": data.get("expiry_date", "")}
        try:
            err = resp.json().get("detail", resp.text)
        except Exception:
            err = resp.text or f"HTTP {resp.status_code}"
        return {"success": False, "error": err}
    except requests.exceptions.ConnectionError:
        return {"success": False, "error": "offline"}
    except requests.exceptions.Timeout:
        return {"success": False, "error": "timeout"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ── Token Renewal ─────────────────────────────────────────────────────────────

def renew_token_sync(machine_id: str, token: str) -> dict:
    """Sends the (possibly expired) JWT to the server for a fresh one; the
    server accepts expired tokens here, verifies the signature, checks
    ban/lapse state, then mints and returns a new JWT."""
    print(f"[License] renew_token_sync: POST {_RNW}")
    try:
        resp = requests.post(_RNW, json={"token": token, "machine_id": machine_id}, timeout=10)
        print(f"[License] renew_token_sync: HTTP {resp.status_code} -> {resp.text[:200]}")
        if resp.ok:
            data = resp.json()
            save_license({
                "token": data.get("token", ""),
                "plan": data.get("plan", ""),
                "email": data.get("email", ""),
                "expiry": data.get("expiry_date", ""),
            })
            return {"success": True, "token": data.get("token", ""), "plan": data.get("plan", "")}
        try:
            err = resp.json().get("detail", resp.text)
        except Exception:
            err = resp.text or f"HTTP {resp.status_code}"
        return {"success": False, "error": err}
    except requests.exceptions.ConnectionError:
        return {"success": False, "error": "offline"}
    except requests.exceptions.Timeout:
        return {"success": False, "error": "timeout"}
    except Exception as e:
        return {"success": False, "error": str(e)}


# ── check_license / check_with_auto_trial ──────────────────────────────────────
# Both return the same license_check_result-shaped dict the frontend renders
# directly. `state` is one of: no_license | invalid | expired | valid.

def _check_stored(machine_id: str, stored: dict) -> dict:
    token = stored["token"]
    payload = verify_token_locally(token)
    if payload is None:
        delete_license()
        return {"valid": False, "state": "invalid", "message": "Stored token has an invalid signature."}

    if is_license_expired(payload):
        return {
            "valid": False, "state": "expired", "expired": True,
            "plan": payload.get("plan", ""),
            "expiry_date": payload.get("license_expiry", ""),
            "message": f"License expired on {payload.get('license_expiry', 'unknown')}",
        }

    if is_token_expired(payload):
        print("[License] check_license: JWT TTL expired, renewing")
        result = renew_token_sync(machine_id, token)
        if result.get("success"):
            new_stored = load_stored_license()
            new_token = new_stored.get("token", "") if new_stored else ""
            new_payload = verify_token_locally(new_token) if new_token else {}
            return {
                "valid": True, "state": "valid", "token": new_token,
                "plan": new_payload.get("plan", ""),
                "expiry_date": new_payload.get("license_expiry", ""),
                "last_check": new_payload.get("last_check", ""),
            }
        if result.get("error") in ("offline", "timeout"):
            print("[License] check_license: offline grace -- using cached JWT payload")
            return {
                "valid": True, "state": "valid", "token": token,
                "plan": payload.get("plan", ""),
                "expiry_date": payload.get("license_expiry", ""),
                "last_check": payload.get("last_check", ""),
                "offline": True,
            }
        delete_license()
        return {"valid": False, "state": "invalid", "message": result.get("error", "License renewal was rejected.")}

    return {
        "valid": True, "state": "valid", "token": token,
        "plan": payload.get("plan", ""),
        "expiry_date": payload.get("license_expiry", ""),
        "last_check": payload.get("last_check", ""),
    }


def check_license(machine_id: str) -> dict:
    stored = load_stored_license()
    if not stored or "token" not in stored:
        print("[License] check_license: no stored token")
        return {"valid": False, "state": "no_license"}
    return _check_stored(machine_id, stored)


def check_with_auto_trial(machine_id: str) -> dict:
    """Like check_license but auto-starts a trial if no token is stored yet."""
    stored = load_stored_license()
    if not stored or "token" not in stored:
        print("[License] check_with_auto_trial: no token -- attempting auto-trial")
        result = start_trial_sync(machine_id)
        if result.get("success"):
            stored = load_stored_license()
        else:
            err = result.get("error", "")
            if err not in ("offline", "timeout"):
                return {"valid": False, "state": "no_license", "message": result.get("message", "Trial not available.")}
            return {"valid": False, "state": "no_license"}

    if not stored or "token" not in stored:
        return {"valid": False, "state": "no_license"}

    return _check_stored(machine_id, stored)


# ── activate_license / deactivate_license ──────────────────────────────────────

def activate_license(license_key: str, machine_id: str) -> dict:
    print(f"[License] activate: POST {_ACT}")
    try:
        username = os.environ.get("USERNAME") or os.environ.get("USER") or ""
        resp = requests.post(
            _ACT, json={"license_key": license_key, "machine_id": machine_id, "username": username}, timeout=15,
        )
        print(f"[License] activate: HTTP {resp.status_code} -> {resp.text[:200]}")
        if resp.ok:
            data = resp.json()
            save_license({
                "token": data.get("token", ""),
                "email": data.get("email", ""),
                "plan": data.get("plan", ""),
                "username": data.get("username", ""),
                "expiry": data.get("expiry_date", ""),
            })
            return {
                "success": True, "token": data.get("token", ""), "email": data.get("email", ""),
                "plan": data.get("plan", ""), "username": data.get("username", ""),
                "expiry_date": data.get("expiry_date", ""),
            }
        try:
            err = resp.json().get("detail", resp.text)
        except Exception:
            err = resp.text or f"HTTP {resp.status_code}"
        return {"success": False, "error": err}
    except requests.exceptions.ConnectionError:
        return {"success": False, "error": "No internet connection."}
    except Exception as e:
        return {"success": False, "error": str(e)}


def deactivate_license(machine_id: str) -> dict:
    stored = load_stored_license()
    token = stored.get("token") if stored else None
    if token:
        try:
            requests.post(_DAC, json={"token": token, "machine_id": machine_id}, timeout=10)
        except Exception as e:
            print(f"[License] deactivate call failed (ignoring): {e}")
    delete_license()
    return {"success": True, "message": "License deactivated successfully"}
