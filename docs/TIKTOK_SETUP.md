# Onboarding TikTok — Guida operativa

Questa guida spiega come rendere **operativa** la pubblicazione su TikTok. Il
codice è già completo e deployato; mancano solo gli step di provisioning lato
TikTok (non fattibili da codice).

## Panoramica

TikTok pubblica via **Content Posting API (Direct Post)**. A differenza di Meta
e LinkedIn, l'access token dura **24 ore** ma c'è un **refresh token valido 365
giorni**: l'app rinnova l'access token da sola finché il refresh è valido.

Mappatura tipi di post:
- **video / reel** → 1 video
- **foto singola / carosello di sole foto** → photo post (1+ immagini)
- **carosello misto (foto+video)** → non supportato (limite TikTok)
- **story** → non supportato

## Step 1 — Crea l'app TikTok

1. Vai su <https://developers.tiktok.com/> → *Manage apps* → **Connect an app**.
2. Aggiungi il prodotto **Content Posting API** e **Login Kit**.
3. Richiedi gli scope: `video.publish` (obbligatorio) e `user.info.basic`.
   Eventualmente `video.upload`.
4. Annota **Client key** e **Client secret**.

## Step 2 — Verifica il dominio (OBBLIGATORIO)

La pubblicazione usa `PULL_FROM_URL`: TikTok scarica il media da un URL del
**nostro** dominio, che deve essere verificato, altrimenti l'init fallisce con
`url_ownership_unverified`.

1. Nel portale TikTok → sezione **URL properties / Domain verification**.
2. Aggiungi e verifica `media.emcdigitalsolutions.it` (TXT DNS o file).

## Step 3 — Registra il redirect URI

Nel Login Kit dell'app, tra i **Redirect URI** aggiungi esattamente:

```
https://media.emcdigitalsolutions.it/dashboard/tiktok/callback
```

(Deve combaciare al carattere con `BASE_URL` + `/dashboard/tiktok/callback`.)

## Step 4 — Imposta le chiavi app su Coolify

Aggiungi due variabili d'ambiente all'app `social-image-generator` su Coolify
(oppure nella pagina Impostazioni → settings DB):

```
TIKTOK_CLIENT_KEY=<client key>
TIKTOK_CLIENT_SECRET=<client secret>
```

Poi redeploy. **Mai** mettere queste chiavi nel codice.

## Step 5 — Connetti ogni cliente (OAuth, 1 click)

1. Apri il **dettaglio cliente** in dashboard.
2. Nella card *Credenziali social* → pulsante **🎵 Connetti account TikTok (OAuth)**.
3. Autorizza con l'account TikTok del cliente.
4. Al ritorno, access token + refresh token + open_id vengono salvati
   automaticamente; comparirà un badge con la scadenza del refresh token.

In alternativa puoi incollare i token a mano nei campi della card.

## Step 6 — Pubblica

Nell'editor di un post comparirà la checkbox **TikTok** tra i canali (visibile
solo se il cliente ha i token). Spunta e pubblica come per FB/IG/LinkedIn. Lo
scheduler auto-rileva TikTok tra i canali del cliente.

## Note importanti

- **App non auditata**: finché TikTok non approva l'app per la pubblicazione
  pubblica, i post possono uscire solo come **SELF_ONLY** (privati). La
  visibilità desiderata si imposta nella card cliente (campo *Visibilità post*)
  ma viene comunque validata contro le opzioni reali concesse dall'account.
- **Video**: TikTok richiede H.264. I video caricati vengono già normalizzati
  IG-safe (H.264/AAC) dal modulo `video-normalize.js`, quindi sono compatibili.
- **Caption**: la stessa caption (con menzioni `@` e CTA) usata per gli altri
  canali viene inviata come *title/description* del post TikTok (max 2200 char).

## Riferimenti

- Content Posting API: <https://developers.tiktok.com/doc/content-posting-api-get-started>
- Login Kit (Web): <https://developers.tiktok.com/doc/login-kit-web>
- Token management: <https://developers.tiktok.com/doc/oauth-user-access-token-management>
