"""JibonGuard local web server with SQLite-backed organization authentication.

For production, put this behind HTTPS, set APP_ENV=production, PUBLIC_ORIGIN,
SESSION_SECRET and SMTP settings, and use a production WSGI/ASGI server.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import mimetypes
import os
import re
import secrets
import smtplib
import sqlite3
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo
from email.message import EmailMessage
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlencode, urlparse
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

ROOT = Path(__file__).resolve().parent
# Load project-local development settings without requiring a third-party package.
for _line in (ROOT / ".env").read_text(encoding="utf-8").splitlines() if (ROOT / ".env").exists() else []:
    _line = _line.strip()
    if _line and not _line.startswith("#") and "=" in _line:
        _key, _value = _line.split("=", 1)
        os.environ.setdefault(_key.strip(), _value.strip().strip("\"'"))
DB_PATH = Path(os.environ.get("JIBONGUARD_DB", ROOT / "jibonguard.sqlite3"))
OPEN_METEO_API_KEY = os.environ.get("OPEN_METEO_API_KEY", "").strip()
GEMINI_API_KEY = os.environ.get("GEMINI_API_KEY", "").strip()
GEMINI_MODEL = (os.environ.get("GEMINI_MODEL") or "gemini-3.5-flash-lite").strip()
# TextBee credentials are server-only. TEXTBEE_DEV_API remains supported for existing .env files.
TEXTBEE_API_KEY = (os.environ.get("TEXTBEE_API_KEY") or os.environ.get("TEXTBEE_DEV_API", "")).strip()
TEXTBEE_SIM_SUBSCRIPTION_ID = (os.environ.get("TEXTBEE_SIM_SUBSCRIPTION_ID") or os.environ.get("SIM_SUBSCRIPTION_ID", "")).strip()
TEXTBEE_BASE_URL = os.environ.get("TEXTBEE_BASE_URL", "https://api.textbee.dev/api/v1").strip().rstrip("/")
WEATHER_CACHE: dict[str, tuple[float, dict]] = {}
NOMINATIM_CACHE: dict[str, tuple[float, dict]] = {}
NOMINATIM_LAST_REQUEST = 0.0
NOMINATIM_LOCK = threading.Lock()
PHOTON_CACHE: dict[str, tuple[float, dict]] = {}
PHOTON_LAST_REQUEST = 0.0
PHOTON_LOCK = threading.Lock()
PHOTON_API_URL = os.environ.get("PHOTON_API_URL", "https://photon.komoot.io/api/").strip()
APP_ENV = os.environ.get("APP_ENV", "development").lower()
IS_PRODUCTION = APP_ENV == "production"
HOST = os.environ.get("HOST", "127.0.0.1")
PORT = int(os.environ.get("PORT", "8000"))
PUBLIC_ORIGIN = os.environ.get("PUBLIC_ORIGIN", f"http://127.0.0.1:{PORT}").rstrip("/")
SESSION_SECRET = os.environ.get("SESSION_SECRET", "")
if IS_PRODUCTION and len(SESSION_SECRET) < 32:
    raise SystemExit("Set SESSION_SECRET to a random value of at least 32 characters.")
if IS_PRODUCTION and not PUBLIC_ORIGIN.startswith("https://"):
    raise SystemExit("Set PUBLIC_ORIGIN to the production HTTPS origin, for example https://app.example.com.")
if IS_PRODUCTION and (urlparse(PUBLIC_ORIGIN).netloc == "" or urlparse(PUBLIC_ORIGIN).path):
    raise SystemExit("PUBLIC_ORIGIN must contain only the production origin, without a path.")
if IS_PRODUCTION and (not os.environ.get("SMTP_HOST") or not (os.environ.get("SMTP_FROM") or os.environ.get("SMTP_USER"))):
    raise SystemExit("Set SMTP_HOST and SMTP_FROM (or SMTP_USER) in production.")

CSRF_COOKIE = "jg_csrf"
SESSION_COOKIE = "jg_session"
STATIC_FILES = {
    "index.html", "signup.html", "login.html", "verify.html", "privacy.html",
    "dashboard.html", "account.html", "resend-verification.html", "styles.css", "dashboard.css", "auth.css", "app.js",
    "dashboard.js", "ai-chat.js", "auth.js", "account.js", "theme.js", "brand-mark.svg",
}
SESSION_LIFETIME = 60 * 60 * 12
REMEMBER_LIFETIME = 60 * 60 * 24 * 30
TOKEN_LIFETIME = 60 * 60
RATE_LIMITS: dict[tuple[str, str], list[float]] = {}
PASSWORD_MIN = 12


def now() -> int:
    return int(time.time())


def utc_iso(timestamp: int | None = None) -> str:
    return datetime.fromtimestamp(timestamp or now(), timezone.utc).isoformat()


def open_meteo_summary(code: int | float | None) -> str:
    try:
        code = int(code)
    except (TypeError, ValueError):
        return "Conditions unavailable"
    summaries = {
        0: "Clear sky", 1: "Mainly clear", 2: "Partly cloudy", 3: "Overcast",
        45: "Fog", 48: "Depositing rime fog", 51: "Light drizzle", 53: "Drizzle",
        55: "Heavy drizzle", 56: "Light freezing drizzle", 57: "Freezing drizzle",
        61: "Light rain", 63: "Rain", 65: "Heavy rain", 66: "Light freezing rain",
        67: "Freezing rain", 71: "Light snow", 73: "Snow", 75: "Heavy snow",
        77: "Snow grains", 80: "Light rain showers", 81: "Rain showers",
        82: "Heavy rain showers", 85: "Light snow showers", 86: "Snow showers",
        95: "Thunderstorm", 96: "Thunderstorm with light hail", 99: "Thunderstorm with heavy hail",
    }
    return summaries.get(code, "Conditions unavailable")


DIGIT_TRANSLATION = str.maketrans("\u09e6\u09e7\u09e8\u09e9\u09ea\u09eb\u09ec\u09ed\u09ee\u09ef", "0123456789")


def normalize_digits(value: object) -> str:
    return str(value or "").translate(DIGIT_TRANSLATION)


def normalize_sms_recipient(phone: str) -> str | None:
    """Return an E.164 number for TextBee, or None when the stored value is ambiguous."""
    phone = normalize_digits(phone).strip()
    digits = re.sub(r"\D", "", phone)
    if phone.startswith("+"):
        normalized = digits
    elif digits.startswith("00"):
        normalized = digits[2:]
    elif digits.startswith("880"):
        normalized = digits
    elif digits.startswith("0") and len(digits) == 11:
        # The worker form's default country is Bangladesh; convert local mobile numbers.
        normalized = "880" + digits[1:]
    else:
        return None
    if not 8 <= len(normalized) <= 15 or normalized.startswith("0"):
        return None
    return "+" + normalized


BREAK_ALERTS = {
    "rain": "Rain alert",
    "storm": "Storm alert",
    "earthquake": "Earthquake alert",
}


def gemini_generate(contents: list[dict], system_instruction: str, *, json_response: bool = False) -> str:
    """Call Gemini from the server so credentials never enter browser code."""
    if not GEMINI_API_KEY:
        raise RuntimeError("Gemini is not configured. Set GEMINI_API_KEY in the server .env file.")
    generation_config = {"maxOutputTokens": 700}
    if GEMINI_MODEL.startswith("gemini-3"):
        # This assistant handles short safety and dashboard questions; minimal/low
        # thinking reduces latency without weakening the safety instructions.
        thinking_level = "minimal" if GEMINI_MODEL == "gemini-3.5-flash-lite" else "low"
        generation_config["thinkingConfig"] = {"thinkingLevel": thinking_level}
    if json_response:
        generation_config.update({"responseMimeType": "application/json"})
    payload = json.dumps({
        "systemInstruction": {"parts": [{"text": system_instruction}]},
        "contents": contents,
        "generationConfig": generation_config,
    }).encode("utf-8")
    request = Request(
        f"https://generativelanguage.googleapis.com/v1beta/models/{quote(GEMINI_MODEL, safe='-._')}:generateContent",
        data=payload,
        headers={"x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json", "Accept": "application/json"},
        method="POST",
    )
    try:
        with urlopen(request, timeout=50) as response:
            result = json.loads(response.read(1_000_000).decode("utf-8"))
    except HTTPError as exc:
        try:
            error_data = json.loads(exc.read(4096).decode("utf-8", "replace"))
            detail = str(error_data.get("error", {}).get("message", "")).strip()
        except (ValueError, AttributeError):
            detail = ""
        detail = re.sub(r"\s+", " ", detail)[:240]
        print(f"Gemini returned HTTP {exc.code}: {detail or 'no error detail'}", file=sys.stderr, flush=True)
        message = f"Gemini returned HTTP {exc.code}. {detail}" if detail else f"Gemini returned HTTP {exc.code}. Check the server key, model and API quota."
        raise RuntimeError(message) from None
    except (URLError, TimeoutError, OSError) as exc:
        print(f"Gemini connection failed ({type(exc).__name__}).", file=sys.stderr, flush=True)
        raise RuntimeError("Could not connect to Gemini. Check the server's internet connection.") from None
    except (ValueError, json.JSONDecodeError):
        raise RuntimeError("Gemini returned an unreadable response. Try again.") from None
    candidates = result.get("candidates") if isinstance(result, dict) else None
    candidate = candidates[0] if candidates and isinstance(candidates[0], dict) else {}
    content = candidate.get("content") if isinstance(candidate.get("content"), dict) else {}
    parts = content.get("parts", [])
    answer = "\n".join(str(part.get("text", "")) for part in parts if isinstance(part, dict)).strip()
    if not answer:
        prompt_feedback = result.get("promptFeedback") if isinstance(result, dict) else None
        if not isinstance(prompt_feedback, dict):
            prompt_feedback = {}
        feedback = candidate.get("finishReason") or prompt_feedback.get("blockReason")
        detail = f" ({feedback})" if feedback else ""
        raise RuntimeError(f"Gemini returned no text{detail}. Check the model/key or rephrase the prompt.")
    return answer


def fetch_ai_weather(site: sqlite3.Row) -> dict:
    """Get fresh current conditions and today's hourly forecast for a saved site."""
    params = {
        "latitude": site["latitude"], "longitude": site["longitude"],
        "current": "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_gusts_10m",
        "hourly": "temperature_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m",
        "forecast_days": 1, "timezone": "auto", "temperature_unit": "celsius",
        "wind_speed_unit": "ms", "precipitation_unit": "mm",
    }
    host = "customer-api.open-meteo.com" if OPEN_METEO_API_KEY else "api.open-meteo.com"
    if OPEN_METEO_API_KEY:
        params["apikey"] = OPEN_METEO_API_KEY
    request = Request(f"https://{host}/v1/forecast?{urlencode(params)}", headers={"Accept": "application/json", "User-Agent": "JibonGuard/1.0"})
    try:
        with urlopen(request, timeout=15) as response:
            weather = json.loads(response.read(1_000_000).decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, OSError, ValueError, json.JSONDecodeError) as exc:
        raise RuntimeError(f"Weather is unavailable for {site['name']}. Check the saved coordinates and retry.") from exc
    if not isinstance(weather, dict) or not isinstance(weather.get("current"), dict):
        raise RuntimeError(f"Weather data for {site['name']} was incomplete.")
    return weather


def send_textbee_break_sms(recipients: list[dict[str, str]], record: dict) -> dict:
    if not recipients:
        return {"status": "no_recipients", "recipient_count": 0,
                "message": "No consented workers with usable phone numbers are assigned to this site."}
    if not TEXTBEE_API_KEY:
        return {"status": "not_configured", "recipient_count": 0,
                "message": "Break saved, but SMS is not configured. Set TEXTBEE_API_KEY in JibonGuard AI/.env."}
    if not TEXTBEE_SIM_SUBSCRIPTION_ID.isdigit():
        return {"status": "not_configured", "recipient_count": 0,
                "message": "Break saved, but SMS was not sent. Set the numeric TEXTBEE_SIM_SUBSCRIPTION_ID in JibonGuard AI/.env."}
    if not TEXTBEE_BASE_URL.startswith("https://"):
        return {"status": "not_configured", "recipient_count": 0,
                "message": "Break saved, but SMS configuration must use an HTTPS TextBee API URL."}

    alert_type = str(record.get("alert_type", "break"))
    alert_copy = {
        "rain": (
        "Rain Alert: Rain is expected or has been detected in your area. "
        "Pause exposed outdoor work, move to a covered and safe location, "
        "and follow your site's safety instructions. Avoid slippery surfaces "
        "and waterlogged areas. Reassess the weather conditions after 30 minutes "
        "before resuming outdoor activities."
    ),
        "storm": (
        "Storm Alert: Severe weather may pose a risk to people working outdoors. "
        "Stop outdoor work immediately and move to your designated safe shelter, "
        "away from trees, electric poles, metal structures, and exposed areas. "
        "Follow official local weather warnings and emergency instructions. "
        "Check conditions again after 30 minutes, and resume work only when "
        "it is safe to do so."
    ),
        "earthquake": ( "Earthquake Alert: If shaking starts, DROP to the ground, COVER your " "head and neck, and HOLD ON to sturdy shelter. Once shaking stops, " "check for injuries and hazards, stay away from damaged buildings, " "and follow official emergency instructions. Reassess your surroundings " "after 30 minutes, but do not resume work until it is safe." )
    }
    messages = []
    for recipient in recipients:
        name = str(recipient.get("name") or "Worker").strip() or "Worker"
        if alert_type in alert_copy:
            message = f"Hi {name}, {alert_copy[alert_type]} Worksite: {record['site']}. - JibonGuard"
        else:
            message = (f"Hi {name}, break reminder: {record['title']} at {record['site']} on "
                       f"{record['break_date']} {record['break_time']} ({record['duration_minutes']} min). - JibonGuard")
        messages.append({
            "recipients": [recipient["phone"]],
            "message": message,
            "simSubscriptionId": int(TEXTBEE_SIM_SUBSCRIPTION_ID),
        })
    payload = json.dumps({
        "messages": messages,
        "messageTemplate": str(record.get("title", "JibonGuard alert"))[:100],
    }).encode("utf-8")
    request = Request(
        f"{TEXTBEE_BASE_URL}/gateway/send-bulk-sms",
        data=payload,
        headers={
            "x-api-key": TEXTBEE_API_KEY,
            "Content-Type": "application/json",
            "Accept": "application/json",
            "User-Agent": "JibonGuard/1.0 (site break notifications)",
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=20) as response:
            status_code = response.status
            content_type = response.headers.get_content_type()
            raw_response = response.read(256_000).decode("utf-8", "replace")
        try:
            result = json.loads(raw_response)
        except json.JSONDecodeError:
            print(f"TextBee returned a non-JSON response (HTTP {status_code}, {content_type}).", file=sys.stderr, flush=True)
            return {"status": "failed", "recipient_count": 0,
                    "message": f"Break saved, but TextBee returned an unreadable response (HTTP {status_code}). Retry shortly."}
        details = result.get("data") if isinstance(result, dict) else None
        if not isinstance(details, dict) or details.get("success") is not True:
            print("TextBee did not confirm the personalized SMS batch.", file=sys.stderr, flush=True)
            return {"status": "failed", "recipient_count": 0,
                    "message": "Break saved, but TextBee did not confirm the personalized SMS batch. Check the TextBee response and SIM setting."}
        return {"status": "queued", "recipient_count": len(recipients),
                "message": f"Personalized SMS queued for {len(recipients)} consented worker(s)."}
    except HTTPError as exc:
        if exc.code == 401:
            message = "Break saved, but TextBee rejected the API key. Check TEXTBEE_API_KEY."
        elif exc.code == 429:
            message = "Break saved, but TextBee's sending limit was reached."
        elif exc.code == 400:
            message = "Break saved, but TextBee rejected the personalized SMS batch. Check the SIM subscription ID and recipient numbers."
        else:
            message = f"Break saved, but TextBee returned HTTP {exc.code}."
        return {"status": "failed", "recipient_count": 0, "message": message}
    except URLError as exc:
        print(f"TextBee connection failed ({type(exc.reason).__name__}).", file=sys.stderr, flush=True)
        return {"status": "failed", "recipient_count": 0,
                "message": "Break saved, but the server could not connect to TextBee. Check the server's internet connection and retry."}
    except (TimeoutError, OSError) as exc:
        print(f"TextBee request failed ({type(exc).__name__}).", file=sys.stderr, flush=True)
        return {"status": "failed", "recipient_count": 0,
                "message": "Break saved, but the TextBee request timed out or failed. Retry shortly."}


def connect_db() -> sqlite3.Connection:
    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.execute("PRAGMA busy_timeout = 10000")
    return conn


def initialize_db() -> None:
    with connect_db() as conn:
        conn.executescript("""
        CREATE TABLE IF NOT EXISTS organizations (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          organization_type TEXT NOT NULL,
          phone TEXT NOT NULL,
          address TEXT NOT NULL DEFAULT '',
          estimated_workers INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS users (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          full_name TEXT NOT NULL,
          email TEXT NOT NULL COLLATE NOCASE UNIQUE,
          phone TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          password_salt TEXT NOT NULL,
          role TEXT NOT NULL CHECK(role IN ('organization_owner')),
          email_verified_at INTEGER,
          privacy_notice_version TEXT NOT NULL,
          privacy_consent_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS action_tokens (
          token_hash TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          purpose TEXT NOT NULL CHECK(purpose IN ('verify_email', 'reset_password')),
          expires_at INTEGER NOT NULL,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
        CREATE INDEX IF NOT EXISTS sessions_exp_idx ON sessions(expires_at);
        CREATE INDEX IF NOT EXISTS action_tokens_user_idx ON action_tokens(user_id);
        CREATE TABLE IF NOT EXISTS workers (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          phone TEXT NOT NULL,
          site TEXT NOT NULL,
          job_type TEXT NOT NULL,
          workload TEXT NOT NULL DEFAULT 'Standard',
          risk_level TEXT NOT NULL DEFAULT 'Moderate',
          outdoor_minutes INTEGER NOT NULL DEFAULT 0,
          last_break TEXT NOT NULL DEFAULT '',
          consent_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sites (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          address TEXT NOT NULL DEFAULT '',
          latitude REAL,
          longitude REAL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE(organization_id, name)
        );
        CREATE TABLE IF NOT EXISTS worker_consent_events (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          worker_id TEXT NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
          action TEXT NOT NULL CHECK(action IN ('consented','withdrawn')),
          method TEXT NOT NULL DEFAULT '',
          note TEXT NOT NULL DEFAULT '',
          changed_by TEXT NOT NULL,
          changed_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS consent_worker_idx ON worker_consent_events(organization_id,worker_id,changed_at DESC);
        CREATE INDEX IF NOT EXISTS workers_org_idx ON workers(organization_id, created_at);
        CREATE TABLE IF NOT EXISTS break_logs (
          id TEXT PRIMARY KEY,
          organization_id TEXT NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          site TEXT NOT NULL,
          break_date TEXT NOT NULL,
          break_time TEXT NOT NULL,
          duration_minutes INTEGER NOT NULL,
          worker_count INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'logged' CHECK(status IN ('logged','scheduled')),
          source TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','ai')),
          alert_type TEXT NOT NULL DEFAULT 'break',
          ai_rationale TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS break_logs_org_idx ON break_logs(organization_id, break_date DESC, break_time DESC);
        """)
        worker_columns = {row[1] for row in conn.execute("PRAGMA table_info(workers)")}
        if "site_id" not in worker_columns:
            conn.execute("ALTER TABLE workers ADD COLUMN site_id TEXT")
        if "consent_method" not in worker_columns:
            conn.execute("ALTER TABLE workers ADD COLUMN consent_method TEXT NOT NULL DEFAULT ''")
        break_columns = {row[1] for row in conn.execute("PRAGMA table_info(break_logs)")}
        if "source" not in break_columns:
            conn.execute("ALTER TABLE break_logs ADD COLUMN source TEXT NOT NULL DEFAULT 'manual'")
        if "alert_type" not in break_columns:
            conn.execute("ALTER TABLE break_logs ADD COLUMN alert_type TEXT NOT NULL DEFAULT 'break'")
        if "ai_rationale" not in break_columns:
            conn.execute("ALTER TABLE break_logs ADD COLUMN ai_rationale TEXT NOT NULL DEFAULT ''")
        # Bring any pre-existing worker sites into the managed site directory.
        legacy_sites = conn.execute("SELECT DISTINCT organization_id,site FROM workers WHERE trim(site)<>'' AND site_id IS NULL").fetchall()
        for item in legacy_sites:
            site = conn.execute("SELECT id FROM sites WHERE organization_id=? AND name=? COLLATE NOCASE", (item["organization_id"], item["site"])).fetchone()
            if not site:
                site_id = secrets.token_urlsafe(12)
                stamp = now()
                conn.execute("INSERT INTO sites(id,organization_id,name,address,latitude,longitude,created_at,updated_at) VALUES(?,?,?,'',NULL,NULL,?,?)",
                             (site_id, item["organization_id"], item["site"], stamp, stamp))
            else:
                site_id = site["id"]
            conn.execute("UPDATE workers SET site_id=? WHERE organization_id=? AND site=? AND site_id IS NULL", (site_id, item["organization_id"], item["site"]))


def hash_password(password: str, salt: bytes | None = None) -> tuple[str, str]:
    salt = salt or secrets.token_bytes(16)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=2**14, r=8, p=1, dklen=64)
    return digest.hex(), salt.hex()


def check_password(password: str, saved_hash: str, salt_hex: str) -> bool:
    candidate, _ = hash_password(password, bytes.fromhex(salt_hex))
    return hmac.compare_digest(candidate, saved_hash)


def token_digest(token: str) -> str:
    raw = token.encode("ascii")
    if SESSION_SECRET:
        return hmac.new(SESSION_SECRET.encode("utf-8"), raw, hashlib.sha256).hexdigest()
    return hashlib.sha256(raw).hexdigest()


def scrub_expired(conn: sqlite3.Connection) -> None:
    stamp = now()
    conn.execute("DELETE FROM sessions WHERE expires_at < ?", (stamp,))
    conn.execute("DELETE FROM action_tokens WHERE expires_at < ?", (stamp,))


def smtp_send(recipient: str, subject: str, text_body: str) -> None:
    host = os.environ.get("SMTP_HOST")
    if not host:
        if IS_PRODUCTION:
            raise RuntimeError("Email delivery is not configured.")
        print(f"\n[development email] To: {recipient}\nSubject: {subject}\n{text_body}\n", flush=True)
        return
    port = int(os.environ.get("SMTP_PORT", "587"))
    message = EmailMessage()
    message["From"] = os.environ.get("SMTP_FROM", os.environ.get("SMTP_USER", ""))
    message["To"] = recipient
    message["Subject"] = subject
    message.set_content(text_body)
    timeout = 15
    if port == 465:
        with smtplib.SMTP_SSL(host, port, timeout=timeout) as client:
            _smtp_auth(client)
            client.send_message(message)
    else:
        with smtplib.SMTP(host, port, timeout=timeout) as client:
            client.ehlo()
            client.starttls()
            client.ehlo()
            _smtp_auth(client)
            client.send_message(message)


def _smtp_auth(client: smtplib.SMTP) -> None:
    username = os.environ.get("SMTP_USER")
    password = os.environ.get("SMTP_PASSWORD")
    if username and password:
        client.login(username, password)


def issue_action_token(user_id: str, purpose: str) -> str:
    token = secrets.token_urlsafe(32)
    with connect_db() as conn:
        conn.execute("DELETE FROM action_tokens WHERE user_id = ? AND purpose = ?", (user_id, purpose))
        conn.execute("INSERT INTO action_tokens(token_hash,user_id,purpose,expires_at,created_at) VALUES(?,?,?,?,?)",
                     (token_digest(token), user_id, purpose, now() + TOKEN_LIFETIME, now()))
    return token


class AppServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True


class Handler(BaseHTTPRequestHandler):
    server_version = "JibonGuard/1.0"
    sys_version = ""

    def log_message(self, fmt: str, *args: object) -> None:
        # Avoid logging query strings because action tokens are query parameters.
        safe_path = urlparse(self.path).path
        code = args[-1] if args else ""
        sys.stderr.write(f"{self.address_string()} {safe_path} {code}\n")

    def end_headers(self) -> None:
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "strict-origin-when-cross-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.send_header("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
        if IS_PRODUCTION:
            self.send_header("Strict-Transport-Security", "max-age=31536000")
        self.send_header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data: https://tile.openstreetmap.org; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'")
        super().end_headers()

    def send_json(self, status: int, body: dict, headers: list[tuple[str, str]] | None = None) -> None:
        payload = json.dumps(body, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(payload)))
        if headers:
            for key, value in headers:
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(payload)

    def send_page(self, filename: str) -> None:
        path = ROOT / filename
        try:
            data = path.read_bytes()
        except OSError:
            self.send_error(404)
            return
        self.send_response(200)
        content_type = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        self.send_header("Content-Type", f"{content_type}; charset=utf-8" if content_type.startswith("text/") else content_type)
        self.send_header("Cache-Control", "no-store" if filename in {"dashboard.html", "account.html", "login.html", "signup.html", "verify.html", "resend-verification.html"} else "no-cache")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def read_json(self) -> dict:
        try:
            size = int(self.headers.get("Content-Length", "0"))
            if size < 1 or size > 1_048_576:
                raise ValueError("Invalid request size.")
            body = json.loads(self.rfile.read(size))
            if not isinstance(body, dict):
                raise ValueError("JSON object expected.")
            return body
        except (ValueError, json.JSONDecodeError, UnicodeDecodeError):
            raise ValueError("Please submit a valid form.")

    def cookies(self) -> SimpleCookie:
        cookie = SimpleCookie()
        cookie.load(self.headers.get("Cookie", ""))
        return cookie

    def set_cookie(self, name: str, value: str, *, http_only: bool, max_age: int | None = None) -> str:
        parts = [f"{name}={value}", "Path=/", "SameSite=Lax"]
        if http_only:
            parts.append("HttpOnly")
        if IS_PRODUCTION:
            parts.append("Secure")
        if max_age is not None:
            parts.append(f"Max-Age={max_age}")
        return "; ".join(parts)

    def ensure_csrf(self) -> tuple[str, str | None]:
        cookies = self.cookies()
        existing = cookies.get(CSRF_COOKIE)
        if existing and re.fullmatch(r"[A-Za-z0-9_-]{32,64}", existing.value):
            return existing.value, None
        value = secrets.token_urlsafe(32)
        return value, self.set_cookie(CSRF_COOKIE, value, http_only=False, max_age=REMEMBER_LIFETIME)

    def check_csrf(self) -> bool:
        cookie = self.cookies().get(CSRF_COOKIE)
        header = self.headers.get("X-CSRF-Token", "")
        return bool(cookie and header and hmac.compare_digest(cookie.value, header))

    def check_origin(self) -> bool:
        origin = self.headers.get("Origin")
        if not origin:
            return False
        try:
            parsed = urlparse(origin)
            origin_value = parsed.scheme + "://" + parsed.netloc
            if origin_value == PUBLIC_ORIGIN:
                return True
            if not IS_PRODUCTION and parsed.scheme in {"http", "https"}:
                return parsed.port == PORT and parsed.netloc.lower() == self.headers.get("Host", "").lower()
            return False
        except Exception:
            return False

    def rate_allowed(self, bucket: str, limit: int = 5, window: int = 900) -> bool:
        address = self.client_address[0]
        key = (bucket, address)
        cutoff = time.time() - window
        entries = [stamp for stamp in RATE_LIMITS.get(key, []) if stamp >= cutoff]
        if len(entries) >= limit:
            RATE_LIMITS[key] = entries
            return False
        entries.append(time.time())
        RATE_LIMITS[key] = entries
        return True

    def session_user(self) -> sqlite3.Row | None:
        session = self.cookies().get(SESSION_COOKIE)
        if not session:
            return None
        with connect_db() as conn:
            scrub_expired(conn)
            row = conn.execute("""SELECT u.id,u.organization_id,u.full_name,u.email,u.phone,u.role,
                                      u.email_verified_at,o.name AS organization_name,o.organization_type
                                 FROM sessions s JOIN users u ON u.id=s.user_id
                                 JOIN organizations o ON o.id=u.organization_id
                                 WHERE s.token_hash=? AND s.expires_at>=?""",
                               (token_digest(session.value), now())).fetchone()
            return row

    def require_csrf_and_origin(self) -> bool:
        if not self.check_origin():
            self.send_json(403, {"error": "Request origin could not be verified. Reload the page and try again."})
            return False
        if not self.check_csrf():
            self.send_json(403, {"error": "Your security token expired. Reload the page and try again."})
            return False
        return True

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/auth/csrf":
            csrf, cookie = self.ensure_csrf()
            self.send_json(200, {"csrf_token": csrf}, [("Set-Cookie", cookie)] if cookie else None)
            return
        if path == "/api/auth/me":
            user = self.session_user()
            if not user:
                self.send_json(401, {"authenticated": False})
                return
            self.send_json(200, {"authenticated": True, "user": dict(user)})
            return
        if path == "/api/workers":
            user = self.session_user()
            if not user:
                self.send_json(401, {"error": "Sign in to manage workers."})
                return
            with connect_db() as conn:
                workers = conn.execute("""SELECT id,name,phone,site,site_id,job_type,workload,risk_level,
                    outdoor_minutes,last_break,consent_at,consent_method,
                    COALESCE((SELECT action FROM worker_consent_events e WHERE e.worker_id=workers.id ORDER BY e.changed_at DESC,e.rowid DESC LIMIT 1),'pending') AS consent_status,
                    created_at,updated_at FROM workers
                    WHERE organization_id=? ORDER BY name COLLATE NOCASE""", (user["organization_id"],)).fetchall()
            self.send_json(200, {"workers": [dict(row) for row in workers]})
            return
        if path == "/api/sites":
            user = self.session_user()
            if not user:
                self.send_json(401, {"error": "Sign in to manage sites."})
                return
            with connect_db() as conn:
                sites = conn.execute("SELECT id,name,address,latitude,longitude,created_at,updated_at FROM sites WHERE organization_id=? ORDER BY name COLLATE NOCASE", (user["organization_id"],)).fetchall()
            self.send_json(200, {"sites": [dict(row) for row in sites]})
            return
        if path.startswith("/api/sites/") and path.endswith("/weather"):
            user = self.session_user()
            if not user:
                self.send_json(401, {"error": "Sign in to view site weather."})
                return
            site_id = path[len("/api/sites/"):-len("/weather")].strip("/")
            self.site_weather(user, site_id)
            return
        if path == "/api/geocode/reverse":
            user = self.session_user()
            if not user:
                self.send_json(401, {"error": "Sign in to look up a site location."})
                return
            self.reverse_geocode(parse_qs(parsed.query))
            return
        if path == "/api/geocode/search":
            user = self.session_user()
            if not user:
                self.send_json(401, {"error": "Sign in to search for a site location."})
                return
            self.search_geocode(parse_qs(parsed.query))
            return
        if path == "/api/breaks":
            user = self.session_user()
            if not user:
                self.send_json(401, {"error": "Sign in to view the break schedule."})
                return
            selected_date = parse_qs(parsed.query).get("date", [""])[0]
            if selected_date and not re.fullmatch(r"\d{4}-\d{2}-\d{2}", selected_date):
                self.send_json(400, {"error": "Enter a valid date."})
                return
            with connect_db() as conn:
                breaks = conn.execute("""SELECT id,title,site,break_date,break_time,duration_minutes,worker_count,status,source,alert_type,ai_rationale,created_at
                    FROM break_logs WHERE organization_id=? ORDER BY break_date DESC,break_time DESC,created_at DESC""",
                    (user["organization_id"],)).fetchall()
                total = conn.execute("SELECT COUNT(*) FROM break_logs WHERE organization_id=?", (user["organization_id"],)).fetchone()[0]
                today = conn.execute("SELECT COUNT(*) FROM break_logs WHERE organization_id=? AND break_date=? AND status='logged'", (user["organization_id"], selected_date)).fetchone()[0] if selected_date else 0
            self.send_json(200, {"breaks": [dict(row) for row in breaks], "total": total, "date_total": today})
            return
        if path == "/api/privacy/export":
            user = self.session_user()
            if not user:
                self.send_json(401, {"error": "Sign in to download your account data."})
                return
            with connect_db() as conn:
                organization = conn.execute("SELECT name,organization_type,phone,address,estimated_workers,created_at FROM organizations WHERE id=?", (user["organization_id"],)).fetchone()
                consent = conn.execute("SELECT privacy_notice_version,privacy_consent_at,created_at FROM users WHERE id=?", (user["id"],)).fetchone()
            with connect_db() as conn:
                workers = conn.execute("SELECT id,name,phone,site,site_id,job_type,workload,risk_level,outdoor_minutes,last_break,consent_at,consent_method,created_at,updated_at FROM workers WHERE organization_id=? ORDER BY name COLLATE NOCASE", (user["organization_id"],)).fetchall()
                breaks = conn.execute("SELECT id,title,site,break_date,break_time,duration_minutes,worker_count,status,source,alert_type,ai_rationale,created_at FROM break_logs WHERE organization_id=? ORDER BY break_date DESC,break_time DESC", (user["organization_id"],)).fetchall()
                sites = conn.execute("SELECT id,name,address,latitude,longitude,created_at,updated_at FROM sites WHERE organization_id=? ORDER BY name COLLATE NOCASE", (user["organization_id"],)).fetchall()
                consent_events = conn.execute("SELECT worker_id,action,method,note,changed_by,changed_at FROM worker_consent_events WHERE organization_id=? ORDER BY changed_at DESC,rowid DESC", (user["organization_id"],)).fetchall()
            self.send_json(200, {"account": dict(user), "organization": dict(organization), "workers": [dict(row) for row in workers], "sites": [dict(row) for row in sites], "worker_consent_events": [dict(row) for row in consent_events], "break_logs": [dict(row) for row in breaks], "privacy": dict(consent), "exported_at": utc_iso()}, [("Content-Disposition", "attachment; filename=jibonguard-account-data.json")])
            return
        if path == "/verify.html":
            self.send_page("verify.html")
            return
        if path == "/resend-verification.html":
            self.send_page("resend-verification.html")
            return
        if path == "/login.html":
            if self.session_user():
                self.send_response(303)
                self.send_header("Location", "/dashboard.html")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            self.send_page("login.html")
            return
        if path == "/signup.html":
            if self.session_user():
                self.send_response(303)
                self.send_header("Location", "/dashboard.html")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            self.send_page("signup.html")
            return
        if path == "/privacy.html":
            self.send_page("privacy.html")
            return
        if path == "/account.html":
            if not self.session_user():
                self.send_response(303)
                self.send_header("Location", "/login.html?next=%2Faccount.html")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            self.send_page("account.html")
            return
        if path == "/dashboard.html":
            if not self.session_user():
                self.send_response(303)
                self.send_header("Location", "/login.html?next=%2Fdashboard.html")
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                return
            self.send_page("dashboard.html")
            return
        if path == "/ai-chat.js":
            self.send_page("ai-chat.js")
            return
        if path == "/" or path == "/index.html":
            self.send_page("index.html")
            return
        if path.startswith("/api/"):
            self.send_json(404, {"error": "Not found."})
            return
        name = path.lstrip("/")
        if name not in STATIC_FILES:
            self.send_error(404)
            return
        self.send_page(name)

    def do_POST(self) -> None:
        if not self.require_csrf_and_origin():
            return
        path = urlparse(self.path).path
        try:
            data = self.read_json()
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
            return
        routes = {
            "/api/workers": self.create_worker,
            "/api/workers/import": self.import_workers,
            "/api/workers/consent": self.record_worker_consent,
            "/api/sites": self.create_site,
            "/api/breaks": self.create_break_log,
            "/api/breaks/ai-schedule": self.ai_schedule_breaks,
            "/api/ai/chat": self.ai_chat,
            "/api/auth/signup": self.signup,
            "/api/auth/verify": self.verify_email,
            "/api/auth/resend-verification": self.resend_verification,
            "/api/auth/login": self.login,
            "/api/auth/logout": self.logout,
            "/api/auth/forgot": self.forgot_password,
            "/api/auth/reset": self.reset_password,
            "/api/privacy/delete-account": self.delete_account,
        }
        handler = routes.get(path)
        if not handler:
            self.send_json(404, {"error": "Not found."})
            return
        try:
            handler(data)
        except sqlite3.IntegrityError:
            message = "A site with this name already exists in your organization." if path == "/api/sites" else "An account with these details already exists."
            self.send_json(409, {"error": message})
        except sqlite3.Error as exc:
            print(f"Database error ({path}): {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
            self.send_json(503, {"error": "The database could not save this change. Restart the server and try again."})
        except (RuntimeError, smtplib.SMTPException, OSError) as exc:
            print(f"Service error ({path}): {type(exc).__name__}", file=sys.stderr, flush=True)
            self.send_json(503, {"error": "The request could not be completed right now. Please try again later."})

    def worker_values(self, data: dict, organization_id: str) -> tuple[str, str, str, str, str, str] | None:
        name = str(data.get("name", "")).strip()
        phone = normalize_digits(data.get("phone", "")).strip()
        site_id = str(data.get("site_id", "")).strip()
        # CSVs may use the saved site's exact name; this still resolves only to an existing site.
        legacy_site_name = str(data.get("site", "")).strip()
        job_type = str(data.get("job_type", "")).strip()
        workload = str(data.get("workload", "Standard")).strip()
        if not name or len(name) > 120 or not re.fullmatch(r"[+()0-9 .-]{7,24}", phone):
            return None
        if not job_type or len(job_type) > 120:
            return None
        if workload not in {"Light", "Standard", "Heavy"}:
            return None
        with connect_db() as conn:
            site = conn.execute("SELECT id,name FROM sites WHERE organization_id=? AND (id=? OR name=? COLLATE NOCASE)", (organization_id, site_id, legacy_site_name)).fetchone()
        if not site:
            raise ValueError("Choose a worksite from your saved Sites list. Create the site first if it is not listed.")
        return name, phone, site["id"], site["name"], job_type, workload

    def create_worker(self, data: dict) -> None:
        user = self.session_user()
        if not user:
            self.send_json(401, {"error": "Sign in to manage workers."})
            return
        try:
            values = self.worker_values(data, user["organization_id"])
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
            return
        if not values:
            self.send_json(400, {"error": "Enter a name, valid phone, site, job type, and workload."})
            return
        worker_id = secrets.token_urlsafe(12)
        stamp = now()
        with connect_db() as conn:
            conn.execute("""INSERT INTO workers(id,organization_id,name,phone,site_id,site,job_type,workload,created_at,updated_at)
                VALUES(?,?,?,?,?,?,?,?,?,?)""", (worker_id, user["organization_id"], values[0], values[1], values[2], values[3], values[4], values[5], stamp, stamp))
            worker = conn.execute("SELECT * FROM workers WHERE id=?", (worker_id,)).fetchone()
        self.send_json(201, {"worker": dict(worker)})

    def import_workers(self, data: dict) -> None:
        user = self.session_user()
        if not user:
            self.send_json(401, {"error": "Sign in to manage workers."})
            return
        entries = data.get("workers")
        if not isinstance(entries, list) or not entries or len(entries) > 500:
            self.send_json(400, {"error": "Choose a CSV with between 1 and 500 worker rows."})
            return
        try:
            clean = [self.worker_values(row, user["organization_id"]) if isinstance(row, dict) else None for row in entries]
        except ValueError as exc:
            self.send_json(400, {"error": f"{exc} No rows were imported."})
            return
        if any(row is None for row in clean):
            self.send_json(400, {"error": "The CSV contains invalid worker data. Check name, phone, site, job type, and workload; no rows were imported."})
            return
        stamp = now()
        with connect_db() as conn:
            for values in clean:
                conn.execute("""INSERT INTO workers(id,organization_id,name,phone,site_id,site,job_type,workload,created_at,updated_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?)""", (secrets.token_urlsafe(12), user["organization_id"], values[0], values[1], values[2], values[3], values[4], values[5], stamp, stamp))
        self.send_json(201, {"imported": len(clean)})

    def site_values(self, data: dict) -> tuple[str, str, float, float] | None:
        name = str(data.get("name", "")).strip()
        address = str(data.get("address", "")).strip()
        try:
            latitude, longitude = float(data.get("latitude")), float(data.get("longitude"))
        except (TypeError, ValueError):
            return None
        if (not name or len(name) > 120 or len(address) > 240
                or not -90 <= latitude <= 90 or not -180 <= longitude <= 180):
            return None
        return name, address, latitude, longitude

    def create_site(self, data: dict) -> None:
        user = self.session_user()
        if not user:
            self.send_json(401, {"error": "Sign in to manage sites."})
            return
        values = self.site_values(data)
        if not values:
            self.send_json(400, {"error": "Enter a site name, address (optional), and valid latitude/longitude for weather."})
            return
        stamp, site_id = now(), secrets.token_urlsafe(12)
        with connect_db() as conn:
            duplicate = conn.execute("SELECT 1 FROM sites WHERE organization_id=? AND name=? COLLATE NOCASE", (user["organization_id"], values[0])).fetchone()
            if duplicate:
                self.send_json(409, {"error": "A site with this name already exists in your organization."})
                return
            conn.execute("INSERT INTO sites(id,organization_id,name,address,latitude,longitude,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)",
                         (site_id, user["organization_id"], *values, stamp, stamp))
            site = conn.execute("SELECT id,name,address,latitude,longitude,created_at,updated_at FROM sites WHERE id=?", (site_id,)).fetchone()
        self.send_json(201, {"site": dict(site)})

    def record_worker_consent(self, data: dict) -> None:
        user = self.session_user()
        if not user:
            self.send_json(401, {"error": "Sign in to manage worker consent."})
            return
        worker_id = str(data.get("worker_id", "")).strip()
        action = str(data.get("action", "")).strip()
        method = str(data.get("method", "")).strip()
        note = str(data.get("note", "")).strip()
        acknowledged = data.get("worker_agreed") is True
        if action not in {"consented", "withdrawn"} or len(note) > 500:
            self.send_json(400, {"error": "Choose a valid consent action and keep notes under 500 characters."})
            return
        if action == "consented" and (method not in {"written", "verbal"} or not acknowledged):
            self.send_json(400, {"error": "Record consent only after the worker has received the notice and explicitly agreed."})
            return
        if action == "withdrawn":
            method = ""
        stamp = now()
        with connect_db() as conn:
            worker = conn.execute("SELECT id FROM workers WHERE id=? AND organization_id=?", (worker_id, user["organization_id"])).fetchone()
            if not worker:
                self.send_json(404, {"error": "Worker not found."})
                return
            conn.execute("UPDATE workers SET consent_at=?,consent_method=?,updated_at=? WHERE id=? AND organization_id=?",
                         (stamp if action == "consented" else None, method, stamp, worker_id, user["organization_id"]))
            conn.execute("INSERT INTO worker_consent_events(id,organization_id,worker_id,action,method,note,changed_by,changed_at) VALUES(?,?,?,?,?,?,?,?)",
                         (secrets.token_urlsafe(12), user["organization_id"], worker_id, action, method, note, user["id"], stamp))
            record = conn.execute("SELECT id,name,consent_at,consent_method,updated_at FROM workers WHERE id=?", (worker_id,)).fetchone()
        worker_data = dict(record)
        worker_data["consent_status"] = action
        self.send_json(200, {"worker": worker_data, "message": "Consent status updated and logged."})

    def search_geocode(self, query: dict[str, list[str]]) -> None:
        global PHOTON_LAST_REQUEST
        search_text = " ".join(query.get("q", [""])[0].split())
        if len(search_text) < 2 or len(search_text) > 200:
            self.send_json(400, {"error": "Enter at least 2 characters to search for a place."})
            return
        cache_key = search_text.casefold()
        with PHOTON_LOCK:
            cached = PHOTON_CACHE.get(cache_key)
            if cached and cached[0] > time.time():
                self.send_json(200, cached[1])
                return
            request_at = max(time.monotonic(), PHOTON_LAST_REQUEST + 0.55)
            PHOTON_LAST_REQUEST = request_at
        delay = request_at - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        params = urlencode({"q": search_text, "limit": 5, "lang": "en"})
        endpoint = PHOTON_API_URL if PHOTON_API_URL.endswith("/") else PHOTON_API_URL + "/"
        request = Request(
            f"{endpoint}?{params}",
            headers={"Accept": "application/json", "User-Agent": f"JibonGuard/1.0 (site location search; {PUBLIC_ORIGIN})", "Referer": PUBLIC_ORIGIN + "/dashboard.html"},
        )
        try:
            with urlopen(request, timeout=8) as response:
                payload = json.loads(response.read(1_000_000).decode("utf-8"))
            if not isinstance(payload, dict) or not isinstance(payload.get("features"), list):
                raise ValueError("Unexpected place search response")
        except HTTPError as error:
            if error.code == 429:
                self.send_json(503, {"error": "Place suggestions are busy. Wait a few seconds and try again."})
            else:
                self.send_json(502, {"error": f"Place search failed (HTTP {error.code}). Try again shortly."})
            return
        except (URLError, TimeoutError, ValueError, json.JSONDecodeError):
            self.send_json(502, {"error": "Could not retrieve place suggestions. Check your connection or select a point directly on the map."})
            return
        results = []
        for feature in payload["features"][:5]:
            try:
                coordinates = feature["geometry"]["coordinates"]
                longitude, latitude = float(coordinates[0]), float(coordinates[1])
                properties = feature.get("properties") if isinstance(feature.get("properties"), dict) else {}
            except (KeyError, IndexError, TypeError, ValueError):
                continue
            if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
                continue
            suggested_name = str(properties.get("name") or properties.get("street") or properties.get("city") or "").strip()
            street = " ".join(str(properties.get(key, "")).strip() for key in ("housenumber", "street") if properties.get(key))
            address_parts = [suggested_name, street, properties.get("postcode"), properties.get("city"),
                             properties.get("district"), properties.get("county"), properties.get("state"), properties.get("country")]
            display_parts = []
            for part in address_parts:
                part = " ".join(str(part or "").split())
                if part and part.casefold() not in {value.casefold() for value in display_parts}:
                    display_parts.append(part)
            display_name = ", ".join(display_parts)
            if display_name:
                results.append({"latitude": latitude, "longitude": longitude,
                                "display_name": display_name[:500], "name": str(suggested_name)[:120]})
        payload = {"results": results}
        with PHOTON_LOCK:
            PHOTON_CACHE[cache_key] = (time.time() + 24 * 60 * 60, payload)
            if len(PHOTON_CACHE) > 1000:
                expired = [key for key, value in PHOTON_CACHE.items() if value[0] <= time.time()]
                for key in expired:
                    PHOTON_CACHE.pop(key, None)
                while len(PHOTON_CACHE) > 1000:
                    PHOTON_CACHE.pop(next(iter(PHOTON_CACHE)))
        self.send_json(200, payload)

    def reverse_geocode(self, query: dict[str, list[str]]) -> None:
        global NOMINATIM_LAST_REQUEST
        try:
            latitude = float(query.get("lat", [""])[0])
            longitude = float(query.get("lon", [""])[0])
        except (TypeError, ValueError):
            self.send_json(400, {"error": "Choose a valid point on the map."})
            return
        if not (-90 <= latitude <= 90 and -180 <= longitude <= 180):
            self.send_json(400, {"error": "Choose a valid point on the map."})
            return
        cache_key = f"{latitude:.5f},{longitude:.5f}"
        with NOMINATIM_LOCK:
            cached = NOMINATIM_CACHE.get(cache_key)
            if cached and cached[0] > time.time():
                self.send_json(200, cached[1])
                return
            request_at = max(time.monotonic(), NOMINATIM_LAST_REQUEST + 1.05)
            NOMINATIM_LAST_REQUEST = request_at
        delay = request_at - time.monotonic()
        if delay > 0:
            time.sleep(delay)
        params = urlencode({"format": "jsonv2", "lat": latitude, "lon": longitude, "zoom": 18, "addressdetails": 1})
        request = Request(
            f"https://nominatim.openstreetmap.org/reverse?{params}",
            headers={"Accept": "application/json", "User-Agent": f"JibonGuard/1.0 (site location picker; {PUBLIC_ORIGIN})", "Referer": PUBLIC_ORIGIN + "/dashboard.html"},
        )
        try:
            with urlopen(request, timeout=10) as response:
                result = json.loads(response.read(1_000_000).decode("utf-8"))
            if not isinstance(result, dict) or not result.get("display_name"):
                self.send_json(404, {"error": "OpenStreetMap did not return an address for this point. You can still save the coordinates."})
                return
        except (HTTPError, URLError, TimeoutError, ValueError, json.JSONDecodeError):
            self.send_json(502, {"error": "Could not retrieve this place from OpenStreetMap. You can still save the coordinates."})
            return
        address = result.get("address") if isinstance(result.get("address"), dict) else {}
        suggested_name = (result.get("name") or address.get("building") or address.get("amenity")
                          or address.get("road") or address.get("neighbourhood") or address.get("suburb")
                          or address.get("village") or address.get("town") or address.get("city") or "")
        payload = {"latitude": latitude, "longitude": longitude, "display_name": result["display_name"],
                   "name": str(suggested_name)[:120], "address": address}
        with NOMINATIM_LOCK:
            NOMINATIM_CACHE[cache_key] = (time.time() + 7 * 24 * 60 * 60, payload)
            if len(NOMINATIM_CACHE) > 2000:
                expired = [key for key, value in NOMINATIM_CACHE.items() if value[0] <= time.time()]
                for key in expired:
                    NOMINATIM_CACHE.pop(key, None)
        self.send_json(200, payload)

    def site_weather(self, user: sqlite3.Row, site_id: str) -> None:
        with connect_db() as conn:
            site = conn.execute("SELECT id,name,address,latitude,longitude FROM sites WHERE id=? AND organization_id=?", (site_id, user["organization_id"])).fetchone()
        if not site:
            self.send_json(404, {"error": "Site not found."})
            return
        if site["latitude"] is None or site["longitude"] is None:
            self.send_json(422, {"error": "Add this site's latitude and longitude in Site settings to load weather."})
            return
        cache_key = f"{site_id}:{site['latitude']}:{site['longitude']}"
        cached = WEATHER_CACHE.get(cache_key)
        if cached and cached[0] > time.time():
            self.send_json(200, {"site_id": site_id, "weather": cached[1], "cached": True})
            return
        params = {
            "latitude": site["latitude"],
            "longitude": site["longitude"],
            "current": "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation,weather_code,wind_speed_10m,wind_direction_10m,wind_gusts_10m",
            "hourly": "temperature_2m,relative_humidity_2m,apparent_temperature,precipitation_probability,precipitation,weather_code,wind_speed_10m",
            "forecast_days": 1,
            "timezone": "auto",
            "temperature_unit": "celsius",
            "wind_speed_unit": "ms",
            "precipitation_unit": "mm",
        }
        endpoint_host = "customer-api.open-meteo.com" if OPEN_METEO_API_KEY else "api.open-meteo.com"
        if OPEN_METEO_API_KEY:
            params["apikey"] = OPEN_METEO_API_KEY
        endpoint = f"https://{endpoint_host}/v1/forecast?{urlencode(params)}"
        request = Request(endpoint, headers={"Accept": "application/json", "User-Agent": "JibonGuard/1.0"})
        try:
            with urlopen(request, timeout=12) as response:
                raw = json.loads(response.read(2_000_000).decode("utf-8"))
            if not isinstance(raw, dict) or not isinstance(raw.get("current"), dict):
                detail = raw.get("reason") if isinstance(raw, dict) else None
                raise ValueError(str(detail or "The weather provider returned an incomplete response."))
        except HTTPError as exc:
            if exc.code == 429:
                message = "Open-Meteo request limit reached. Weather will be available again shortly."
            elif exc.code in {401, 403}:
                message = "Open-Meteo rejected the customer API key. Check OPEN_METEO_API_KEY in .env."
            else:
                message = f"Open-Meteo could not return weather right now (HTTP {exc.code})."
            self.send_json(502, {"error": message})
            return
        except (URLError, TimeoutError):
            self.send_json(502, {"error": "Could not reach Open-Meteo. Check the server's internet connection and try again."})
            return
        except (ValueError, json.JSONDecodeError) as exc:
            self.send_json(502, {"error": f"Open-Meteo returned invalid weather data: {exc}"})
            return

        current = raw["current"]
        weather = {
            "current": {
                "temperature": current.get("temperature_2m"),
                "summary": open_meteo_summary(current.get("weather_code")),
                "feels_like": current.get("apparent_temperature"),
                "humidity": current.get("relative_humidity_2m"),
                "precipitation": current.get("precipitation"),
                "wind": {"speed": current.get("wind_speed_10m"), "gusts": current.get("wind_gusts_10m"),
                         "direction": current.get("wind_direction_10m")},
            },
            "hourly": {"data": []},
        }
        hourly = raw.get("hourly") if isinstance(raw.get("hourly"), dict) else {}
        hours = hourly.get("time") if isinstance(hourly.get("time"), list) else []
        fields = {
            "temperature": hourly.get("temperature_2m") or [],
            "humidity": hourly.get("relative_humidity_2m") or [],
            "feels_like": hourly.get("apparent_temperature") or [],
            "precipitation_probability": hourly.get("precipitation_probability") or [],
            "precipitation": hourly.get("precipitation") or [],
            "weather_code": hourly.get("weather_code") or [],
            "wind_speed": hourly.get("wind_speed_10m") or [],
        }
        for index, stamp in enumerate(hours):
            try:
                hour_stamp = datetime.fromisoformat(str(stamp))
            except ValueError:
                continue
            if hour_stamp.minute != 0 or hour_stamp.hour % 2:
                continue
            hour = hour_stamp.hour
            label = f"{hour % 12 or 12} {'AM' if hour < 12 else 'PM'}"
            weather["hourly"]["data"].append({
                "time": stamp,
                "label": label,
                "temperature": fields["temperature"][index] if index < len(fields["temperature"]) else None,
                "humidity": fields["humidity"][index] if index < len(fields["humidity"]) else None,
                "feels_like": fields["feels_like"][index] if index < len(fields["feels_like"]) else None,
                "precipitation_probability": fields["precipitation_probability"][index] if index < len(fields["precipitation_probability"]) else None,
                "precipitation": fields["precipitation"][index] if index < len(fields["precipitation"]) else None,
                "summary": open_meteo_summary(fields["weather_code"][index] if index < len(fields["weather_code"]) else None),
                "wind_speed": fields["wind_speed"][index] if index < len(fields["wind_speed"]) else None,
            })
        WEATHER_CACHE[cache_key] = (time.time() + 600, weather)
        self.send_json(200, {"site_id": site_id, "weather": weather, "cached": False})

    def ai_chat(self, data: dict) -> None:
        user = self.session_user()
        if not user:
            self.send_json(401, {"error": "Sign in to use the JibonGuard assistant."})
            return
        if not self.rate_allowed("gemini-chat", limit=20, window=3600):
            self.send_json(429, {"error": "Chat limit reached. Try again in a little while."})
            return
        messages = data.get("messages")
        if not isinstance(messages, list) or not messages or len(messages) > 12:
            self.send_json(400, {"error": "Send a short chat message and try again."})
            return
        contents = []
        for message in messages[-10:]:
            if not isinstance(message, dict) or message.get("role") not in {"user", "model"}:
                continue
            text = str(message.get("text", "")).strip()
            if not text or len(text) > 1200:
                continue
            contents.append({"role": message["role"], "parts": [{"text": text}]})
        if not contents or contents[-1]["role"] != "user":
            self.send_json(400, {"error": "Enter a message to continue."})
            return
        instruction = (
            "You are JibonGuard's in-app assistant. Help organization administrators understand "
            "the dashboard, site weather, worker consent, break logs, and practical heat and weather "
            "safety. Be concise and clear. Do not claim to see private organization records or live "
            "weather unless supplied in the conversation. Never give a medical diagnosis or claim "
            "an emergency is safe; direct urgent situations to local emergency services and official "
            "instructions. Do not ask for passwords, API keys, or personal worker details."
        )
        try:
            answer = gemini_generate(contents, instruction)
        except RuntimeError as exc:
            self.send_json(503, {"error": str(exc)})
            return
        self.send_json(200, {"reply": answer})

    def ai_schedule_breaks(self, data: dict) -> None:
        user = self.session_user()
        if not user:
            self.send_json(401, {"error": "Sign in to schedule AI break logs."})
            return
        if not self.rate_allowed("gemini-schedule", limit=4, window=3600):
            self.send_json(429, {"error": "AI scheduling limit reached. Try again later."})
            return
        if not GEMINI_API_KEY:
            self.send_json(503, {"error": "Gemini is not configured. Set GEMINI_API_KEY in JibonGuard AI/.env and restart the server."})
            return
        with connect_db() as conn:
            sites = conn.execute("SELECT id,name,address,latitude,longitude FROM sites WHERE organization_id=? ORDER BY name COLLATE NOCASE LIMIT 20", (user["organization_id"],)).fetchall()
        if not sites:
            self.send_json(422, {"error": "Add a saved worksite with map coordinates before asking AI to schedule breaks."})
            return
        if not any(site["latitude"] is not None and site["longitude"] is not None for site in sites):
            self.send_json(422, {"error": "Add latitude and longitude to at least one saved worksite before AI scheduling."})
            return
        pending = []
        ai_errors = []
        for site in sites:
            if site["latitude"] is None or site["longitude"] is None:
                continue
            try:
                weather = fetch_ai_weather(site)
                current = weather["current"]
                hourly = weather.get("hourly", {})
                forecast = []
                times = hourly.get("time", [])
                for index, stamp in enumerate(times[:24]):
                    if index % 2:
                        continue
                    forecast.append({
                        "time": stamp,
                        "temperature_c": (hourly.get("temperature_2m") or [])[index] if index < len(hourly.get("temperature_2m") or []) else None,
                        "feels_like_c": (hourly.get("apparent_temperature") or [])[index] if index < len(hourly.get("apparent_temperature") or []) else None,
                        "rain_probability_percent": (hourly.get("precipitation_probability") or [])[index] if index < len(hourly.get("precipitation_probability") or []) else None,
                        "weather_code": (hourly.get("weather_code") or [])[index] if index < len(hourly.get("weather_code") or []) else None,
                        "wind_speed_m_s": (hourly.get("wind_speed_10m") or [])[index] if index < len(hourly.get("wind_speed_10m") or []) else None,
                    })
                weather_context = {
                    "site": site["name"], "address": site["address"], "timezone": weather.get("timezone", "UTC"),
                    "current": {key: current.get(key) for key in ("temperature_2m", "apparent_temperature", "relative_humidity_2m", "precipitation", "weather_code", "wind_speed_10m", "wind_gusts_10m")},
                    "next_hours": forecast,
                }
                instruction = (
                    "You recommend at most one safety log for this site using only the supplied Open-Meteo data. "
                    "Return JSON with exactly: action (schedule or no_schedule), alert_type (break, rain, or storm), "
                    "duration_minutes (10, 15, or 20), rationale (under 35 words). Use storm for thunderstorms or "
                    "dangerous wind, rain for substantial rain risk, and a routine water/shade break for dangerous heat. "
                    "Choose no_schedule only when no weather safety action is warranted. Weather cannot establish an "
                    "earthquake; never select earthquake. Do not invent observations."
                )
                raw_decision = gemini_generate(
                    [{"role": "user", "parts": [{"text": json.dumps(weather_context, ensure_ascii=False)}]}],
                    instruction, json_response=True,
                )
                decision = json.loads(raw_decision)
                if not isinstance(decision, dict):
                    continue
                code = current.get("weather_code")
                gusts = current.get("wind_gusts_10m")
                apparent = current.get("apparent_temperature")
                max_rain = max((item["rain_probability_percent"] for item in forecast if isinstance(item["rain_probability_percent"], (int, float))), default=0)
                # Deterministic guardrails prevent a model from dismissing clear severe conditions.
                if code in {95, 96, 99} or isinstance(gusts, (int, float)) and gusts >= 20:
                    decision.update(action="schedule", alert_type="storm")
                elif isinstance(max_rain, (int, float)) and max_rain >= 70:
                    decision.update(action="schedule", alert_type="rain")
                elif isinstance(apparent, (int, float)) and apparent >= 35:
                    decision.update(action="schedule", alert_type="break")
                if decision.get("action") != "schedule":
                    continue
                alert_type = decision.get("alert_type")
                if alert_type not in {"break", "rain", "storm"}:
                    continue
                duration = decision.get("duration_minutes")
                duration = duration if duration in {10, 15, 20} else 15
                title = BREAK_ALERTS.get(alert_type, "Water and shade break")
                rationale = re.sub(r"\s+", " ", str(decision.get("rationale", "Weather safety break recommended."))).strip()[:300]
                try:
                    local_now = datetime.fromisoformat(str(current.get("time", "")))
                    if local_now.tzinfo:
                        local_now = local_now.astimezone(ZoneInfo(weather.get("timezone", "UTC")))
                except (KeyError, ValueError, TypeError):
                    try:
                        local_now = datetime.now(ZoneInfo(weather.get("timezone", "UTC")))
                    except (KeyError, ValueError, TypeError):
                        local_now = datetime.now(timezone.utc)
                scheduled = local_now.replace(minute=0, second=0, microsecond=0)
                if scheduled <= local_now + timedelta(minutes=20):
                    scheduled += timedelta(hours=1)
                while scheduled.hour % 2:
                    scheduled += timedelta(hours=1)
                pending.append({"site": site, "title": title, "alert_type": alert_type, "duration": duration,
                                "rationale": rationale, "date": scheduled.strftime("%Y-%m-%d"), "time": scheduled.strftime("%H:%M")})
            except (RuntimeError, ValueError, KeyError, TypeError) as exc:
                print(f"AI scheduling skipped site {site['id']} ({type(exc).__name__}).", file=sys.stderr, flush=True)
                ai_errors.append(str(exc))
        if not pending:
            if ai_errors:
                self.send_json(502, {"error": ai_errors[0]})
                return
            self.send_json(200, {"created": [], "message": "AI found no suitable weather-based break to schedule, or weather/Gemini was unavailable."})
            return
        created = []
        already_scheduled = 0
        sms_jobs = []
        with connect_db() as conn:
            worker_count = conn.execute("SELECT COUNT(*) FROM workers WHERE organization_id=?", (user["organization_id"],)).fetchone()[0]
            for item in pending:
                site_id = item["site"]["id"]
                site_name = item["site"]["name"]
                duplicate = conn.execute("SELECT 1 FROM break_logs WHERE organization_id=? AND site=? AND break_date=? AND break_time=? AND source='ai' LIMIT 1",
                                         (user["organization_id"], site_name, item["date"], item["time"])).fetchone()
                if duplicate:
                    already_scheduled += 1
                    continue
                workers = conn.execute("SELECT name,phone FROM workers WHERE organization_id=? AND site_id=? AND consent_at IS NOT NULL", (user["organization_id"], site_id)).fetchall()
                recipients_by_phone = {}
                for worker in workers:
                    phone = normalize_sms_recipient(worker["phone"])
                    if phone:
                        recipients_by_phone.setdefault(phone, {"phone": phone, "name": worker["name"]})
                log_id, stamp = secrets.token_urlsafe(12), now()
                conn.execute("""INSERT INTO break_logs(id,organization_id,title,site,break_date,break_time,duration_minutes,worker_count,status,source,alert_type,ai_rationale,created_at)
                    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", (log_id, user["organization_id"], item["title"], site_name, item["date"], item["time"], item["duration"], worker_count, "scheduled", "ai", item["alert_type"], item["rationale"], stamp))
                record = dict(conn.execute("SELECT id,title,site,break_date,break_time,duration_minutes,worker_count,status,source,alert_type,ai_rationale,created_at FROM break_logs WHERE id=?", (log_id,)).fetchone())
                created.append(record)
                recipients = list(recipients_by_phone.values())
                if recipients:
                    sms_jobs.append((recipients, record))
        sms_results = [send_textbee_break_sms(recipients, record) for recipients, record in sms_jobs]
        suffix = f" {already_scheduled} matching AI log(s) already existed." if already_scheduled else ""
        self.send_json(201, {"created": created, "sms": sms_results, "message": f"AI scheduled {len(created)} weather-based break log(s).{suffix}"})

    def create_break_log(self, data: dict) -> None:
        user = self.session_user()
        if not user:
            self.send_json(401, {"error": "Sign in to log a break."})
            return
        alert_type = str(data.get("alert_type", "break")).strip()
        title = str(data.get("title", "")).strip()
        if alert_type in BREAK_ALERTS:
            title = BREAK_ALERTS[alert_type]
        elif alert_type != "break":
            self.send_json(400, {"error": "Choose a valid break or alert type."})
            return
        site_id = str(data.get("site_id", "")).strip()
        break_date = str(data.get("break_date", "")).strip()
        break_time = str(data.get("break_time", "")).strip()
        status = str(data.get("status", "logged")).strip()
        try:
            duration = int(data.get("duration_minutes", 0))
        except (TypeError, ValueError):
            duration = 0
        if (not title or len(title) > 120
                or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", break_date)
                or not re.fullmatch(r"(?:[01]\d|2[0-3]):[0-5]\d", break_time)
                or duration < 1 or duration > 240 or status not in {"logged", "scheduled"}):
            self.send_json(400, {"error": "Enter a break name, site, valid date and time, and duration from 1 to 240 minutes."})
            return
        try:
            datetime.strptime(break_date, "%Y-%m-%d")
        except ValueError:
            self.send_json(400, {"error": "Enter a valid break date."})
            return
        with connect_db() as conn:
            selected_site = conn.execute("SELECT name FROM sites WHERE id=? AND organization_id=?", (site_id, user["organization_id"])).fetchone()
            if not selected_site:
                self.send_json(400, {"error": "Choose a worksite from your saved Sites list."})
                return
            site = selected_site["name"]
            workers = conn.execute("SELECT name,phone FROM workers WHERE organization_id=? AND site_id=? AND consent_at IS NOT NULL", (user["organization_id"], site_id)).fetchall()
            recipients_by_phone = {}
            for worker in workers:
                number = normalize_sms_recipient(worker["phone"])
                if number:
                    recipients_by_phone.setdefault(number, {"phone": number, "name": worker["name"]})
            recipients = list(recipients_by_phone.values())
            worker_count = conn.execute("SELECT COUNT(*) FROM workers WHERE organization_id=?", (user["organization_id"],)).fetchone()[0]
            log_id = secrets.token_urlsafe(12)
            stamp = now()
            conn.execute("""INSERT INTO break_logs(id,organization_id,title,site,break_date,break_time,duration_minutes,worker_count,status,source,alert_type,ai_rationale,created_at)
                VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)""", (log_id, user["organization_id"], title, site, break_date, break_time, duration, worker_count, status, "manual", alert_type, "", stamp))
            record = dict(conn.execute("SELECT id,title,site,break_date,break_time,duration_minutes,worker_count,status,source,alert_type,ai_rationale,created_at FROM break_logs WHERE id=?", (log_id,)).fetchone())
        sms = send_textbee_break_sms(recipients, record)
        self.send_json(201, {"break": record, "sms": sms})

    def do_PUT(self) -> None:
        if not self.require_csrf_and_origin():
            return
        parsed = urlparse(self.path)
        user = self.session_user()
        if not user:
            self.send_json(401, {"error": "Sign in to manage workers."})
            return
        entity_id = parse_qs(parsed.query).get("id", [""])[0]
        if parsed.path == "/api/sites" and entity_id:
            try:
                values = self.site_values(self.read_json())
            except ValueError as exc:
                self.send_json(400, {"error": str(exc)})
                return
            if not values:
                self.send_json(400, {"error": "Enter a site name, address (optional), and valid latitude/longitude for weather."})
                return
            with connect_db() as conn:
                duplicate = conn.execute("SELECT 1 FROM sites WHERE organization_id=? AND name=? COLLATE NOCASE AND id<>?", (user["organization_id"], values[0], entity_id)).fetchone()
                if duplicate:
                    self.send_json(409, {"error": "A site with this name already exists in your organization."})
                    return
                result = conn.execute("UPDATE sites SET name=?,address=?,latitude=?,longitude=?,updated_at=? WHERE id=? AND organization_id=?",
                                      (*values, now(), entity_id, user["organization_id"]))
                if not result.rowcount:
                    self.send_json(404, {"error": "Site not found."})
                    return
                site = conn.execute("SELECT id,name,address,latitude,longitude,created_at,updated_at FROM sites WHERE id=?", (entity_id,)).fetchone()
                conn.execute("UPDATE workers SET site=? WHERE site_id=? AND organization_id=?", (site["name"], entity_id, user["organization_id"]))
            WEATHER_CACHE.pop(entity_id, None)
            self.send_json(200, {"site": dict(site)})
            return
        if parsed.path != "/api/workers" or not entity_id:
            self.send_json(404, {"error": "Not found."})
            return
        try:
            values = self.worker_values(self.read_json(), user["organization_id"])
        except ValueError as exc:
            self.send_json(400, {"error": str(exc)})
            return
        if not values:
            self.send_json(400, {"error": "Enter a name, valid phone, site, job type, and workload."})
            return
        try:
            with connect_db() as conn:
                result = conn.execute("""UPDATE workers SET name=?,phone=?,site_id=?,site=?,job_type=?,workload=?,updated_at=?
                    WHERE id=? AND organization_id=?""", (*values, now(), entity_id, user["organization_id"]))
                if not result.rowcount:
                    self.send_json(404, {"error": "Worker not found."})
                    return
                worker = conn.execute("SELECT * FROM workers WHERE id=?", (entity_id,)).fetchone()
        except sqlite3.Error as exc:
            print(f"Database error (worker update): {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
            self.send_json(503, {"error": "The database could not save this change. Restart the server and try again."})
            return
        self.send_json(200, {"worker": dict(worker)})

    def do_DELETE(self) -> None:
        if not self.require_csrf_and_origin():
            return
        parsed = urlparse(self.path)
        entity_id = parse_qs(parsed.query).get("id", [""])[0]
        user = self.session_user()
        if not user:
            self.send_json(401, {"error": "Sign in to manage workers."})
            return
        if parsed.path == "/api/sites" and entity_id:
            with connect_db() as conn:
                if conn.execute("SELECT 1 FROM workers WHERE organization_id=? AND site_id=? LIMIT 1", (user["organization_id"], entity_id)).fetchone():
                    self.send_json(409, {"error": "Move or remove workers assigned to this site before deleting it."})
                    return
                result = conn.execute("DELETE FROM sites WHERE id=? AND organization_id=?", (entity_id, user["organization_id"]))
            if not result.rowcount:
                self.send_json(404, {"error": "Site not found."})
                return
            WEATHER_CACHE.pop(entity_id, None)
            self.send_json(200, {"message": "Site removed."})
            return
        if parsed.path != "/api/workers" or not entity_id:
            self.send_json(404, {"error": "Not found."})
            return
        try:
            with connect_db() as conn:
                result = conn.execute("DELETE FROM workers WHERE id=? AND organization_id=?", (entity_id, user["organization_id"]))
        except sqlite3.Error as exc:
            print(f"Database error (worker delete): {type(exc).__name__}: {exc}", file=sys.stderr, flush=True)
            self.send_json(503, {"error": "The database could not save this change. Restart the server and try again."})
            return
        if not result.rowcount:
            self.send_json(404, {"error": "Worker not found."})
            return
        self.send_json(200, {"message": "Worker removed."})

    def signup(self, data: dict) -> None:
        if not self.rate_allowed("signup", limit=4):
            self.send_json(429, {"error": "Too many sign-up attempts. Please try again later."})
            return
        name = str(data.get("name", "")).strip()
        organization = str(data.get("organization", "")).strip()
        org_type = str(data.get("organization_type", "")).strip()
        phone = str(data.get("phone", "")).strip()
        email = str(data.get("email", "")).strip().lower()
        password = data.get("password", "")
        workers_raw = str(data.get("estimated_workers", "0")).strip()
        accepted = data.get("privacy_consent") is True
        categories = {"construction", "factory", "ngo", "union", "garage", "farm", "government", "other"}
        if not all((name, organization, phone, email)) or len(name) > 120 or len(organization) > 160:
            self.send_json(400, {"error": "Complete the required fields. Names must be within the stated length."})
            return
        if not re.fullmatch(r"[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+", email) or len(email) > 254:
            self.send_json(400, {"error": "Enter a valid email address."})
            return
        if not re.fullmatch(r"[+()0-9 .-]{7,24}", phone):
            self.send_json(400, {"error": "Enter a valid phone number."})
            return
        if org_type not in categories:
            self.send_json(400, {"error": "Choose an organization type."})
            return
        if not workers_raw.isdigit() or int(workers_raw) > 1_000_000:
            self.send_json(400, {"error": "Enter an estimated worker count from 0 to 1,000,000."})
            return
        if not isinstance(password, str) or len(password) < PASSWORD_MIN or len(password) > 128:
            self.send_json(400, {"error": f"Use a password between {PASSWORD_MIN} and 128 characters."})
            return
        if not accepted:
            self.send_json(400, {"error": "Please review and accept the privacy notice and terms."})
            return
        user_id, org_id = secrets.token_urlsafe(18), secrets.token_urlsafe(18)
        saved_hash, salt = hash_password(password)
        stamp = now()
        with connect_db() as conn:
            conn.execute("INSERT INTO organizations(id,name,organization_type,phone,estimated_workers,created_at) VALUES(?,?,?,?,?,?)",
                         (org_id, organization, org_type, phone, int(workers_raw), stamp))
            conn.execute("""INSERT INTO users(id,organization_id,full_name,email,phone,password_hash,password_salt,role,
                           privacy_notice_version,privacy_consent_at,email_verified_at,created_at)
                           VALUES(?,?,?,?,?,?,?,'organization_owner','2026-10-01',?, ?, ?)""",
                         (user_id, org_id, name, email, phone, saved_hash, salt, stamp, stamp, stamp))
        result = {"message": "Account created. You can sign in now."}
        self.send_json(201, result)

    def verify_email(self, data: dict) -> None:
        if not self.rate_allowed("verify", limit=10):
            self.send_json(429, {"error": "Too many attempts. Please try again later."})
            return
        token = str(data.get("token", ""))
        if len(token) < 30 or len(token) > 100:
            self.send_json(400, {"error": "This verification link is invalid or expired."})
            return
        with connect_db() as conn:
            row = conn.execute("SELECT user_id FROM action_tokens WHERE token_hash=? AND purpose='verify_email' AND expires_at>=?", (token_digest(token), now())).fetchone()
            if not row:
                self.send_json(400, {"error": "This verification link is invalid or expired. Request a new one by signing up again."})
                return
            conn.execute("UPDATE users SET email_verified_at=? WHERE id=?", (now(), row["user_id"]))
            conn.execute("DELETE FROM action_tokens WHERE user_id=? AND purpose='verify_email'", (row["user_id"],))
        self.send_json(200, {"message": "Email verified. You can now sign in."})

    def resend_verification(self, data: dict) -> None:
        if not self.rate_allowed("resend-verification", limit=5):
            self.send_json(429, {"error": "Too many requests. Please try again later."})
            return
        email = str(data.get("email", "")).strip().lower()
        result = {"message": "If that address has an account awaiting verification, a new one-time link will be sent."}
        if len(email) <= 254 and re.fullmatch(r"[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+", email):
            with connect_db() as conn:
                user = conn.execute("SELECT id,full_name FROM users WHERE email=? AND email_verified_at IS NULL", (email,)).fetchone()
            if user:
                token = issue_action_token(user["id"], "verify_email")
                link = f"{PUBLIC_ORIGIN}/verify.html?token={quote(token)}"
                smtp_send(email, "Verify your JibonGuard email", f"Hello {user['full_name']},\n\nUse this new one-time link to verify your email address:\n{link}\n\nIt expires in one hour.")
                if not IS_PRODUCTION:
                    result["development_action_url"] = link
        self.send_json(200, result)

    def login(self, data: dict) -> None:
        email = str(data.get("email", "")).strip().lower()
        password = data.get("password", "")
        if len(email) > 254 or not isinstance(password, str) or len(password) > 128:
            self.send_json(400, {"error": "Enter a valid email and password."})
            return
        with connect_db() as conn:
            user = conn.execute("SELECT * FROM users WHERE email=?", (email,)).fetchone()
            # Run a comparable password hash even for an unknown address.
            if not user:
                hash_password(password or "invalid-password")
                self.send_json(401, {"error": "Email or password is incorrect."})
                return
            if not check_password(password, user["password_hash"], user["password_salt"]):
                self.send_json(401, {"error": "Email or password is incorrect."})
                return
            remember = data.get("remember") is True
            lifetime = REMEMBER_LIFETIME if remember else SESSION_LIFETIME
            opaque = secrets.token_urlsafe(32)
            prior_cookie = self.cookies().get(SESSION_COOKIE)
            if prior_cookie:
                conn.execute("DELETE FROM sessions WHERE token_hash=?", (token_digest(prior_cookie.value),))
            conn.execute("INSERT INTO sessions(token_hash,user_id,created_at,expires_at) VALUES(?,?,?,?)",
                         (token_digest(opaque), user["id"], now(), now() + lifetime))
        csrf, csrf_cookie = self.ensure_csrf()
        new_csrf = secrets.token_urlsafe(32)
        cookie_headers = [
            ("Set-Cookie", self.set_cookie(SESSION_COOKIE, opaque, http_only=True, max_age=lifetime)),
            ("Set-Cookie", self.set_cookie(CSRF_COOKIE, new_csrf, http_only=False, max_age=REMEMBER_LIFETIME)),
        ]
        self.send_json(200, {"message": "Signed in.", "csrf_token": new_csrf, "next": safe_next(data.get("next"))}, cookie_headers)

    def logout(self, _data: dict) -> None:
        cookie = self.cookies().get(SESSION_COOKIE)
        if cookie:
            with connect_db() as conn:
                conn.execute("DELETE FROM sessions WHERE token_hash=?", (token_digest(cookie.value),))
        expired = [
            ("Set-Cookie", self.set_cookie(SESSION_COOKIE, "", http_only=True, max_age=0)),
            ("Set-Cookie", self.set_cookie(CSRF_COOKIE, "", http_only=False, max_age=0)),
        ]
        self.send_json(200, {"message": "Signed out."}, expired)

    def forgot_password(self, data: dict) -> None:
        if not self.rate_allowed("forgot", limit=5):
            self.send_json(429, {"error": "Too many requests. Please try again later."})
            return
        email = str(data.get("email", "")).strip().lower()
        result = {"message": "If an account matches that email, a password reset link will be sent."}
        if len(email) <= 254 and re.fullmatch(r"[^\s@]{1,64}@[^\s@.]+(?:\.[^\s@.]+)+", email):
            with connect_db() as conn:
                user = conn.execute("SELECT id,full_name FROM users WHERE email=?", (email,)).fetchone()
            if user:
                token = issue_action_token(user["id"], "reset_password")
                link = f"{PUBLIC_ORIGIN}/login.html?mode=reset&token={quote(token)}"
                smtp_send(email, "Reset your JibonGuard password", f"Hello {user['full_name']},\n\nUse this one-time link to reset your password:\n{link}\n\nIt expires in one hour. If you did not request this, ignore this email.")
                if not IS_PRODUCTION:
                    result["development_action_url"] = link
        self.send_json(200, result)

    def reset_password(self, data: dict) -> None:
        if not self.rate_allowed("reset", limit=5):
            self.send_json(429, {"error": "Too many requests. Please try again later."})
            return
        token = str(data.get("token", ""))
        password = data.get("password", "")
        if not isinstance(password, str) or len(password) < PASSWORD_MIN or len(password) > 128:
            self.send_json(400, {"error": f"Use a password between {PASSWORD_MIN} and 128 characters."})
            return
        if len(token) < 30 or len(token) > 100:
            self.send_json(400, {"error": "This reset link is invalid or expired."})
            return
        saved_hash, salt = hash_password(password)
        with connect_db() as conn:
            row = conn.execute("SELECT user_id FROM action_tokens WHERE token_hash=? AND purpose='reset_password' AND expires_at>=?", (token_digest(token), now())).fetchone()
            if not row:
                self.send_json(400, {"error": "This reset link is invalid or expired. Request a new one."})
                return
            conn.execute("UPDATE users SET password_hash=?,password_salt=? WHERE id=?", (saved_hash, salt, row["user_id"]))
            conn.execute("DELETE FROM action_tokens WHERE user_id=?", (row["user_id"],))
            conn.execute("DELETE FROM sessions WHERE user_id=?", (row["user_id"],))
        self.send_json(200, {"message": "Password updated. Sign in using your new password."})

    def delete_account(self, data: dict) -> None:
        if not self.rate_allowed("delete", limit=3):
            self.send_json(429, {"error": "Too many requests. Please try again later."})
            return
        user = self.session_user()
        if not user:
            self.send_json(401, {"error": "Sign in again before deleting this account."})
            return
        password = data.get("password", "")
        if not isinstance(password, str) or len(password) > 128:
            self.send_json(400, {"error": "Confirm your password to continue."})
            return
        with connect_db() as conn:
            row = conn.execute("SELECT password_hash,password_salt FROM users WHERE id=?", (user["id"],)).fetchone()
            if not row or not check_password(password, row["password_hash"], row["password_salt"]):
                self.send_json(401, {"error": "Password confirmation did not match."})
                return
            conn.execute("DELETE FROM organizations WHERE id=?", (user["organization_id"],))
        expired = [("Set-Cookie", self.set_cookie(SESSION_COOKIE, "", http_only=True, max_age=0))]
        self.send_json(200, {"message": "The account and organization profile were deleted."}, expired)

    def do_HEAD(self) -> None:
        self.send_error(405)


def safe_next(value: object) -> str:
    if isinstance(value, str) and value.startswith("/") and not value.startswith("//") and "\\" not in value and "\r" not in value and "\n" not in value:
        return value
    return "/dashboard.html"


if __name__ == "__main__":
    initialize_db()
    server = AppServer((HOST, PORT), Handler)
    print(f"JibonGuard running at {PUBLIC_ORIGIN} ({APP_ENV})", flush=True)
    print("Press Ctrl+C to stop.", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
