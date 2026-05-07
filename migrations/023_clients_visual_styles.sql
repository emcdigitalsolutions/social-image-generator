-- Stili visivi per cliente: lista di "ricette" stilistiche tra cui ruotare
-- per evitare che le immagini AI generate si assomiglino tutte. Salvato
-- come JSON array di stringhe (es. ["editorial photography golden hour",
-- "minimal flat lay top-down", "macro close-up shallow DoF"]).
-- last_visual_style_index: indice dell'ultimo stile usato, per rotazione
-- senza ripetizioni immediate.

ALTER TABLE clients ADD COLUMN visual_styles TEXT;
ALTER TABLE clients ADD COLUMN last_visual_style_index INTEGER;
