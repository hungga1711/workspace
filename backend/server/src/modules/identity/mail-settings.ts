import type pg from "pg";
import { logger, secretBox, setMailSettings, type MailSettings } from "@workspace/service-kit";

/** The password is sealed with its own derived key (MAIL_SECRET_KEY overrides), like AI connection keys. */
const box = secretBox("mail-smtp", "MAIL_SECRET_KEY");

export const MAIL_PROVIDERS = ["google", "microsoft", "resend", "sendgrid", "mailgun", "ses", "postmark", "custom"] as const;
export type MailProvider = (typeof MAIL_PROVIDERS)[number];

export interface StoredMail {
  provider: MailProvider;
  host: string;
  port: number;
  security: MailSettings["security"];
  username: string | null;
  hasPassword: boolean;
  fromAddress: string;
  fromName: string | null;
  updatedAt: string;
}

interface Row {
  provider: MailProvider;
  host: string;
  port: number;
  security: MailSettings["security"];
  username: string | null;
  password_enc: string | null;
  from_address: string;
  from_name: string | null;
  updated_at: Date;
}

const fromHeader = (address: string, name: string | null) => (name ? `${name.replace(/["<>]/g, "")} <${address}>` : address);

export function toMailSettings(r: Pick<Row, "host" | "port" | "security" | "username" | "from_address" | "from_name">, password: string | null): MailSettings {
  return { host: r.host, port: r.port, security: r.security, user: r.username, password, from: fromHeader(r.from_address, r.from_name) };
}

async function read(pool: pg.Pool): Promise<Row | null> {
  return (
    (await pool.query<Row>("SELECT provider, host, port, security, username, password_enc, from_address, from_name, updated_at FROM mail_settings WHERE id = 1")).rows[0] ?? null
  );
}

/** The saved settings for the admin screen: never the password, only whether one is stored. */
export async function getMailSettings(pool: pg.Pool): Promise<StoredMail | null> {
  const r = await read(pool);
  if (!r) return null;
  return {
    provider: r.provider,
    host: r.host,
    port: r.port,
    security: r.security,
    username: r.username,
    hasPassword: !!r.password_enc,
    fromAddress: r.from_address,
    fromName: r.from_name,
    updatedAt: r.updated_at.toISOString(),
  };
}

/** The stored password, decrypted; null when none or unreadable (the base secret changed: the admin enters it again). */
export async function savedPassword(pool: pg.Pool): Promise<string | null> {
  const r = await read(pool);
  if (!r?.password_enc) return null;
  try {
    return box.decrypt(r.password_enc);
  } catch {
    return null;
  }
}

export interface MailInput {
  provider: MailProvider;
  host: string;
  port: number;
  security: MailSettings["security"];
  username: string | null;
  /** Undefined keeps the stored password; null clears it. */
  password?: string | null | undefined;
  fromAddress: string;
  fromName: string | null;
}

export async function saveMailSettings(pool: pg.Pool, input: MailInput, by: string): Promise<void> {
  const keep = input.password === undefined;
  const enc = keep ? null : input.password ? box.encrypt(input.password) : null;
  await pool.query(
    `INSERT INTO mail_settings (id, provider, host, port, security, username, password_enc, from_address, from_name, updated_by, updated_at)
     VALUES (1, $1, $2, $3, $4, $5, $6, $7, $8, $9, now())
     ON CONFLICT (id) DO UPDATE SET provider = $1, host = $2, port = $3, security = $4, username = $5,
       password_enc = CASE WHEN $10 THEN mail_settings.password_enc ELSE $6 END,
       from_address = $7, from_name = $8, updated_by = $9, updated_at = now()`,
    [input.provider, input.host, input.port, input.security, input.username, enc, input.fromAddress, input.fromName, by, keep],
  );
  await loadMailSettings(pool);
}

export async function clearMailSettings(pool: pg.Pool): Promise<void> {
  await pool.query("DELETE FROM mail_settings WHERE id = 1");
  setMailSettings(null);
}

/** Installs the saved settings for every mailer in this process (at start, after a save, and every minute). */
export async function loadMailSettings(pool: pg.Pool): Promise<void> {
  try {
    const r = await read(pool);
    setMailSettings(r ? toMailSettings(r, await savedPassword(pool)) : null);
  } catch (err) {
    logger.warn({ err }, "mail settings could not be loaded; keeping the previous ones");
  }
}
