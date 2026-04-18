-- Add commercial subscription fields to clients

ALTER TABLE clients ADD COLUMN subscription_plan TEXT;
ALTER TABLE clients ADD COLUMN subscription_price REAL;
ALTER TABLE clients ADD COLUMN subscription_notes TEXT;
