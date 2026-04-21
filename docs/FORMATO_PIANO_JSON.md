# Formato JSON per l'import del piano editoriale

Documento di riferimento per chi prepara **offline** un piano editoriale e poi lo carica in dashboard via il bottone "Importa JSON". Utile quando il generatore AI built-in è quota-limited o quando vuoi controllo totale sul contenuto.

Endpoint che accetta questo formato: `POST /api/plans/import`

---

## Schema minimo

```json
{
  "title": "Piano Editoriale — <Nome Cliente>",
  "categories": [
    { "code": "C1", "name": "...", "frequency": "1-2/mese", "description": "..." }
  ],
  "months": [
    {
      "month_number": 1,
      "weeks": [
        {
          "week_number": 1,
          "posts": [
            {
              "day": "martedì",
              "time": "10:00",
              "category": "C1",
              "sub_topic": "...",
              "media_type": "single_image",
              "template": "quote",
              "notes": "..."
            }
          ]
        }
      ]
    }
  ]
}
```

---

## Campi obbligatori vs opzionali

### Livello piano
| Campo | Obbligatorio | Tipo | Note |
|---|---|---|---|
| `title` | no | string | Se assente, usato default "Piano Editoriale — `<display_name>`" |
| `categories` | no | array | Se assente la sezione categorie nell'UI resta vuota ma il piano funziona |
| `months` | **sì** | array non vuoto | Almeno 1 mese |

### Livello categoria
| Campo | Obbligatorio | Tipo | Note |
|---|---|---|---|
| `code` | sì | string | Es. "C1", "C7". Usato nei posts per collegarli alla categoria |
| `name` | sì | string | Nome leggibile |
| `frequency` | no | string | "1/mese", "1-2/mese", "settimanale" |
| `description` | no | string | Breve descrizione della linea editoriale |

### Livello mese
| Campo | Obbligatorio | Tipo |
|---|---|---|
| `month_number` | sì | integer (1..N) |
| `weeks` | no | array (può essere vuoto → mese vuoto) |

### Livello settimana
| Campo | Obbligatorio | Tipo |
|---|---|---|
| `week_number` | sì | integer (1..5) |
| `posts` | no | array di post |

### Livello post (il più importante)
| Campo | Obbligatorio | Tipo | Valori consentiti / Note |
|---|---|---|---|
| `category` | no | string | Deve matchare un `categories[].code` (es. "C1") |
| `sub_topic` | no | string | Titolo specifico del post (es. "Il nostro laboratorio floreale") |
| `media_type` | **sì (consigliato)** | string | Uno di: `single_image` / `carousel` / `reel` / `story`. Default `single_image` se mancante. |
| `template` | no | string | SOLO per `single_image`. Valori: `quote`, `service`, `event`, `floral`, `advice`. Default `quote`. |
| `day` | no | string | Solo per documentazione (es. "martedì"). Non blocca nulla. |
| `time` | no | string | Come sopra. Per auto-publish l'orario va impostato dopo l'import dalla UI. |
| `notes` | no | string | Note interne, non usate in pubblicazione |

---

## Linee guida per i contenuti (per chi scrive il piano)

### Distribuzione mensile consigliata
Su **8 post al mese** (2 a settimana):
- ~4-5 `single_image` (statici, AI-generable, pubblicabili in automatico)
- ~1-2 `carousel` (approfondimenti: servizi multipli, prima/dopo, step-by-step)
- ~1-2 `reel` (video verticale 9:16, 3-90s: dietro le quinte, anteprime)
- 0-2 `story` (**EXTRA** rispetto agli 8, non conteggiate: sono suggerimenti che il cliente pubblica dalla sua app — durano 24h, non le pubblichiamo noi)

Adatta proporzionalmente se il cliente vuole 12, 16, 20 post/mese.

### Categorie comuni (ispirazione)
Per settore generico: Servizi · Valori/Team · Case Study · Consigli/Guide · Eventi/News locali · FAQ · Dietro le quinte

Per settore **agenzia funebre** (es. Fratelli Di Rosa): Servizi offerti · Partecipazione al lutto · Anniversari · Trigesimi · Disponibilità H24 · Laboratorio floreale · Territorio

Per settore **apicoltura** (es. Terre di Miele): Prodotti · Stagionalità del miele · Dietro l'alveare · Ricette con miele · Storia dell'azienda · Fiere/Mercati · Curiosità api

### Regole di scrittura `sub_topic`
- Specifico, non generico. ❌ "Post servizio" → ✅ "Il nostro laboratorio floreale interno per addobbi personalizzati"
- Azionabile dall'AI di caption generation: da quel sub_topic deve essere possibile scrivere un post con contenuto vero
- Non ripetitivo: controlla che nei 6 mesi non ci siano 4 post con lo stesso sub_topic

### Media type scelta
- Vuoi presentare **più prodotti/servizi**? → `carousel`
- Vuoi **momento dinamico** (lavorazione, processi, team al lavoro)? → `reel`
- Vuoi **messaggio concettuale** (frase forte, annuncio)? → `single_image` con template `quote`
- Vuoi **richiamo immediato** (urgenza, sondaggio, live update)? → `story`

### Esempio concreto di 1 settimana per Fratelli Di Rosa

```json
{
  "week_number": 1,
  "posts": [
    {
      "day": "martedì",
      "time": "14:30",
      "category": "C1",
      "sub_topic": "Disponibilità H24, sempre al tuo fianco",
      "media_type": "single_image",
      "template": "service",
      "notes": "Foto sede o numero in evidenza"
    },
    {
      "day": "giovedì",
      "time": "18:00",
      "category": "C6",
      "sub_topic": "Il nostro laboratorio floreale: dal fiore all'addobbo",
      "media_type": "reel",
      "notes": "Video 30s, time-lapse lavorazione corona"
    }
  ]
}
```

---

## Come preparare il JSON

### Metodo 1: Claude Code (raccomandato)
Chiedi a Claude (questa sessione) qualcosa tipo:

> Prepara un piano editoriale di 6 mesi per il cliente "Terre di Miele", settore apicoltura, con 12 post/mese (3 a settimana), distribuzione media_type standard. Salva il file in docs/esempi/piano_terredimiele.json.

Claude produce il JSON seguendo questo schema, tu scarichi dal filesystem locale e carichi in dashboard.

### Metodo 2: editor di testo
Apri un `.json`, segui lo schema sopra, validato da qualunque JSON linter.

### Metodo 3: duplicare un piano esistente
Esporta il `plan_data` di un piano già creato (via `GET /api/plans/:id`), modificalo, importalo di nuovo. Utile per riutilizzo incrociato tra clienti dello stesso settore.

---

## Import in dashboard (come utente)

1. Dashboard → cliente → tab **Piano Editoriale**
2. Click **↑ Importa JSON**
3. Seleziona il file `.json` dal tuo computer
4. Conferma dialog
5. Il piano appare nella lista come nuovo draft

Da lì puoi:
- Aprirlo e modificarlo a mano (vista Categorie editabile)
- Lanciare generazione caption e immagini sui post
- Generare link approvazione mese per il cliente
- Pubblicare

Lo status del piano dopo import è `draft`: nessun auto-publish finché non confermi mese per mese.

---

## Errori possibili

| Errore | Causa | Fix |
|---|---|---|
| `plan_data non valido: plan_data.months deve essere un array non vuoto` | Manca o vuoto `months` | Aggiungi almeno 1 mese |
| `month X: weeks deve essere un array` | Campo non-array | Usa `"weeks": [...]` anche se vuoto |
| `month X: week senza week_number` | Week senza `week_number` | Aggiungi intero |
| `client_id richiesto` | Manca nel body | Viene aggiunto automaticamente dalla UI, se usi curl devi includerlo |
| `Client not found` | client_id non esiste in DB | Crea prima il cliente nella dashboard |

---

## Esempio JSON completo minimale (copia-incolla per partire)

```json
{
  "title": "Piano Editoriale Esempio - 2 mesi",
  "categories": [
    { "code": "C1", "name": "Servizi", "frequency": "2-3/mese", "description": "Presentazione servizi chiave" },
    { "code": "C2", "name": "Team", "frequency": "1/mese", "description": "Chi siamo" }
  ],
  "months": [
    {
      "month_number": 1,
      "weeks": [
        {
          "week_number": 1,
          "posts": [
            { "day": "martedì", "time": "14:30", "category": "C1", "sub_topic": "Servizio A", "media_type": "single_image", "template": "service" },
            { "day": "giovedì", "time": "18:00", "category": "C1", "sub_topic": "Servizio B in carosello", "media_type": "carousel" }
          ]
        },
        {
          "week_number": 2,
          "posts": [
            { "day": "martedì", "time": "14:30", "category": "C2", "sub_topic": "Presentazione team", "media_type": "reel" }
          ]
        }
      ]
    },
    {
      "month_number": 2,
      "weeks": []
    }
  ]
}
```
