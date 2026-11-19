-- Whether a connection's AI may use its own web and cloud tools (search the web, read a linked page, its code sandbox)
-- when a question needs them. On by default; an admin switches it off per connection (Admin › Kết nối AI).
ALTER TABLE ai_connections ADD COLUMN IF NOT EXISTS web_tools boolean NOT NULL DEFAULT true;
