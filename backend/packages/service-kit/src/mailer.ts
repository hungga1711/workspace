import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import nodemailer, { type Transporter } from "nodemailer";
import { currentRequestId } from "@workspace/shared";
import { logger } from "./logger.js";

/**
 * Transactional email over SMTP: SMTP_URL points at the company's mail server (smtp://user:pass@host:587, or smtps://
 * on port 465), in development too. Testing by hand: invite or reset an address at yopmail.com and open its inbox.
 *
 * Email is optional: a company without a mail server runs without SMTP_URL. Every sender then gets
 * MailNotConfiguredError and offers the link it would have mailed (invite activation, password reset) instead.
 *
 * Automated tests set MAIL_OUTBOX_DIR instead (ignored in production): each email is written there as a JSON file,
 * which the integration and end-to-end suites read (readOutbox).
 */
export interface Mail {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export interface Mailer {
  send(mail: Mail): Promise<void>;
  /** False when no SMTP server is configured (no SMTP_URL); absent means configured. */
  configured?: boolean;
}

export class MailNotConfiguredError extends Error {
  readonly code = "mail_not_configured";
  constructor() {
    super("SMTP_URL is not set: no email can be sent");
    this.name = "MailNotConfiguredError";
  }
}

/** Where test emails are written, outside production only. */
function outboxDir(): string | undefined {
  return process.env.NODE_ENV === "production" ? undefined : process.env.MAIL_OUTBOX_DIR || undefined;
}

/** Whether email can go out: SMTP_URL is set (or, outside production, MAIL_OUTBOX_DIR). */
export function mailConfigured(url = process.env.SMTP_URL): boolean {
  return !!url || !!outboxDir();
}

export function smtpMailer(url = process.env.SMTP_URL, from = process.env.MAIL_FROM ?? "workspace <no-reply@workspace.local>"): Mailer {
  const dir = url ? undefined : outboxDir();
  if (dir) {
    mkdirSync(dir, { recursive: true });
    return {
      configured: true,
      async send(mail) {
        const at = new Date().toISOString();
        await writeFile(join(dir, `${at.replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}.json`), JSON.stringify({ from, ...mail, at }));
      },
    };
  }
  if (!url) {
    let warned = false;
    return {
      configured: false,
      async send(mail) {
        // Once per process: the admin screens say it too, and every invite would otherwise repeat the line.
        if (!warned) {
          warned = true;
          logger.warn({ subject: mail.subject }, "SMTP_URL is not set: emails are not sent (invites and resets must be handed over as links)");
        }
        throw new MailNotConfiguredError();
      },
    };
  }
  const transport: Transporter = nodemailer.createTransport(url);
  return {
    configured: true,
    async send(mail) {
      await transport.sendMail({ from, ...mail, headers: { "X-Request-Id": currentRequestId() ?? "" } });
      logger.info({ to: maskAddress(mail.to), subject: mail.subject }, "email sent");
    },
  };
}

/**
 * SMTP settings an admin saved in the app (Admin › Settings › Email). They win over SMTP_URL/MAIL_FROM so a company
 * without an operator can turn email on without editing .env; null means "use the environment".
 */
export interface MailSettings {
  host: string;
  port: number;
  /** "tls" connects with TLS (usually 465); "starttls" upgrades a plain connection (usually 587); "none" only for local relays. */
  security: "tls" | "starttls" | "none";
  user: string | null;
  password: string | null;
  from: string;
}

let saved: MailSettings | null = null;
let savedTransport: Transporter | null = null;

/** Installs (or clears) the admin's saved settings for every appMailer() in this process. */
export function setMailSettings(s: MailSettings | null): void {
  saved = s;
  savedTransport?.close();
  savedTransport = null;
}

export function mailTransportOptions(s: MailSettings) {
  return {
    host: s.host,
    port: s.port,
    secure: s.security === "tls",
    requireTLS: s.security === "starttls",
    ignoreTLS: s.security === "none",
    auth: s.user ? { user: s.user, pass: s.password ?? "" } : undefined,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
  };
}

/**
 * The mailer the modules use: the admin's saved settings when there are any, otherwise SMTP_URL (smtpMailer).
 * `configured` is read on every call, so saving settings takes effect without a restart.
 */
export function appMailer(): Mailer {
  const fallback = smtpMailer();
  return {
    get configured() {
      return saved ? true : fallback.configured !== false;
    },
    async send(mail) {
      if (!saved) return fallback.send(mail);
      savedTransport ??= nodemailer.createTransport(mailTransportOptions(saved));
      await savedTransport.sendMail({ from: saved.from, ...mail, headers: { "X-Request-Id": currentRequestId() ?? "" } });
      logger.info({ to: maskAddress(mail.to), subject: mail.subject }, "email sent");
    },
  };
}

/** One message with settings that are not saved yet (Admin › Settings › Email "Send test email" before saving). */
export async function sendWithSettings(s: MailSettings, mail: Mail): Promise<void> {
  const transport = nodemailer.createTransport(mailTransportOptions(s));
  try {
    await transport.sendMail({ from: s.from, ...mail });
  } finally {
    transport.close();
  }
}

/** The sender address in use: the saved one, else MAIL_FROM. */
export function mailFrom(): string | null {
  return saved?.from ?? process.env.MAIL_FROM ?? null;
}

/** Emails written to MAIL_OUTBOX_DIR for `to` (oldest first), for tests. */
export async function readOutbox(to: string, dir = process.env.MAIL_OUTBOX_DIR): Promise<(Mail & { at: string })[]> {
  if (!dir) throw new Error("MAIL_OUTBOX_DIR is not set");
  const names = (await readdir(dir).catch(() => [] as string[])).filter((n) => n.endsWith(".json")).sort();
  const all = await Promise.all(names.map(async (n) => JSON.parse(await readFile(join(dir, n), "utf8")) as Mail & { at: string }));
  return all.filter((m) => m.to.toLowerCase() === to.toLowerCase());
}

/** Plain, accessible email layout in the product's "Graphite" look (DESIGN.md), in the reader's language. */
export function emailLayout(title: string, body: string, action?: { label: string; url: string }, lang: "vi" | "en" | "zh" | "es" = "vi"): { html: string; text: string } {
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  const orOpen = { vi: "Hoặc mở:", en: "Or open:", zh: "或打开:", es: "O abre:" }[lang];
  // Email clients drop inline SVG, so the mark comes from the web app's PNG icon.
  const appUrl = process.env.APP_URL ?? "http://localhost:3000";
  const html = `<!doctype html><html lang="${lang}"><body style="margin:0;background:#fafafa;font-family:Inter,Segoe UI,Arial,sans-serif;color:#0a0a0a">
<div style="max-width:520px;margin:32px auto;background:#fff;border:1px solid #e7e7ea;border-radius:12px;padding:28px">
<p style="margin:0 0 18px;font-weight:700;font-size:15px"><img src="${esc(appUrl)}/pwa-icon/192" width="18" height="18" alt="" style="vertical-align:-3px;margin-right:8px;border-radius:5px">workspace</p>
<h1 style="font-size:20px;margin:0 0 12px;letter-spacing:-0.01em">${esc(title)}</h1>
<div style="font-size:15px;line-height:1.6;color:#0a0a0a">${body
    .split("\n")
    .map((l) => `<p style="margin:0 0 10px">${esc(l)}</p>`)
    .join("")}</div>
${action ? `<p style="margin:22px 0"><a href="${esc(action.url)}" style="background:#4f46e5;color:#fff;text-decoration:none;padding:12px 18px;border-radius:8px;font-weight:600;display:inline-block">${esc(action.label)}</a></p><p style="font-size:12px;color:#5c5c66;word-break:break-all">${orOpen} ${esc(action.url)}</p>` : ""}
</div></body></html>`;
  const text = `${title}\n\n${body}${action ? `\n\n${action.label}: ${action.url}` : ""}`;
  return { html, text };
}

/** An address as logs show it: the first letter and the domain ("m***@acme.vn"). */
function maskAddress(to: string): string {
  const at = to.lastIndexOf("@");
  return at > 0 ? `${to[0]}***${to.slice(at)}` : "***";
}
