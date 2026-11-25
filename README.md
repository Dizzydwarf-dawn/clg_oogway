# OMNIS-X Student Grievance PWA (`pwa_grevince`)

This repository contains the phone-first **OMNIS-X Student Grievance PWA** under [`pwa_grevince/`](./pwa_grevince), with separated connection files for integrating with the **OMNIS-X (`JADE_PALACE`)** backend.

## Structure (`pwa_grevince/`)

- `pwa_grevince/public/` — Phone-first Student Grievance PWA (2D SVG campus floor plan + optional desktop 3D Twin, offline IndexedDB queue, Service Worker, Water / AC / Teacher Not Present / Power / IT categories)
- `pwa_grevince/public/engine.config.js` — Frontend connection mode (`'relay'` or `'direct'`) & Engine IP URL
- `pwa_grevince/public/src/engineClient.js` — Frontend API client targeting OMNIS-X `/api/v1/incidents`
- `pwa_grevince/engine_config.json` — Backend IP/port config (`engine_base_url`, `pwa_port`, `engine_user_id`)
- `pwa_grevince/engine_connector.py` — Python bridge mapping PWA rooms (`CR-101`–`RF-303`) to OMNIS-X `root_entity_id`
- `pwa_grevince/server.py` — Standalone PWA static + SQLite relay server
- `pwa_grevince/docs/ARCHITECTURE_AND_INTEGRATION.md` — Full architecture & integration guide

## Quick Start

```bash
cd pwa_grevince
ENGINE_BASE_URL=http://<NEW_ENGINE_IP>:8000 python3 server.py
```

Open `http://localhost:8090` (or `http://<HOST_IP>:8090` on mobile).
