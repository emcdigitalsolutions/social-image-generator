# Manuale Operativo EMC — Social Image Generator

Guida passo-passo per l'operatore (Enrico). Dalla creazione di un cliente fino alla prima pubblicazione approvata dal cliente.

**URL dashboard**: https://media.emcdigitalsolutions.it/dashboard

---

## 0. Accesso dashboard

1. Apri il link e fai login con le credenziali admin
2. Dalla lista clienti puoi creare nuovi, aprire esistenti, eliminare

---

## 1. Creare un nuovo cliente

**Dashboard → Clienti → Nuovo cliente**

Campi base:
- **ID slug** (es. `fratellidirosa`, `terredimiele`): lowercase, niente spazi, univoco
- **Display name**: nome completo (es. "Fratelli Di Rosa")
- **Brand name, Settore, Località, Sito web, Tagline**: completa quello che sai

Sezione Subscription (informativa, interna EMC):
- **Piano commerciale**: "Social Media Pro", "Social Basic", ecc.
- **Prezzo mensile**: 150, 80, ecc. (€)
- **Mesi piano editoriale**: quanti mesi la generazione AI deve coprire (default 6, puoi mettere 12 per clienti premium)

---

## 2. Onboarding Meta del cliente

Il cliente deve autorizzarti sulla sua Page FB prima che tu possa pubblicare.

### 2.1 Invia il messaggio onboarding
Apri `memory/client-onboarding-meta.md` (nella tua memoria locale), copia il messaggio "Da inoltrare al cliente" e personalizza con nome + social. Lo trovi anche in `memory/clients-meta-pages.md` con esempi già adattati per ogni cliente.

### 2.2 Quando il cliente accetta
- Dal tuo Business Manager EMC verifica che la Page sia entrata come asset
- Assegna la Page al System User "EMC n8n-publisher" con permessi "Pubblica contenuti" + "Gestisci"
- Verifica via API:
  ```bash
  curl "https://graph.facebook.com/v25.0/me/accounts?access_token=<TUO_TOKEN>"
  ```
  Deve apparire la Page cliente con `instagram_business_account.id` se IG linkato

### 2.3 Salva credenziali in dashboard
Profilo cliente → sezione **Credenziali Social**:
- Page ID
- FB System User Token (lo stesso EMC per tutti i clienti)
- IG User ID (preso dal response `instagram_business_account.id`)
- IG Access Token: lascia vuoto (non serve più col refactor Page Token)

---

## 3. Branding cliente

### 3.1 Logo
Tab Profilo → sezione Logo → carica SVG/PNG/JPG. Verrà usato negli overlay template.

### 3.2 Tema colori
- Opzione A: carichi un CSS custom pronto
- Opzione B: usi "Scansiona Sito" (richiede AI call) + "Genera Tema da colori" per far creare all'AI le 17 variabili CSS del tema

### 3.3 System Instruction AI
Tab Impostazioni → genera automaticamente cliccando "Genera System Instruction" (usa le risposte questionario + dati brand). Puoi poi modificare a mano.

---

## 4. Questionario onboarding

Tab Questionario → "Crea questionario" → seleziona settore → si genera un link pubblico tipo `/dashboard/q/<token>`. Mandalo al cliente via WhatsApp/email.

Il cliente compila dal browser (no login). Al submit le risposte arrivano in dashboard.

---

## 5. Generare il piano editoriale AI

Tab Piano Editoriale → **Genera nuovo piano**.

Il sistema:
- Legge le risposte del questionario (es. "Quanti post al mese vorresti?" → 8 / 12 / 16 / 20)
- Chiama Claude o Gemini (in base al provider impostato nel cliente)
- Genera JSON con categorie (C1..C6) + mesi × settimane × post (con `media_type` suggerito per ogni post: single_image / carousel / reel / story)
- Crea automaticamente tutti i post draft in DB

Se il JSON AI è troncato/malformato: apre automaticamente un **editor JSON inline** per correzioni manuali, poi "Salva e ricostruisci post".

---

## 6. Editare categorie / rigenerare

Nella vista Piano:
- Tabella **Categorie editabili** (codice, nome, frequenza, descrizione)
- Bottoni **+ Aggiungi categoria**, **× Rimuovi**
- Click **✨ Rigenera** su una categoria → l'AI ricrea i post draft di QUELLA categoria senza toccare il resto del piano
- **Esporta PDF** del piano completo → da allegare alla mail di presentazione al cliente

---

## 7. Lavorare sui singoli post

Click su una card post nella Vista Mese → si apre l'editor.

### Tipo post (4 chip)
- **Singola**: 1 immagine + caption (default)
- **Carousel**: 2-10 immagini o video (stesso tipo)
- **Reel**: 1 video verticale 9:16, 3-90s
- **Storia**: suggerimento manuale al cliente (non pubblicabile da noi via API)

### Caption
- Click **Genera Caption** → AI scrive seguendo il brand voice
- Il sistema converte automaticamente `**bold**` e `*italic*` in Unicode bold/italic renderizzato nativamente da FB/IG (trick yaytext)

### Media
- **Upload drag&drop** (massimo 10 file, jpg/png/webp 8MB, mp4/mov 100MB)
- Validazione aspect ratio: warning se fuori 4:5 / 1.91:1 (non accettato da IG)
- **Click sulla thumb** → lightbox con crop interattivo (Cropper.js) + preset ratio (1:1, 4:5, 9:16, 16:9)
- **Stilizza**: overlay brand Puppeteer su un'immagine (applica logo + tagline)
- **Selezione multipla** + **Rimuovi selezionati** per pulizia rapida

### Data / ora
- Campo data + ora per lo schedule auto-publish
- Bottone **🕐 Orario default** (nella vista mese, in alto): applica orario best-time a tutti i post del mese in un click (preset FB 14:00, IG 18:00, Misto 14:30)

### Anteprima WYSIWYG
Card "Anteprima" mostra come il post apparirà su IG o FB nativo (tab switch). Si aggiorna live mentre scrivi.

---

## 8. Approvazione cliente

Tab Piano Editoriale → scorri in basso → card **Approvazioni cliente**.

Per ogni mese del piano:
- Click **Genera link** → crea link unico tipo `/dashboard/approve/<token>` (scadenza default 30gg)
- Click **Copia** → il link finisce negli appunti
- Mandalo al cliente via WhatsApp/email

### Lato cliente
Il cliente apre il link (no login). Vede tutti i post del mese con:
- Preview media + caption
- 3 azioni per post: ✅ Approva · ✏️ Chiedi modifica · ❌ Rifiuta
- Bottone "Approva tutti i restanti" per bulk-approve

Ogni azione **manda email a emcdigitalsolution@gmail.com** per avvertirti.

### Dopo l'approvazione
Solo i post con `approval_status = 'approved'` vengono pubblicati automaticamente dallo scheduler. I post `pending / change_requested / rejected` restano fermi finché non li sistemi + il cliente approva di nuovo.

---

## 9. Pubblicazione

### Manuale
Card **Pubblicazione** nell'editor post:
- Checkbox **Facebook** / **Instagram** (default entrambi)
- Bottone **Pubblica** (si adatta: "Pubblica su FB + IG" / "solo Facebook" / "solo Instagram")
- Click → pubblica in ~10-40s (carousel/reel più lenti per via del polling IG)
- Bottone diventa **Pubblica di nuovo** se già pubblicato (crea un secondo post, non modifica l'esistente)

### Automatica (scheduler)
Cron ogni 60s controlla post `ready + approved + scheduled_date <= now + mese confermato`. Pubblica. Se fallisce, email admin + post flaggato `failed`.

### Atomicity cross-platform
Se l'utente ha scelto FB + IG ma uno dei due fallisce, il riuscito viene **rollback** (DELETE via API) così non restano post "zoppi".

---

## 10. Insights post-pubblicazione

Card **📊 Insights** nell'editor (visibile solo se post published):
- Mostra per ogni piattaforma: impressioni, reach, like, commenti, condivisioni, salvataggi, click, video views, engagement totale
- Cron giornaliero alle 04:00 aggiorna tutti i post pubblicati negli ultimi 30gg
- Bottone **↻ Aggiorna** per refresh on-demand

Usa queste metriche per presentare al cliente a fine mese ("il tuo carosello servizi ha fatto 3.4k impressioni, 127 like").

---

## 11. Troubleshooting comuni

| Sintomo | Causa probabile | Soluzione |
|---|---|---|
| "Caption generation failed" | Quota Gemini esaurita / overload | Attendi 5-10 min o passa al paid tier ($1/mese) |
| "Aspect ratio non valido" su IG | Immagine fuori range 4:5–1.91:1 | Crop tool nel lightbox → preset 1:1 o 4:5 |
| Post pubblicato ma cliente non lo vede | App Meta in Development mode | Passa in Live (toggle dashboard app, già fatto per EMC) |
| Link approvazione scaduto | Default 30gg | Elimina la vecchia approvazione e rigenera |
| IG video rifiutato con "VIDEO media_type obsoleto" | Codice già aggiornato a REELS — se ricorre, Meta ha cambiato API | Aggiorna `lib/meta-publish.js` |
| Quota reset Gemini domani | Free tier 50/day | Nulla, riprova domani o paid |
| Cliente non trova notifica richiesta BM | FB notifica arriva in posto non ovvio | Manda link diretto `business.facebook.com/settings/requests` |

---

## 12. Lavoro mensile tipo (cheat sheet)

Per ogni cliente attivo, ogni mese:

1. **Lunedì inizio mese**: rigenera (o continua) piano editoriale per il mese in corso
2. Rivedi post del mese (vista Mese → Lista), sistema date/orari
3. Click **Genera caption + immagini** bulk per i post single_image
4. Carica manualmente media per carousel / reel / story
5. Click **Genera link approvazione mensile** → manda al cliente
6. Attendi approvazioni (email ad ogni azione cliente)
7. Per post con "modifica richiesta": leggi commento, edita, re-genera link approvazione
8. Quando tutti i post del mese sono `approved`: click **Conferma Mese** → scheduler auto-publish entra in azione
9. A fine mese: export PDF piano + screenshot insights → mail al cliente per rendicontazione

Tempo medio per cliente: ~2h/mese a regime.

---

## 13. Contatti e supporto

- Infrastruttura: Hetzner + Coolify (UUID `hcbf6qsi1f97t0ea636x55f7`)
- Dominio: `media.emcdigitalsolutions.it`
- DB + media: volume persistente Coolify (`/app/data` + `/app/public/images`)
- Backup: giornaliero 03:00, ultimi 7 tenuti (`data/backups/`)
- Meta App: "EMC Social Manager" (ID `2032202394359422`, LIVE)
- System User Token: gestito nel profilo cliente EMC (lo stesso per tutti)
