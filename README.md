# OMNIS-X Student Grievance PWA — Integration Bundle

This repository contains [`omnisx-pwa-integration.zip`](./omnisx-pwa-integration.zip), a lightweight phone-first Student Grievance PWA with separated connection files for integrating with the **OMNIS-X (`JADE_PALACE`)** backend.

## Contents Inside `omnisx-pwa-integration.zip`

- `campus-grievance-pwa/public/` — Phone-first Student Grievance PWA (2D SVG campus floor plan + optional desktop 3D Twin, offline IndexedDB queue, Service Worker, Water / AC / Teacher Not Present / Power / IT categories)
- `campus-grievance-pwa/public/engine.config.js` — Frontend connection mode (`'relay'` or `'direct'`) & Engine IP URL
- `campus-grievance-pwa/public/src/engineClient.js` — Frontend API client targeting OMNIS-X `/api/v1/incidents`
- `campus-grievance-pwa/engine_config.json` — Backend IP/port config (`engine_base_url`, `pwa_port`, `engine_user_id`)
- `campus-grievance-pwa/engine_connector.py` — Python bridge mapping PWA rooms (`CR-101`–`RF-303`) to OMNIS-X `root_entity_id`
- `campus-grievance-pwa/server.py` — Standalone PWA static + SQLite relay server
- `campus-grievance-pwa/docs/ARCHITECTURE_AND_INTEGRATION.md` — Full architecture & integration guide

## Quick Integration with a New Engine IP

1. **Relay Mode (recommended across phones/LAN without CORS issues)**:
   - Unzip `omnisx-pwa-integration.zip`.
   - Set `"engine_base_url": "http://<NEW_ENGINE_IP>:8000"` in `engine_config.json` (or run `ENGINE_BASE_URL=http://<NEW_ENGINE_IP>:8000 python3 server.py`).
2. **Direct Mode (hosted inside `JADE_PALACE`)**:
   - Copy `public/` into `omnis-x/frontend/public/pwa/` (or mount via FastAPI `StaticFiles`).
   - Update `public/engine.config.js` to `mode: 'direct'` and `engineBaseUrl: 'http://<NEW_ENGINE_IP>:8000'`.
