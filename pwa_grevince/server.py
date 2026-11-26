#!/usr/bin/env python3
"""
OMNIS-X Student Grievance PWA Server
Provides:
- 4-User Authentication & Sessions (admin, student, faculty1 -> floor1, faculty2 -> floor2)
- Floor-Targeted Alert Routing (Floor 1 -> faculty1, Floor 2 -> faculty2, All -> admin)
- Real-Time Server-Sent Events (/api/stream) so resolutions & updates sync to all users immediately
- SQLite persistence + OMNIS-X (JADE_PALACE) engine connector forwarding
"""

import hashlib
import json
import mimetypes
import os
import queue
import secrets
import sqlite3
import threading
import urllib.parse
import uuid
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from engine_connector import (
    dispatch_alert_to_inbox,
    dispatch_record_to_engine,
    load_engine_config,
    ping_engine,
    resolve_entity_id,
)

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PUBLIC_DIR = os.path.join(BASE_DIR, "public")
DATA_DIR = os.path.join(BASE_DIR, "data")
DB_PATH = os.path.join(DATA_DIR, "grievances.db")

ENGINE_CFG = load_engine_config()
PORT = int(ENGINE_CFG.get("pwa_port", 8090))
HOST = str(ENGINE_CFG.get("pwa_host", "0.0.0.0"))

DB_LOCK = threading.Lock()
STREAM_LOCK = threading.Lock()
STREAM_SUBSCRIBERS = []  # List[tuple[str, queue.Queue]]

VALID_CATEGORIES = {
    "water",
    "ac",
    "faculty",
    "electrical",
    "network",
    "cleanliness",
    "infrastructure",
    "other",
}
VALID_SEVERITIES = {"LOW", "MEDIUM", "HIGH", "CRITICAL"}
VALID_STATUSES = {"SUBMITTED", "ACKNOWLEDGED", "IN_PROGRESS", "RESOLVED"}

FLOOR_LABELS = {
    "ground": "LEVEL 00 (Utility Core)",
    "floor1": "LEVEL 01 (Floor 1)",
    "floor2": "LEVEL 02 (Floor 2)",
    "roof": "LEVEL 03 (Admin & Roof)",
}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def hash_password(password: str, salt: str = None) -> str:
    if salt is None:
        salt = secrets.token_hex(16)
    dk = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt.encode("utf-8"), 100_000)
    return f"{salt}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    if "$" not in stored:
        return False
    salt, _ = stored.split("$", 1)
    return secrets.compare_digest(hash_password(password, salt), stored)


def get_conn() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def broadcast_sse(event_name: str, payload: dict) -> None:
    msg = f"event: {event_name}\ndata: {json.dumps(payload)}\n\n".encode("utf-8")
    with STREAM_LOCK:
        dead = []
        for idx, (_, q) in enumerate(STREAM_SUBSCRIBERS):
            try:
                q.put_nowait(msg)
            except Exception:
                dead.append(idx)
        for idx in reversed(dead):
            STREAM_SUBSCRIBERS.pop(idx)


def init_db() -> None:
    os.makedirs(DATA_DIR, exist_ok=True)
    with DB_LOCK:
        conn = get_conn()
        try:
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS users (
                    username TEXT PRIMARY KEY,
                    password_hash TEXT NOT NULL,
                    role TEXT NOT NULL,
                    display_name TEXT NOT NULL,
                    assigned_floor TEXT DEFAULT ''
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS sessions (
                    token TEXT PRIMARY KEY,
                    username TEXT NOT NULL,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS alerts (
                    id TEXT PRIMARY KEY,
                    target_username TEXT NOT NULL,
                    grievance_id TEXT NOT NULL,
                    ticket_code TEXT NOT NULL,
                    layer_id TEXT NOT NULL,
                    room_code TEXT NOT NULL,
                    title TEXT NOT NULL,
                    message TEXT NOT NULL,
                    alert_type TEXT NOT NULL,
                    actor_name TEXT DEFAULT '',
                    is_read INTEGER DEFAULT 0,
                    created_at TEXT NOT NULL
                )
                """
            )
            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS grievances (
                    id TEXT PRIMARY KEY,
                    ticket_code TEXT UNIQUE NOT NULL,
                    category TEXT NOT NULL,
                    sub_category TEXT DEFAULT '',
                    title TEXT NOT NULL,
                    description TEXT NOT NULL,
                    severity TEXT NOT NULL DEFAULT 'MEDIUM',
                    status TEXT NOT NULL DEFAULT 'SUBMITTED',
                    layer_id TEXT NOT NULL,
                    layer_title TEXT DEFAULT '',
                    room_id TEXT NOT NULL,
                    room_code TEXT NOT NULL,
                    room_name TEXT NOT NULL,
                    backend_entity_id TEXT DEFAULT '',
                    department TEXT DEFAULT '',
                    equipment TEXT DEFAULT '',
                    location_note TEXT DEFAULT '',
                    pin_x REAL DEFAULT 0,
                    pin_y REAL DEFAULT 0,
                    pin_z REAL DEFAULT 0,
                    student_name TEXT DEFAULT '',
                    student_id TEXT DEFAULT '',
                    student_contact TEXT DEFAULT '',
                    anonymous INTEGER DEFAULT 0,
                    photo_data_url TEXT DEFAULT '',
                    resolution_note TEXT DEFAULT '',
                    assigned_to TEXT DEFAULT '',
                    reported_by TEXT DEFAULT '',
                    updated_by TEXT DEFAULT '',
                    webhook_status TEXT DEFAULT 'local_only',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                )
                """
            )
            cols = {r["name"] for r in conn.execute("PRAGMA table_info(grievances)").fetchall()}
            if "backend_entity_id" not in cols:
                conn.execute("ALTER TABLE grievances ADD COLUMN backend_entity_id TEXT DEFAULT ''")
            if "reported_by" not in cols:
                conn.execute("ALTER TABLE grievances ADD COLUMN reported_by TEXT DEFAULT ''")
            if "updated_by" not in cols:
                conn.execute("ALTER TABLE grievances ADD COLUMN updated_by TEXT DEFAULT ''")

            conn.execute(
                """
                CREATE TABLE IF NOT EXISTS config (
                    key TEXT PRIMARY KEY,
                    value TEXT NOT NULL
                )
                """
            )

            defaults = {
                "website_name": ENGINE_CFG.get("website_name", "OMNIS-X • Apex Institute of Technology"),
                "integration_mode": ENGINE_CFG.get("engine_mode", "inbox"),
                "webhook_url": ENGINE_CFG.get("inbox_url") or ENGINE_CFG.get("engine_incidents_url", "http://127.0.0.1:8000/api/v1/incidents"),
                "omnisx_user_id": ENGINE_CFG.get("engine_user_id", "USR-PRINCIPAL"),
                "webhook_auth_header": ENGINE_CFG.get("inbox_api_key") or ENGINE_CFG.get("engine_auth_header", ""),
                "auto_forward": "true" if ENGINE_CFG.get("auto_forward", True) else "false",
            }
            for k, v in defaults.items():
                conn.execute(
                    "INSERT OR IGNORE INTO config (key, value) VALUES (?, ?)",
                    (k, v),
                )

            # Migrate untouched legacy or local mock defaults to the configured Laptop 2 inbox endpoint & key
            legacy_urls = (
                "",
                ":8095/api/inbox",
                "http://127.0.0.1:8000/api/v1/incidents",
                "http://127.0.0.1:8000/api/v1/inbox",
                "http://127.0.0.1:8000/api/v1/inbox/dispatch",
            )
            cur_url_row = conn.execute("SELECT value FROM config WHERE key = 'webhook_url'").fetchone()
            migrated_url = False
            if cur_url_row and cur_url_row[0] in legacy_urls and defaults["webhook_url"]:
                conn.execute(
                    "UPDATE config SET value = ? WHERE key = 'webhook_url'",
                    (defaults["webhook_url"],),
                )
                conn.execute(
                    "UPDATE config SET value = ? WHERE key = 'integration_mode'",
                    (defaults["integration_mode"],),
                )
                migrated_url = True
            cur_auth_row = conn.execute("SELECT value FROM config WHERE key = 'webhook_auth_header'").fetchone()
            if cur_auth_row and (not cur_auth_row[0].strip() or migrated_url) and defaults["webhook_auth_header"]:
                conn.execute(
                    "UPDATE config SET value = ? WHERE key = 'webhook_auth_header'",
                    (defaults["webhook_auth_header"],),
                )

            # Seed the 4 required users idempotently
            default_users = [
                ("admin", "admin123", "ADMIN", "Campus Admin", "ALL"),
                ("student", "student123", "STUDENT", "Student Reporter", ""),
                ("faculty1", "faculty123", "FACULTY", "Faculty 1 (Floor 1)", "floor1"),
                ("faculty2", "faculty123", "FACULTY", "Faculty 2 (Floor 2)", "floor2"),
            ]
            for uname, pwd, role, dname, floor in default_users:
                exists = conn.execute("SELECT 1 FROM users WHERE username = ?", (uname,)).fetchone()
                if not exists:
                    conn.execute(
                        "INSERT INTO users (username, password_hash, role, display_name, assigned_floor) VALUES (?, ?, ?, ?, ?)",
                        (uname, hash_password(pwd), role, dname, floor),
                    )

            conn.commit()
        finally:
            conn.close()


def user_to_dict(row: sqlite3.Row) -> dict:
    return {
        "username": row["username"],
        "role": row["role"],
        "displayName": row["display_name"],
        "assignedFloor": row["assigned_floor"] or "",
    }


def row_to_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "ticketCode": row["ticket_code"],
        "category": row["category"],
        "subCategory": row["sub_category"],
        "title": row["title"],
        "description": row["description"],
        "severity": row["severity"],
        "status": row["status"],
        "layerId": row["layer_id"],
        "layerTitle": row["layer_title"],
        "roomId": row["room_id"],
        "roomCode": row["room_code"],
        "roomName": row["room_name"],
        "backendEntityId": resolve_entity_id(row["room_id"], row["backend_entity_id"] or ""),
        "department": row["department"],
        "equipment": row["equipment"],
        "locationNote": row["location_note"],
        "pinCoords": {
            "x": row["pin_x"],
            "y": row["pin_y"],
            "z": row["pin_z"],
        },
        "studentName": row["student_name"],
        "studentId": row["student_id"],
        "studentContact": row["student_contact"],
        "anonymous": bool(row["anonymous"]),
        "photoDataUrl": row["photo_data_url"] or "",
        "resolutionNote": row["resolution_note"] or "",
        "assignedTo": row["assigned_to"] or "",
        "reportedBy": row["reported_by"] if "reported_by" in row.keys() else "",
        "updatedBy": row["updated_by"] if "updated_by" in row.keys() else "",
        "webhookStatus": row["webhook_status"] or "local_only",
        "createdAt": row["created_at"],
        "updatedAt": row["updated_at"],
    }


def alert_to_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "targetUsername": row["target_username"],
        "grievanceId": row["grievance_id"],
        "ticketCode": row["ticket_code"],
        "layerId": row["layer_id"],
        "roomCode": row["room_code"],
        "title": row["title"],
        "message": row["message"],
        "alertType": row["alert_type"],
        "actorName": row["actor_name"],
        "isRead": bool(row["is_read"]),
        "createdAt": row["created_at"],
    }


def get_config_dict(conn: sqlite3.Connection) -> dict:
    rows = conn.execute("SELECT key, value FROM config").fetchall()
    return {r["key"]: r["value"] for r in rows}


def insert_alerts(conn: sqlite3.Connection, targets: list, grievance: dict, alert_type: str, message: str, actor_name: str) -> None:
    now = utc_now_iso()
    for uname in dict.fromkeys(targets):  # preserve order, dedupe
        conn.execute(
            """
            INSERT INTO alerts (
                id, target_username, grievance_id, ticket_code, layer_id, room_code,
                title, message, alert_type, actor_name, is_read, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
            """,
            (
                str(uuid.uuid4()),
                uname,
                grievance["id"],
                grievance["ticket_code"],
                grievance["layer_id"],
                grievance["room_code"],
                grievance["title"],
                message,
                alert_type,
                actor_name,
                now,
            ),
        )


class GrievanceHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args) -> None:
        print(f"[{self.log_date_time_string()}] {format % args}")

    def send_json(self, status_code: int, payload: dict) -> None:
        raw = json.dumps(payload).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(raw)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key, X-User-Id")
        self.end_headers()
        self.wfile.write(raw)

    def read_json_body(self) -> dict:
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > 8 * 1024 * 1024:
            raise ValueError("Invalid or oversized payload")
        raw = self.rfile.read(length)
        return json.loads(raw.decode("utf-8"))

    def get_auth_token(self, qs: dict = None) -> str:
        auth = self.headers.get("Authorization", "")
        if auth.lower().startswith("bearer "):
            return auth.split(" ", 1)[1].strip()
        if qs and "token" in qs and qs["token"]:
            return qs["token"][0].strip()
        return ""

    def get_current_user(self, qs: dict = None):
        token = self.get_auth_token(qs)
        if not token:
            return None
        with DB_LOCK:
            conn = get_conn()
            row = conn.execute(
                """
                SELECT u.* FROM sessions s
                JOIN users u ON u.username = s.username
                WHERE s.token = ?
                """,
                (token,),
            ).fetchone()
            conn.close()
        return user_to_dict(row) if row else None

    def require_auth(self, qs: dict = None):
        user = self.get_current_user(qs)
        if not user:
            self.send_json(401, {"error": "Authentication required. Please log in."})
            return None
        return user

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-API-Key, X-User-Id")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        qs = urllib.parse.parse_qs(parsed.query)

        if path == "/api/health":
            with DB_LOCK:
                conn = get_conn()
                cnt = conn.execute("SELECT COUNT(*) AS cnt FROM grievances").fetchone()["cnt"]
                conn.close()
            self.send_json(
                200,
                {
                    "ok": True,
                    "service": "omnis-x-student-pwa",
                    "timestamp": utc_now_iso(),
                    "grievanceCount": cnt,
                },
            )
            return

        if path == "/api/auth/me":
            user = self.require_auth(qs)
            if not user:
                return
            self.send_json(200, {"user": user})
            return

        if path == "/api/stream":
            user = self.require_auth(qs)
            if not user:
                return
            self.handle_sse_stream(user)
            return

        if path == "/api/alerts":
            user = self.require_auth(qs)
            if not user:
                return
            self.handle_get_alerts(user)
            return

        if path == "/api/status":
            self.handle_get_status()
            return

        if path == "/api/grievances":
            self.handle_get_grievances(qs)
            return

        if path == "/api/config":
            user = self.require_auth(qs)
            if not user:
                return
            with DB_LOCK:
                conn = get_conn()
                cfg = get_config_dict(conn)
                conn.close()
            self.send_json(
                200,
                {
                    "websiteName": cfg.get("website_name", "OMNIS-X • Apex Institute of Technology"),
                    "integrationMode": cfg.get("integration_mode", "omnisx"),
                    "webhookUrl": cfg.get("webhook_url", "http://127.0.0.1:8000/api/v1/incidents"),
                    "omnisxUserId": cfg.get("omnisx_user_id", "USR-PRINCIPAL"),
                    "hasAuthHeader": bool(cfg.get("webhook_auth_header", "")),
                    "autoForward": cfg.get("auto_forward", "true") == "true",
                },
            )
            return

        self.serve_static(path)

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path == "/api/auth/login":
            self.handle_login()
            return

        if path == "/api/auth/logout":
            self.handle_logout()
            return

        if path == "/api/alerts/read":
            user = self.require_auth()
            if not user:
                return
            self.handle_mark_alerts_read(user)
            return

        if path == "/api/grievances":
            user = self.get_current_user()
            self.handle_create_grievance(user)
            return

        if path == "/api/config":
            user = self.require_auth()
            if not user:
                return
            if user["role"] != "ADMIN":
                self.send_json(403, {"error": "Only Admin can modify OMNIS-X integration settings."})
                return
            self.handle_update_config()
            return

        if path == "/api/webhook-test":
            user = self.require_auth()
            if not user:
                return
            if user["role"] != "ADMIN":
                self.send_json(403, {"error": "Only Admin can test integration connections."})
                return
            self.handle_webhook_test()
            return

        self.send_json(404, {"error": "Endpoint not found"})

    def do_PATCH(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/grievances/"):
            user = self.require_auth()
            if not user:
                return
            gid = path.split("/api/grievances/", 1)[1].strip("/")
            self.handle_patch_grievance(gid, user)
            return
        self.send_json(404, {"error": "Endpoint not found"})

    def do_DELETE(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        if path.startswith("/api/grievances/"):
            user = self.require_auth()
            if not user:
                return
            if user["role"] != "ADMIN":
                self.send_json(403, {"error": "Only Admin can delete grievances."})
                return
            gid = path.split("/api/grievances/", 1)[1].strip("/")
            with DB_LOCK:
                conn = get_conn()
                cur = conn.execute("DELETE FROM grievances WHERE id = ?", (gid,))
                conn.execute("DELETE FROM alerts WHERE grievance_id = ?", (gid,))
                conn.commit()
                conn.close()
            if cur.rowcount == 0:
                self.send_json(404, {"error": "Grievance not found"})
                return
            broadcast_sse("grievance_deleted", {"id": gid})
            self.send_json(200, {"deleted": True, "id": gid})
            return
        self.send_json(404, {"error": "Endpoint not found"})

    def handle_login(self) -> None:
        try:
            data = self.read_json_body()
        except Exception as exc:
            self.send_json(400, {"error": f"Invalid JSON body: {exc}"})
            return

        username = str(data.get("username", "")).strip().lower()
        password = str(data.get("password", ""))
        if not username or not password:
            self.send_json(400, {"error": "Username and password are required."})
            return

        with DB_LOCK:
            conn = get_conn()
            row = conn.execute("SELECT * FROM users WHERE username = ?", (username,)).fetchone()
            if not row or not verify_password(password, row["password_hash"]):
                conn.close()
                self.send_json(401, {"error": "Invalid username or password."})
                return

            token = secrets.token_urlsafe(32)
            conn.execute(
                "INSERT INTO sessions (token, username, created_at) VALUES (?, ?, ?)",
                (token, username, utc_now_iso()),
            )
            conn.commit()
            conn.close()

        self.send_json(200, {"token": token, "user": user_to_dict(row)})

    def handle_logout(self) -> None:
        token = self.get_auth_token()
        if token:
            with DB_LOCK:
                conn = get_conn()
                conn.execute("DELETE FROM sessions WHERE token = ?", (token,))
                conn.commit()
                conn.close()
        self.send_json(200, {"ok": True})

    def handle_sse_stream(self, user: dict) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        q = queue.Queue(maxsize=100)
        entry = (user["username"], q)
        with STREAM_LOCK:
            STREAM_SUBSCRIBERS.append(entry)

        try:
            hello = f"event: connected\ndata: {json.dumps({'username': user['username'], 'role': user['role']})}\n\n".encode("utf-8")
            self.wfile.write(hello)
            self.wfile.flush()

            while True:
                try:
                    msg = q.get(timeout=20)
                    self.wfile.write(msg)
                    self.wfile.flush()
                except queue.Empty:
                    self.wfile.write(b": keepalive\n\n")
                    self.wfile.flush()
        except Exception:
            pass
        finally:
            with STREAM_LOCK:
                if entry in STREAM_SUBSCRIBERS:
                    STREAM_SUBSCRIBERS.remove(entry)

    def handle_get_alerts(self, user: dict) -> None:
        with DB_LOCK:
            conn = get_conn()
            rows = conn.execute(
                "SELECT * FROM alerts WHERE target_username = ? ORDER BY created_at DESC LIMIT 50",
                (user["username"],),
            ).fetchall()
            conn.close()
        items = [alert_to_dict(r) for r in rows]
        unread_count = sum(1 for a in items if not a["isRead"])
        self.send_json(200, {"items": items, "unreadCount": unread_count})

    def handle_mark_alerts_read(self, user: dict) -> None:
        try:
            data = self.read_json_body()
        except Exception:
            data = {"all": True}

        with DB_LOCK:
            conn = get_conn()
            if data.get("alertId"):
                conn.execute(
                    "UPDATE alerts SET is_read = 1 WHERE id = ? AND target_username = ?",
                    (str(data["alertId"]), user["username"]),
                )
            else:
                conn.execute(
                    "UPDATE alerts SET is_read = 1 WHERE target_username = ?",
                    (user["username"],),
                )
            conn.commit()
            conn.close()
        self.send_json(200, {"ok": True})

    def handle_get_grievances(self, qs: dict) -> None:
        clauses = []
        params = []
        if "status" in qs and qs["status"][0] and qs["status"][0] != "ALL":
            clauses.append("status = ?")
            params.append(qs["status"][0].upper())
        if "category" in qs and qs["category"][0] and qs["category"][0] != "ALL":
            clauses.append("category = ?")
            params.append(qs["category"][0].lower())
        if "layerId" in qs and qs["layerId"][0] and qs["layerId"][0] != "all":
            clauses.append("layer_id = ?")
            params.append(qs["layerId"][0])
        if "roomId" in qs and qs["roomId"][0]:
            clauses.append("room_id = ?")
            params.append(qs["roomId"][0])
        if "q" in qs and qs["q"][0].strip():
            q = f"%{qs['q'][0].strip()}%"
            clauses.append(
                "(title LIKE ? OR description LIKE ? OR room_code LIKE ? OR room_name LIKE ? OR ticket_code LIKE ?)"
            )
            params.extend([q, q, q, q, q])

        where_sql = f"WHERE {' AND '.join(clauses)}" if clauses else ""
        sql = f"SELECT * FROM grievances {where_sql} ORDER BY created_at DESC"

        with DB_LOCK:
            conn = get_conn()
            rows = conn.execute(sql, params).fetchall()
            conn.close()

        self.send_json(200, {"items": [row_to_dict(r) for r in rows]})

    def handle_get_status(self) -> None:
        with DB_LOCK:
            conn = get_conn()
            rows = conn.execute("SELECT * FROM grievances").fetchall()
            conn.close()

        open_statuses = {"SUBMITTED", "ACKNOWLEDGED", "IN_PROGRESS"}
        items = [row_to_dict(r) for r in rows]

        def system_health(cats: set) -> dict:
            relevant = [x for x in items if x["category"] in cats and x["status"] in open_statuses]
            critical = sum(1 for x in relevant if x["severity"] == "CRITICAL")
            high = sum(1 for x in relevant if x["severity"] == "HIGH")
            if critical > 0:
                state = "CRITICAL"
            elif high > 0 or len(relevant) >= 2:
                state = "DEGRADED"
            elif len(relevant) == 1:
                state = "ADVISORY"
            else:
                state = "OPERATIONAL"
            return {
                "state": state,
                "openCount": len(relevant),
                "criticalCount": critical,
                "affectedRooms": sorted(list({x["roomCode"] for x in relevant})),
            }

        room_counts = {}
        for x in items:
            if x["status"] in open_statuses:
                room_counts[x["roomId"]] = room_counts.get(x["roomId"], 0) + 1

        self.send_json(
            200,
            {
                "updatedAt": utc_now_iso(),
                "totals": {
                    "all": len(items),
                    "open": sum(1 for x in items if x["status"] in open_statuses),
                    "inProgress": sum(1 for x in items if x["status"] == "IN_PROGRESS"),
                    "resolved": sum(1 for x in items if x["status"] == "RESOLVED"),
                    "criticalOpen": sum(
                        1 for x in items if x["status"] in open_statuses and x["severity"] == "CRITICAL"
                    ),
                },
                "systems": {
                    "water": system_health({"water"}),
                    "ac": system_health({"ac"}),
                    "faculty": system_health({"faculty"}),
                    "electrical": system_health({"electrical"}),
                    "network": system_health({"network"}),
                    "facilities": system_health({"cleanliness", "infrastructure", "other"}),
                },
                "roomOpenCounts": room_counts,
            },
        )

    def handle_create_grievance(self, current_user=None) -> None:
        try:
            data = self.read_json_body()
        except Exception as exc:
            self.send_json(400, {"error": f"Invalid JSON body: {exc}"})
            return

        category = str(data.get("category", "other")).lower().strip()
        if category not in VALID_CATEGORIES:
            category = "other"

        severity = str(data.get("severity", "MEDIUM")).upper().strip()
        if severity not in VALID_SEVERITIES:
            severity = "MEDIUM"

        title = str(data.get("title", "")).strip()
        description = str(data.get("description", "")).strip()
        room_id = str(data.get("roomId", "")).strip()
        room_code = str(data.get("roomCode", room_id)).strip()
        room_name = str(data.get("roomName", room_code)).strip()
        layer_id = str(data.get("layerId", "ground")).strip()
        backend_entity_id = resolve_entity_id(room_id, str(data.get("backendEntityId", "")))

        if not title or not description or not room_id:
            self.send_json(
                400,
                {"error": "title, description, and a campus map room location are required."},
            )
            return

        pin = data.get("pinCoords") or {}
        pin_x = float(pin.get("x", 0) or 0)
        pin_y = float(pin.get("y", 0) or 0)
        pin_z = float(pin.get("z", 0) or 0)

        anonymous = 1 if data.get("anonymous") else 0
        student_name = "Anonymous Student" if anonymous else str(data.get("studentName", "")).strip()
        student_id = "" if anonymous else str(data.get("studentId", "")).strip()
        student_contact = "" if anonymous else str(data.get("studentContact", "")).strip()

        photo_data_url = str(data.get("photoDataUrl", ""))
        if len(photo_data_url) > 2_000_000:
            self.send_json(400, {"error": "Attachment exceeds 2 MB limit."})
            return

        now = utc_now_iso()
        gid = str(uuid.uuid4())

        with DB_LOCK:
            conn = get_conn()
            try:
                seq_row = conn.execute("SELECT COUNT(*) AS cnt FROM grievances").fetchone()
                ticket_num = seq_row["cnt"] + 1
                ticket_code = f"GRV-2026-{ticket_num:04d}"
                while conn.execute(
                    "SELECT 1 FROM grievances WHERE ticket_code = ?", (ticket_code,)
                ).fetchone():
                    ticket_num += 1
                    ticket_code = f"GRV-2026-{ticket_num:04d}"

                # Resolve assigned faculty for this floor
                faculty_rows = conn.execute(
                    "SELECT username, display_name FROM users WHERE role = 'FACULTY' AND assigned_floor = ?",
                    (layer_id,),
                ).fetchall()
                assigned_faculty_usernames = [r["username"] for r in faculty_rows]
                assigned_to_label = (
                    ", ".join(r["display_name"] for r in faculty_rows)
                    if faculty_rows
                    else "Campus Admin"
                )

                cfg = get_config_dict(conn)
                record = {
                    "id": gid,
                    "ticket_code": ticket_code,
                    "category": category,
                    "sub_category": str(data.get("subCategory", "")).strip()[:80],
                    "title": title[:160],
                    "description": description[:2000],
                    "severity": severity,
                    "status": "SUBMITTED",
                    "layer_id": layer_id,
                    "layer_title": str(data.get("layerTitle", "")).strip(),
                    "room_id": room_id,
                    "room_code": room_code,
                    "room_name": room_name,
                    "backend_entity_id": backend_entity_id,
                    "department": str(data.get("department", "")).strip(),
                    "equipment": str(data.get("equipment", "")).strip(),
                    "location_note": str(data.get("locationNote", "")).strip()[:200],
                    "pin_x": pin_x,
                    "pin_y": pin_y,
                    "pin_z": pin_z,
                    "student_name": student_name[:100],
                    "student_id": student_id[:60],
                    "student_contact": student_contact[:120],
                    "anonymous": anonymous,
                    "photo_data_url": photo_data_url,
                    "resolution_note": "",
                    "assigned_to": assigned_to_label,
                    "reported_by": current_user["username"] if current_user else "student",
                    "updated_by": "",
                    "webhook_status": "local_only",
                    "created_at": now,
                    "updated_at": now,
                }

                target_url = str(data.get("targetWebhookUrl", "")).strip() or cfg.get("webhook_url", "")
                auto_forward = cfg.get("auto_forward", "true") == "true"
                mode = cfg.get("integration_mode", "inbox")
                req_host = self.headers.get("Host", "")
                auth_header = cfg.get("webhook_auth_header", "") or ENGINE_CFG.get("inbox_api_key", "")

                if target_url and auto_forward and mode != "inbox":
                    record["webhook_status"] = dispatch_record_to_engine(
                        record=record,
                        target_url=target_url,
                        mode=mode,
                        omnisx_user_id=cfg.get("omnisx_user_id", "USR-PRINCIPAL"),
                        auth_header=auth_header,
                        request_host=req_host,
                    )

                conn.execute(
                    """
                    INSERT INTO grievances (
                        id, ticket_code, category, sub_category, title, description,
                        severity, status, layer_id, layer_title, room_id, room_code,
                        room_name, backend_entity_id, department, equipment, location_note,
                        pin_x, pin_y, pin_z, student_name, student_id, student_contact,
                        anonymous, photo_data_url, resolution_note, assigned_to,
                        reported_by, updated_by, webhook_status, created_at, updated_at
                    ) VALUES (
                        :id, :ticket_code, :category, :sub_category, :title, :description,
                        :severity, :status, :layer_id, :layer_title, :room_id, :room_code,
                        :room_name, :backend_entity_id, :department, :equipment, :location_note,
                        :pin_x, :pin_y, :pin_z, :student_name, :student_id, :student_contact,
                        :anonymous, :photo_data_url, :resolution_note, :assigned_to,
                        :reported_by, :updated_by, :webhook_status, :created_at, :updated_at
                    )
                    """,
                    record,
                )

                # Alert respective floor faculty + admin
                floor_label = FLOOR_LABELS.get(layer_id, layer_id)
                alert_targets = assigned_faculty_usernames + ["admin"]
                actor_label = current_user["displayName"] if current_user else (student_name or "Student")
                alert_msg = f"New {severity} issue in {room_code} ({floor_label}): {record['title']}"
                insert_alerts(
                    conn=conn,
                    targets=alert_targets,
                    grievance=record,
                    alert_type="NEW_ISSUE",
                    message=alert_msg,
                    actor_name=actor_label,
                )

                # Send real-time alert to main website's Inbox using its API key header
                inbox_target = (target_url if mode == "inbox" else "") or ENGINE_CFG.get("inbox_url", "")
                if inbox_target and auto_forward:
                    inbox_status = dispatch_alert_to_inbox(
                        target_url=inbox_target,
                        auth_header=auth_header,
                        record=record,
                        alert_type="NEW_ISSUE",
                        message=alert_msg,
                        target_users=alert_targets,
                        actor_name=actor_label,
                        created_at=now,
                        request_host=req_host,
                        api_key_header_name=ENGINE_CFG.get("inbox_api_key_header", "X-OMNIS-API-KEY"),
                        async_send=True,
                    )
                    conn.execute("UPDATE grievances SET webhook_status = ? WHERE id = ?", (inbox_status, gid))

                conn.commit()
                created = conn.execute("SELECT * FROM grievances WHERE id = ?", (gid,)).fetchone()
            finally:
                conn.close()

        item = row_to_dict(created)
        broadcast_sse(
            "grievance_created",
            {
                "item": item,
                "alertTargets": alert_targets,
                "message": f"New issue in {room_code} ({FLOOR_LABELS.get(layer_id, layer_id)}): {title}",
            },
        )
        self.send_json(201, {"item": item})

    def handle_patch_grievance(self, gid: str, user: dict) -> None:
        if user["role"] not in {"ADMIN", "FACULTY"}:
            self.send_json(403, {"error": "Only assigned Faculty or Admin can update or resolve grievances."})
            return

        try:
            data = self.read_json_body()
        except Exception as exc:
            self.send_json(400, {"error": f"Invalid JSON body: {exc}"})
            return

        with DB_LOCK:
            conn = get_conn()
            existing = conn.execute("SELECT * FROM grievances WHERE id = ?", (gid,)).fetchone()
            if not existing:
                conn.close()
                self.send_json(404, {"error": "Grievance not found"})
                return

            if user["role"] == "FACULTY" and user["assignedFloor"] and existing["layer_id"] != user["assignedFloor"]:
                conn.close()
                self.send_json(
                    403,
                    {
                        "error": f"You are assigned to {FLOOR_LABELS.get(user['assignedFloor'], user['assignedFloor'])}. You can only update issues on your assigned floor."
                    },
                )
                return

            updates = []
            params = []
            new_status = existing["status"]
            if "status" in data:
                st = str(data["status"]).upper().strip()
                if st not in VALID_STATUSES:
                    conn.close()
                    self.send_json(400, {"error": f"Invalid status: {st}"})
                    return
                new_status = st
                updates.append("status = ?")
                params.append(st)
            if "resolutionNote" in data:
                updates.append("resolution_note = ?")
                params.append(str(data["resolutionNote"])[:500])
            if "assignedTo" in data:
                updates.append("assigned_to = ?")
                params.append(str(data["assignedTo"])[:120])

            if not updates:
                conn.close()
                self.send_json(400, {"error": "No valid update fields provided"})
                return

            updates.append("updated_by = ?")
            params.append(user["displayName"])
            updates.append("updated_at = ?")
            params.append(utc_now_iso())
            params.append(gid)

            conn.execute(f"UPDATE grievances SET {', '.join(updates)} WHERE id = ?", params)
            row = conn.execute("SELECT * FROM grievances WHERE id = ?", (gid,)).fetchone()

            # Notify ALL users (student, admin, faculty1, faculty2) when faculty/admin updates or resolves
            all_users = [r["username"] for r in conn.execute("SELECT username FROM users").fetchall()]
            note_txt = f" — {row['resolution_note']}" if row["resolution_note"] else ""
            alert_type = "RESOLVED" if new_status == "RESOLVED" else "STATUS_UPDATE"
            msg = f"{row['ticket_code']} ({row['room_code']}) marked {new_status} by {user['displayName']}{note_txt}"
            insert_alerts(
                conn=conn,
                targets=all_users,
                grievance=dict(row),
                alert_type=alert_type,
                message=msg,
                actor_name=user["displayName"],
            )
            cfg = get_config_dict(conn)
            conn.commit()
            row_dict_raw = dict(row)
            conn.close()

        # Forward real-time status/resolution alert to main website's Inbox
        auto_forward = cfg.get("auto_forward", "true") == "true"
        mode = cfg.get("integration_mode", "inbox")
        inbox_target = (cfg.get("webhook_url", "") if mode == "inbox" else "") or ENGINE_CFG.get("inbox_url", "")
        auth_header = cfg.get("webhook_auth_header", "") or ENGINE_CFG.get("inbox_api_key", "")
        if inbox_target and auto_forward:
            dispatch_alert_to_inbox(
                target_url=inbox_target,
                auth_header=auth_header,
                record=row_dict_raw,
                alert_type=alert_type,
                message=msg,
                target_users=all_users,
                actor_name=user["displayName"],
                created_at=utc_now_iso(),
                request_host=self.headers.get("Host", ""),
                api_key_header_name=ENGINE_CFG.get("inbox_api_key_header", "X-OMNIS-API-KEY"),
                async_send=True,
            )

        item = row_to_dict(row)
        broadcast_sse(
            "grievance_updated",
            {
                "item": item,
                "alertTargets": all_users,
                "actor": user["displayName"],
                "message": msg,
            },
        )
        self.send_json(200, {"item": item})

    def handle_update_config(self) -> None:
        try:
            data = self.read_json_body()
        except Exception as exc:
            self.send_json(400, {"error": f"Invalid JSON body: {exc}"})
            return

        with DB_LOCK:
            conn = get_conn()
            if "websiteName" in data:
                conn.execute(
                    "INSERT OR REPLACE INTO config (key, value) VALUES ('website_name', ?)",
                    (str(data["websiteName"])[:120],),
                )
            if "integrationMode" in data:
                raw_mode = str(data["integrationMode"]).strip().lower()
                mode = raw_mode if raw_mode in {"omnisx", "inbox", "webhook"} else "inbox"
                conn.execute(
                    "INSERT OR REPLACE INTO config (key, value) VALUES ('integration_mode', ?)",
                    (mode,),
                )
            if "omnisxUserId" in data:
                conn.execute(
                    "INSERT OR REPLACE INTO config (key, value) VALUES ('omnisx_user_id', ?)",
                    (str(data["omnisxUserId"]).strip()[:60] or "USR-PRINCIPAL",),
                )
            if "webhookUrl" in data:
                url = str(data["webhookUrl"]).strip()
                if url and not url.startswith(("http://", "https://", ":", "/")):
                    conn.close()
                    self.send_json(400, {"error": "URL must start with http://, https://, or :PORT/path (same IP)"})
                    return
                conn.execute(
                    "INSERT OR REPLACE INTO config (key, value) VALUES ('webhook_url', ?)",
                    (url,),
                )
            if "webhookAuthHeader" in data:
                conn.execute(
                    "INSERT OR REPLACE INTO config (key, value) VALUES ('webhook_auth_header', ?)",
                    (str(data["webhookAuthHeader"]).strip(),),
                )
            if "autoForward" in data:
                conn.execute(
                    "INSERT OR REPLACE INTO config (key, value) VALUES ('auto_forward', ?)",
                    ("true" if data["autoForward"] else "false",),
                )
            conn.commit()
            cfg = get_config_dict(conn)
            conn.close()

        self.send_json(
            200,
            {
                "websiteName": cfg.get("website_name", ""),
                "integrationMode": cfg.get("integration_mode", "omnisx"),
                "webhookUrl": cfg.get("webhook_url", ""),
                "omnisxUserId": cfg.get("omnisx_user_id", "USR-PRINCIPAL"),
                "hasAuthHeader": bool(cfg.get("webhook_auth_header", "")),
                "autoForward": cfg.get("auto_forward", "true") == "true",
            },
        )

    def handle_webhook_test(self) -> None:
        try:
            data = self.read_json_body()
        except Exception:
            data = {}
        with DB_LOCK:
            conn = get_conn()
            cfg = get_config_dict(conn)
            conn.close()

        url = str(data.get("webhookUrl", "")).strip() or cfg.get("webhook_url", "")
        if not url:
            self.send_json(400, {"error": "No target website URL configured."})
            return

        auth = str(data.get("webhookAuthHeader", "")).strip() or cfg.get("webhook_auth_header", "") or ENGINE_CFG.get("inbox_api_key", "")
        self.send_json(
            200,
            ping_engine(
                url,
                auth_header=auth,
                timestamp=utc_now_iso(),
                request_host=self.headers.get("Host", ""),
                api_key_header_name=ENGINE_CFG.get("inbox_api_key_header", "X-OMNIS-API-KEY"),
            ),
        )

    def serve_static(self, req_path: str) -> None:
        if req_path == "/" or req_path == "":
            rel_path = "index.html"
        else:
            rel_path = urllib.parse.unquote(req_path.lstrip("/"))

        safe_path = os.path.normpath(os.path.join(PUBLIC_DIR, rel_path))
        if not safe_path.startswith(PUBLIC_DIR):
            self.send_error(403, "Forbidden")
            return

        if not os.path.isfile(safe_path):
            if "." not in os.path.basename(safe_path):
                safe_path = os.path.join(PUBLIC_DIR, "index.html")
            else:
                self.send_error(404, "Not Found")
                return

        ext = os.path.splitext(safe_path)[1].lower()
        custom_types = {
            ".html": "text/html; charset=utf-8",
            ".js": "application/javascript; charset=utf-8",
            ".mjs": "application/javascript; charset=utf-8",
            ".css": "text/css; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".webmanifest": "application/manifest+json; charset=utf-8",
            ".svg": "image/svg+xml",
            ".png": "image/png",
            ".ico": "image/x-icon",
        }
        ctype = custom_types.get(ext) or mimetypes.guess_type(safe_path)[0] or "application/octet-stream"

        with open(safe_path, "rb") as f:
            content = f.read()

        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(content)))
        if os.path.basename(safe_path) == "sw.js":
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Service-Worker-Allowed", "/")
        self.end_headers()
        self.wfile.write(content)


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True


def main() -> None:
    init_db()
    server = ReusableThreadingHTTPServer((HOST, PORT), GrievanceHandler)
    print(f"OMNIS-X Student Grievance PWA running at http://localhost:{PORT}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down OMNIS-X Student PWA server...")
        server.server_close()


if __name__ == "__main__":
    main()
