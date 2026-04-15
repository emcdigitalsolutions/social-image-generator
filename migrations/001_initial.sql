-- Dashboard Social Media Management — Initial Schema

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'operator',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS clients (
  id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  sector TEXT,
  location TEXT,
  website TEXT,
  tagline TEXT,
  brand_name TEXT,
  logo_filename TEXT,
  theme_filename TEXT,
  fb_page_id TEXT,
  fb_system_user_token TEXT,
  ig_user_id TEXT,
  ig_access_token TEXT,
  system_instruction TEXT,
  gemini_api_key TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS questionnaires (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  token TEXT UNIQUE NOT NULL,
  sector TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  responses TEXT,
  submitted_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS editorial_plans (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  title TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  plan_data TEXT,
  ai_raw TEXT,
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS posts (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  editorial_plan_id TEXT REFERENCES editorial_plans(id) ON DELETE SET NULL,
  month_number INTEGER,
  week_number INTEGER,
  category TEXT,
  sub_topic TEXT,
  template TEXT,
  caption TEXT,
  caption_ai_raw TEXT,
  image_data TEXT,
  image_url TEXT,
  source_image_url TEXT,
  scheduled_date TEXT,
  scheduled_time TEXT,
  status TEXT NOT NULL DEFAULT 'draft',
  fb_post_id TEXT,
  ig_media_id TEXT,
  published_at TEXT,
  publish_error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  client_id TEXT NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
  editorial_plan_id TEXT REFERENCES editorial_plans(id) ON DELETE SET NULL,
  month_number INTEGER,
  cron_expression TEXT,
  is_active INTEGER NOT NULL DEFAULT 0,
  confirmed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_questionnaires_client ON questionnaires(client_id);
CREATE INDEX IF NOT EXISTS idx_questionnaires_token ON questionnaires(token);
CREATE INDEX IF NOT EXISTS idx_plans_client ON editorial_plans(client_id);
CREATE INDEX IF NOT EXISTS idx_posts_client ON posts(client_id);
CREATE INDEX IF NOT EXISTS idx_posts_plan ON posts(editorial_plan_id);
CREATE INDEX IF NOT EXISTS idx_posts_status ON posts(status);
CREATE INDEX IF NOT EXISTS idx_schedules_client ON schedules(client_id);
