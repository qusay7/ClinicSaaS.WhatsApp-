# ClinicSaaS.WhatsApp

Internal WhatsApp connection service for ClinicSaaS, built on [Baileys](https://github.com/WhiskeySockets/Baileys) —
links each clinic's own WhatsApp number directly (scan a QR once) instead of going through a paid
gateway like UltraMsg. One independent session per clinic, keyed by `clinicId`.

**This service has no authentication of its own and must never be reachable from the browser or the
public internet.** The ASP.NET backend (`ClinicSaaS.API`) is the only intended caller — it proxies
requests through its own auth/permission checks (`WhatsAppController` + `WhatsAppConnectionService`).

## Running

```
npm install
npm start
```

Listens on `http://localhost:3001` by default (see `PORT` in `index.js`). Set `WhatsAppService:BaseUrl`
in the backend's `appsettings.json` to point at wherever this runs.

## Endpoints

- `POST /clinics/:clinicId/start` — begin (or resume) linking that clinic's number
- `GET /clinics/:clinicId/status` — `{ status }` — `not_started | connecting | qr | open | reconnecting | logged_out`
- `GET /clinics/:clinicId/qr-data` — `{ status, qrDataUrl }` — for backends to relay to their own frontend
- `GET /clinics/:clinicId/qr` — the QR as a raw PNG image, for direct/manual testing
- `POST /clinics/:clinicId/send` — `{ phone, message }` → `{ ok: true }`

## Sessions

Each clinic's linked-device credentials live under `auth_by_clinic/<clinicId>/` — these **are** the live
session (equivalent to a logged-in WhatsApp Web tab) and are gitignored. Losing this folder means
re-scanning a QR; leaking it means anyone with the files can send/receive as that clinic's number.
Sessions are restored automatically on startup for every folder found there.
