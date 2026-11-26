#!/usr/bin/env python3
"""
Separated OMNIS-X Engine & Main Website Inbox Connection Module.

Supports:
- Real-time Inbox Alert Forwarding (`NEW_ISSUE`, `STATUS_UPDATE`, `RESOLVED`)
  with API key header (`X-API-Key` or custom header) and same-IP shorthand (`:3000/api/inbox`).
- Optional OMNIS-X Incident API / generic webhook forwarding.
"""

import json
import os
import threading
import urllib.error
import urllib.request
from typing import Any, Dict, List, Optional

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
ENGINE_CONFIG_PATH = os.path.join(BASE_DIR, "engine_config.json")

ROOM_TO_OMNISX_ENTITY: Dict[str, str] = {
    "SUB-01": "SUBSTATION-01",
    "UPS-01": "UPS-LAB-02",
    "SRV-01": "ROOM-MDF",
    "BUS-01": "GEN-500KVA",
    "CR-101": "CR-201",
    "CR-102": "CR-202",
    "CR-103": "LAB-03-COMP",
    "CR-104": "FEEDER-CR-F2",
    "VLSI-201": "LAB-01-EE",
    "ROB-202": "LAB-02-ROBOTICS",
    "HV-203": "FEEDER-LABS-F1",
    "SEM-204": "LH-01",
    "ADM-301": "PANEL-ENG-MAIN",
    "CTR-302": "ATS-01",
    "RF-303": "SUBSTATION-01",
}


def load_engine_config() -> Dict[str, Any]:
    """Loads connection settings from engine_config.json with env var overrides."""
    cfg: Dict[str, Any] = {
        "pwa_host": "0.0.0.0",
        "pwa_port": 8090,
        "website_name": "OMNIS-X • Apex Institute of Technology",
        "engine_mode": "inbox",
        "engine_base_url": "http://192.168.1.93:8000",
        "engine_incidents_path": "/api/v1/incidents",
        "engine_health_path": "/health",
        "engine_user_id": "USR-PRINCIPAL",
        "engine_auth_header": "",
        "inbox_url": "http://192.168.1.93:8000/api/v1/inbox/dispatch",
        "inbox_api_key_header": "X-OMNIS-API-KEY",
        "inbox_api_key": "omnis_pwa_secret_key_2026",
        "auto_forward": True,
    }
    if os.path.isfile(ENGINE_CONFIG_PATH):
        try:
            with open(ENGINE_CONFIG_PATH, "r", encoding="utf-8") as f:
                file_cfg = json.load(f)
            if isinstance(file_cfg, dict):
                cfg.update(file_cfg)
        except Exception:
            pass

    if os.environ.get("HOST"):
        cfg["pwa_host"] = os.environ["HOST"]
    if os.environ.get("PORT"):
        cfg["pwa_port"] = int(os.environ["PORT"])
    if os.environ.get("ENGINE_BASE_URL"):
        cfg["engine_base_url"] = os.environ["ENGINE_BASE_URL"].rstrip("/")
    elif os.environ.get("ENGINE_HOST"):
        e_port = os.environ.get("ENGINE_PORT", "8000")
        cfg["engine_base_url"] = f"http://{os.environ['ENGINE_HOST']}:{e_port}"
    if os.environ.get("ENGINE_MODE"):
        cfg["engine_mode"] = os.environ["ENGINE_MODE"]
    if os.environ.get("ENGINE_USER_ID"):
        cfg["engine_user_id"] = os.environ["ENGINE_USER_ID"]
    if os.environ.get("ENGINE_AUTH_HEADER"):
        cfg["engine_auth_header"] = os.environ["ENGINE_AUTH_HEADER"]
    if os.environ.get("INBOX_URL"):
        cfg["inbox_url"] = os.environ["INBOX_URL"].strip()
    if os.environ.get("INBOX_API_KEY"):
        cfg["inbox_api_key"] = os.environ["INBOX_API_KEY"].strip()
    if os.environ.get("INBOX_API_KEY_HEADER"):
        cfg["inbox_api_key_header"] = os.environ["INBOX_API_KEY_HEADER"].strip()

    cfg["engine_base_url"] = str(cfg["engine_base_url"]).rstrip("/")
    if cfg.get("inbox_url"):
        cfg["engine_incidents_url"] = cfg["inbox_url"]
    elif cfg["engine_mode"] == "omnisx":
        cfg["engine_incidents_url"] = f"{cfg['engine_base_url']}{cfg['engine_incidents_path']}"
    else:
        cfg["engine_incidents_url"] = cfg["engine_base_url"]
    return cfg


def resolve_entity_id(room_id: str, explicit_entity_id: str = "") -> str:
    return (explicit_entity_id or ROOM_TO_OMNISX_ENTITY.get(room_id, room_id)).strip()


def resolve_same_ip_url(target_url: str, request_host: str = "") -> str:
    """
    Allows same-IP shorthand such as ':3000/api/inbox' or '/api/inbox'
    by resolving against the incoming request's host IP (falling back to 127.0.0.1).
    """
    url = str(target_url or "").strip()
    if not url:
        return ""
    host_ip = "127.0.0.1"
    if request_host:
        host_ip = request_host.split(":", 1)[0].strip() or "127.0.0.1"
    if url.startswith(":"):
        return f"http://{host_ip}{url}"
    if url.startswith("/"):
        return f"http://{host_ip}{url}"
    return url


def build_auth_headers(auth_header: str = "", default_header_name: str = "X-API-Key") -> Dict[str, str]:
    headers: Dict[str, str] = {}
    raw = str(auth_header or "").strip()
    if not raw:
        return headers
    if ":" in raw and not raw.lower().startswith("bearer "):
        k, v = raw.split(":", 1)
        headers[k.strip()] = v.strip()
    elif raw.lower().startswith("bearer "):
        headers["Authorization"] = raw
    else:
        # Raw API key string -> send using configured API key header (default X-API-Key)
        headers[default_header_name or "X-API-Key"] = raw
    return headers


def build_omnisx_incident_payload(record: Dict[str, Any]) -> Dict[str, Any]:
    """Formats a student grievance into OMNIS-X IncidentCreate schema."""
    room_code = record["room_code"]
    room_name = record["room_name"]
    category = record["category"]
    sub_cat = record.get("sub_category", "")
    equipment = record.get("equipment", "") or "General"
    note = record.get("location_note", "") or "None"

    return {
        "title": f"[{room_code}] {record['title']}",
        "description": (
            f"{record['description']}\n"
            f"Category: {category} ({sub_cat}) | "
            f"Room: {room_code} ({room_name}) | "
            f"Equipment: {equipment} | "
            f"Note: {note}"
        ),
        "root_entity_id": resolve_entity_id(record["room_id"], record.get("backend_entity_id", "")),
        "source_type": "REPORTED",
        "source_id": record["ticket_code"],
        "priority": record["severity"],
        "metadata_json": {
            "ticketCode": record["ticket_code"],
            "category": category,
            "subCategory": sub_cat,
            "roomId": record["room_id"],
            "layerId": record["layer_id"],
            "equipment": record.get("equipment", ""),
            "locationNote": record.get("location_note", ""),
            "coordinates3D": {
                "x": record.get("pin_x", 0),
                "y": record.get("pin_y", 0),
                "z": record.get("pin_z", 0),
            },
            "anonymous": bool(record.get("anonymous", 0)),
            "studentId": record.get("student_id", ""),
        },
    }


def build_webhook_payload(record: Dict[str, Any]) -> Dict[str, Any]:
    """Formats a student grievance into generic JSON webhook format."""
    return {
        "event": "grievance.submitted",
        "ticketCode": record["ticket_code"],
        "id": record["id"],
        "category": record["category"],
        "subCategory": record.get("sub_category", ""),
        "title": record["title"],
        "description": record["description"],
        "severity": record["severity"],
        "location": {
            "layerId": record["layer_id"],
            "layerTitle": record.get("layer_title", ""),
            "roomId": record["room_id"],
            "roomCode": record["room_code"],
            "roomName": record["room_name"],
            "backendEntityId": resolve_entity_id(
                record["room_id"], record.get("backend_entity_id", "")
            ),
            "department": record.get("department", ""),
            "equipment": record.get("equipment", ""),
            "locationNote": record.get("location_note", ""),
            "coordinates3D": {
                "x": record.get("pin_x", 0),
                "y": record.get("pin_y", 0),
                "z": record.get("pin_z", 0),
            },
        },
        "reporter": {
            "anonymous": bool(record.get("anonymous", 0)),
            "name": record.get("student_name", ""),
            "studentId": record.get("student_id", ""),
            "contact": record.get("student_contact", ""),
        },
        "createdAt": record["created_at"],
    }


def build_inbox_alert_payload(
    record: Dict[str, Any],
    alert_type: str,
    message: str,
    target_users: List[str],
    actor_name: str,
    created_at: str,
) -> Dict[str, Any]:
    """
    Builds the exact JSON payload expected by OMNIS-X /api/v1/inbox/dispatch:
    { title, source, category, severity, message, entity_id, metadata }
    """
    entity_id = resolve_entity_id(record["room_id"], record.get("backend_entity_id", ""))
    prefix = f"[{alert_type}] " if alert_type != "NEW_ISSUE" else ""
    return {
        "title": f"{prefix}[{record['room_code']}] {record['title']}",
        "source": "Campus Grievance PWA",
        "category": str(record.get("category", "OTHER")).upper(),
        "severity": str(record.get("severity", "MEDIUM")).upper(),
        "message": message,
        "entity_id": entity_id,
        "metadata": {
            "event": "alert.created",
            "alertType": alert_type,
            "grievanceId": record["id"],
            "ticketCode": record["ticket_code"],
            "status": record["status"],
            "subCategory": record.get("sub_category", ""),
            "layerId": record["layer_id"],
            "roomId": record["room_id"],
            "roomCode": record["room_code"],
            "roomName": record["room_name"],
            "equipment": record.get("equipment", ""),
            "locationNote": record.get("location_note", ""),
            "assignedTo": record.get("assigned_to", ""),
            "targetUsers": target_users,
            "actorName": actor_name,
            "resolutionNote": record.get("resolution_note", ""),
            "coordinates3D": {
                "x": record.get("pin_x", 0),
                "y": record.get("pin_y", 0),
                "z": record.get("pin_z", 0),
            },
            "reported_from": "Campus PWA",
            "createdAt": created_at,
        },
    }


def post_json(
    target_url: str,
    payload: Dict[str, Any],
    auth_header: str = "",
    extra_headers: Optional[Dict[str, str]] = None,
    timeout: int = 5,
    api_key_header_name: str = "X-OMNIS-API-KEY",
) -> str:
    if not target_url or not target_url.startswith(("http://", "https://")):
        return "local_only"

    body = json.dumps(payload).encode("utf-8")
    headers = {
        "Content-Type": "application/json",
        "User-Agent": "OMNIS-X-Student-PWA/1.0",
    }
    if extra_headers:
        headers.update(extra_headers)
    headers.update(build_auth_headers(auth_header, default_header_name=api_key_header_name))

    req = urllib.request.Request(target_url, data=body, headers=headers, method="POST")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return f"forwarded ({resp.status})"
    except urllib.error.HTTPError as exc:
        return f"sync_http_{exc.code}"
    except Exception as exc:
        return f"saved_locally ({type(exc).__name__})"


def dispatch_alert_to_inbox(
    target_url: str,
    auth_header: str,
    record: Dict[str, Any],
    alert_type: str,
    message: str,
    target_users: List[str],
    actor_name: str,
    created_at: str,
    request_host: str = "",
    api_key_header_name: str = "X-OMNIS-API-KEY",
    async_send: bool = True,
) -> str:
    resolved_url = resolve_same_ip_url(target_url, request_host=request_host)
    if not resolved_url or not resolved_url.startswith(("http://", "https://")):
        return "local_only"

    payload = build_inbox_alert_payload(
        record=record,
        alert_type=alert_type,
        message=message,
        target_users=target_users,
        actor_name=actor_name,
        created_at=created_at,
    )
    extra = {"X-OMNISX-Event": f"alert.{alert_type.lower()}"}

    if async_send:
        t = threading.Thread(
            target=post_json,
            kwargs={
                "target_url": resolved_url,
                "payload": payload,
                "auth_header": auth_header,
                "extra_headers": extra,
                "api_key_header_name": api_key_header_name,
            },
            daemon=True,
        )
        t.start()
        return "inbox_queued"

    return post_json(
        resolved_url,
        payload,
        auth_header=auth_header,
        extra_headers=extra,
        api_key_header_name=api_key_header_name,
    )


def dispatch_record_to_engine(
    record: Dict[str, Any],
    target_url: str,
    mode: str = "inbox",
    omnisx_user_id: str = "USR-PRINCIPAL",
    auth_header: str = "",
    request_host: str = "",
) -> str:
    resolved_url = resolve_same_ip_url(target_url, request_host=request_host)
    if not resolved_url:
        return "local_only"
    if mode == "omnisx" or "/api/v1/incidents" in resolved_url:
        payload = build_omnisx_incident_payload(record)
        return post_json(
            resolved_url,
            payload,
            auth_header=auth_header,
            extra_headers={"X-User-Id": omnisx_user_id or "USR-PRINCIPAL"},
        )
    if mode == "inbox":
        # In inbox mode, real-time alerts are dispatched by dispatch_alert_to_inbox
        return "inbox_alerts_enabled"
    payload = build_webhook_payload(record)
    return post_json(
        resolved_url,
        payload,
        auth_header=auth_header,
        extra_headers={"X-OMNISX-Event": "grievance.created"},
    )


def ping_engine(
    target_url: str,
    auth_header: str = "",
    timestamp: str = "",
    request_host: str = "",
    api_key_header_name: str = "X-OMNIS-API-KEY",
) -> Dict[str, str]:
    resolved_url = resolve_same_ip_url(target_url, request_host=request_host)
    if "/api/v1/incidents" in resolved_url:
        health_url = resolved_url.split("/api/v1/incidents")[0] + "/health"
        try:
            with urllib.request.urlopen(health_url, timeout=4) as resp:
                return {"result": f"OMNIS-X online ({resp.status})", "url": health_url}
        except Exception as exc:
            return {"result": f"OMNIS-X unreachable ({type(exc).__name__})", "url": health_url}

    res = post_json(
        resolved_url,
        {
            "title": "Campus Grievance PWA Connection Test",
            "source": "Campus Grievance PWA",
            "category": "OTHER",
            "severity": "LOW",
            "message": "Test real-time inbox alert connection from Campus Grievance PWA",
            "entity_id": "CR-201",
            "metadata": {
                "event": "alert.ping",
                "alertType": "PING",
                "reported_from": "Campus PWA",
                "timestamp": timestamp,
            },
        },
        auth_header=auth_header,
        api_key_header_name=api_key_header_name,
    )
    return {"result": res, "url": resolved_url}
