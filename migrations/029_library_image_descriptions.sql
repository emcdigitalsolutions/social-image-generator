-- Descrizioni AI delle immagini di libreria, per il match caption -> immagine.
-- Un modello vision (Gemini Flash) analizza ogni immagine UNA volta e ne salva
-- una descrizione + tag in italiano; il risultato resta in cache e viene usato
-- dal pulsante "Scegli da libreria" per allegare automaticamente al post le
-- immagini più coerenti con la caption. Vedi lib/gemini-vision.js + lib/library-match.js.
ALTER TABLE client_media_library ADD COLUMN description TEXT;       -- descrizione concisa (IT)
ALTER TABLE client_media_library ADD COLUMN tags TEXT;             -- JSON array di keyword
ALTER TABLE client_media_library ADD COLUMN vision_model TEXT;     -- modello che ha analizzato
ALTER TABLE client_media_library ADD COLUMN analyzed_at TEXT;      -- timestamp analisi
