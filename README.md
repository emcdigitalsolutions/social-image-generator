# Social Image Generator — EMC Dashboard

Dashboard interna EMC Digital Solutions per la gestione del servizio Social Media Management multi-cliente.

**URL produzione**: https://media.emcdigitalsolutions.it/dashboard

## Cosa fa

Per ogni cliente gestito dall'agenzia, l'app genera e pubblica contenuti social (Facebook + Instagram) in modo automatizzato, integrando:

- **AI multi-provider** (Claude / Gemini) per caption + piano editoriale
- **Puppeteer** per rendering template HTML → immagini 1080x1080
- **Meta Graph API** (Page Token derivato da System User EMC) per pubblicazione multi-platform
- **Carousel, Reel, Stories, Single image** via UI unica
- **Approvazione cliente** via link pubblico token-based (no login)
- **Insights Meta** giornalieri per ogni post pubblicato
- **Anteprima WYSIWYG** lato editor che simula il rendering FB/IG
- **Email notifier** su fallimenti pubblicazione

## Stack

- Backend: **Node.js 20** + **Express 4** + **EJS** (SSR)
- Database: **SQLite** (better-sqlite3 sync) con **WAL mode**, migrazioni numeriche in `migrations/`
- Deploy: **Docker** (node:20-slim) su **Coolify** (Hetzner)
- Auth: **JWT** (Bearer token API, cookie per page routes)
- AI: Anthropic Claude API + Google Gemini API (senza SDK, chiamate HTTPS dirette)

## Architettura moduli principali

```
server.js                     — Entry point Express + mount routes
lib/
  db.js                       — SQLite init + migrations runner
  auth.js                     — JWT login, seedUsers, middlewares
  ai.js / gemini.js           — Provider wrapper per i 2 LLM
  ai-provider.js              — Abstraction che sceglie Claude o Gemini per cliente
  browser.js                  — Singleton Puppeteer browser condiviso
  renderer.js                 — Genera immagini da template (Puppeteer)
  pdf.js                      — Export PDF piano editoriale (Puppeteer)
  meta-publish.js             — Publish FB/IG con atomicity (rollback se 1 fallisce)
  insights.js                 — Fetch Meta Insights (reach/engagement/likes)
  post-media.js               — Upload, validation, storage media cliente
  notifier.js                 — Email admin via SMTP
  scheduler.js                — Cron auto-publish (60s) + cron insights (04:00)
  settings.js                 — Helper key-value su tabella settings
  post-approvals → routes     — Endpoint approvazione token-based
routes/
  dashboard.js                — Page routes (login, approval pubblico)
  api/
    auth.js                   — Login, me
    clients.js                — CRUD clienti
    questionnaires.js         — Onboarding questionario
    plans.js                  — Piano editoriale (generate, edit, PDF)
    posts.js                  — Post CRUD, generate caption/image, publish, media
    approvals.js              — Workflow approvazione cliente
    schedules.js              — Auto-publish schedule per mese
    logs.js                   — Ring buffer log viewer
    settings.js               — GET/PUT settings globali
views/
  layout.ejs / layout-end.ejs — Skeleton admin dashboard
  dashboard.ejs               — Lista clienti
  client-detail.ejs           — Tab Profilo / Impostazioni / Questionario / Piano / Post
  plan-editor.ejs             — Vista piano + card KPI mesi + editor categorie + approvazioni
  month-view.ejs              — Calendario + Lista post + bulk actions
  post-editor.ejs             — Editor post (caption, media, publish, insights, preview)
  approval-public.ejs         — Pagina pubblica approvazione cliente
public/dashboard/             — CSS + JS shared (apiFetch, showAlert, toast)
migrations/                   — SQL numerati (001...010+)
templates/                    — HTML templates Puppeteer (quote, service, carousel, ecc.)
```

## Modello dati principale

```
clients (id, display_name, sector, location, brand_name, website, tagline,
         logo_filename, theme_filename, system_instruction,
         fb_page_id, fb_system_user_token, ig_user_id,
         ai_provider, anthropic_api_key, gemini_api_key,
         subscription_plan, subscription_price, editorial_months)

questionnaires (id, client_id, token, sector, status, responses, submitted_at)

editorial_plans (id, client_id, title, status, plan_data JSON, ai_raw)

posts (id, client_id, editorial_plan_id, month_number, week_number,
       category, sub_topic, template, media_type, ig_share_to_feed,
       caption, image_url, scheduled_date, scheduled_time,
       status, approval_status,
       fb_post_id, ig_media_id, published_at, publish_error)

post_media (id, post_id, position, kind, source, filename, url,
            width, height, bytes, styled_from_id)

monthly_approvals (id, plan_id, month_number, token, status,
                   expires_at, first_opened_at, approved_at)

post_comments (id, post_id, approval_id, author, text)

post_insights (id, post_id, platform, external_id, fetched_at,
               impressions, reach, likes, comments, shares, saves,
               clicks, video_views, engagement, raw_json)

schedules (id, editorial_plan_id, month_number, cron_expression, is_active)
settings (key, value, updated_at)
users (id, username, password_hash, display_name, role)
```

## Flusso principale end-to-end

1. **Onboarding cliente**: crea cliente nella dashboard, raccogli Page ID + System User Token + IG User ID
2. **Questionario**: genera link pubblico → il cliente compila → risposte salvate
3. **Piano editoriale AI**: `POST /api/plans/generate` usa le risposte per generare N mesi di post con `media_type` per ciascuno
4. **Per ogni post**: genera caption AI + immagine (renderer template) o upload manuale
5. **Approvazione cliente**: crea link approvazione mensile → cliente approva / chiede modifiche → i post approvati diventano pubblicabili
6. **Publish**: scheduler cron (60s) pubblica i `ready + approved + scheduled_date <= now` su FB + IG. Rollback cross-platform se uno dei due fallisce.
7. **Insights**: cron giornaliero 04:00 recupera reach/engagement per tutti i post pubblicati negli ultimi 30gg

## Setup sviluppo locale

```bash
# Prerequisiti: Node 20, Chromium installato (o PUPPETEER_EXECUTABLE_PATH in .env)
git clone https://github.com/emcdigitalsolutions/social-image-generator
cd social-image-generator
npm install

# Variabili richieste
export PORT=3100
export DB_PATH=./data/dashboard.db
export JWT_SECRET=...
export DASHBOARD_USERS=admin:password
export BASE_URL=http://localhost:3100
export API_KEY=...              # per /generate legacy
export SMTP_HOST=smtp.gmail.com
export SMTP_PORT=587
export SMTP_USER=...
export SMTP_PASS=...
export NOTIFY_TO=emcdigitalsolution@gmail.com

node server.js
# → http://localhost:3100/dashboard
```

Al primo avvio crea DB, applica migrations, seed admin user da `DASHBOARD_USERS`.

## Deploy produzione

Push master → webhook Coolify → rebuild container Docker → auto deploy.

Se webhook non triggera:
```bash
curl -X POST http://49.13.173.127:8000/api/v1/applications/hcbf6qsi1f97t0ea636x55f7/restart \
  -H "Authorization: Bearer <coolify_token>"
```

Dettagli infrastruttura (volumi, credenziali, backup) in `memory/social-image-generator.md`.

## Migrazioni

Creare `migrations/NNN_descrizione.sql`, applicate automaticamente al prossimo boot. Numerazione sequenziale, ogni file eseguito una volta sola (tracking in tabella `_migrations`).

## Logs runtime

Log in-memory ring buffer (500 righe) visibile da `/dashboard/logs` (auth required). Persiste su stdout container (visibile via Coolify logs).

## Licenza e ownership

Codebase privata, EMC Digital Solutions. Non ridistribuire. Include chiavi API cifrate in `memory/` per gestione segreti con DPAPI.
