ALTER TABLE clients ADD COLUMN gemini_api_key TEXT;
ALTER TABLE clients ADD COLUMN ai_provider TEXT NOT NULL DEFAULT 'gemini';
