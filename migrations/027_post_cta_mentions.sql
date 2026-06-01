-- Call To Action + menzioni (@username) per-post.
-- I post organici Meta non supportano bottoni CTA nativi: la CTA è una riga di
-- testo appesa alla caption (label + URL/telefono opzionale). Le menzioni sono
-- una lista di @username inserita in caption (sicuro/universale; "taggare tutti
-- gli amici" non è supportato dalle API Meta). La composizione finale avviene
-- in lib/post-caption.js, usata sia al publish sia nell'anteprima.
ALTER TABLE posts ADD COLUMN cta_label TEXT;
ALTER TABLE posts ADD COLUMN cta_url TEXT;
ALTER TABLE posts ADD COLUMN mentions TEXT; -- JSON array di handle, es. ["@mario","@negozio"]
