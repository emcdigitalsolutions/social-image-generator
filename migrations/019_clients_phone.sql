-- 019: Aggiunge campo telefono al cliente (per CTA su piani template)
--
-- Es. nei sub_topic dei post template: "Per info: {{phone}}" oppure
-- "Scrivici su WhatsApp: {{whatsapp_link}}"
--
-- Lasciato come stringa libera — l'utente può scrivere "+39 328 968 5670"
-- oppure "0922 911-100" o qualsiasi formato. La normalizzazione per
-- whatsapp_link viene fatta runtime (rimuove spazi, +, trattini).

ALTER TABLE clients ADD COLUMN phone TEXT;
