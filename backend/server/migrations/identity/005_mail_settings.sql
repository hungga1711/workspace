-- Admin › Settings › Email: SMTP settings an admin enters in the app, so email works without editing .env
-- and restarting. One row; the password is AES-256-GCM sealed by the server (secretBox "mail-smtp"), never readable here.
CREATE TABLE mail_settings (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  provider text NOT NULL DEFAULT 'custom',
  host text NOT NULL,
  port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
  security text NOT NULL CHECK (security IN ('tls', 'starttls', 'none')),
  username text,
  password_enc text,
  from_address text NOT NULL,
  from_name text,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE mail_settings TO workspace_identity_rw;
