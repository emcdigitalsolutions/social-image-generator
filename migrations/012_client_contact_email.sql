-- Email di contatto del cliente (opzionale).
-- Usata dal reminder mensile per notificare al cliente che c'è un piano in
-- attesa di approvazione. Se NULL il reminder invia solo all'admin.
ALTER TABLE clients ADD COLUMN contact_email TEXT;
