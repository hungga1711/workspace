import { ForbiddenException } from "@nestjs/common";
import type { Pool } from "pg";
import { authorize, withTransaction, type Principal } from "@workspace/shared";
import { logger } from "@workspace/service-kit";
import { ActivationMailError, sendActivation, type AccountsDeps } from "./accounts.controller.js";
import type { MailLocale } from "./accounts.js";
import type { UserDirectory } from "./auth/users.js";
import { inviteMember, setMemberEnabled } from "./repo.js";

/** What member lifecycle needs (the admin screens). */
export interface MemberDeps {
  pool: Pool;
  users: UserDirectory;
  accounts: AccountsDeps;
}

/** One invite: account, membership, email. */
export async function inviteOne(
  d: MemberDeps,
  p: Principal,
  b: { email: string; displayName: string; roleNames: string[]; password?: string | undefined; temporary?: boolean | undefined },
  locale: MailLocale = "en",
) {
  // An invite never grants more than the inviter could grant: Owner is never handed out this way, and
  // any role other than Employee needs role.manage (the same permission as changing roles later).
  if (b.roleNames.includes("Owner")) throw new ForbiddenException({ error: "role_not_allowed", message: "nobody can be invited as Owner" });
  if (b.roleNames.some((r) => r !== "Employee") && !authorize(p, "role.manage").allowed) {
    throw new ForbiddenException({ error: "role_not_allowed", message: "you can only invite with the Employee role" });
  }
  const hadAccount = (await d.users.findUserByEmail(b.email)) !== null;
  // A password the inviter typed is temporary: the person replaces it at first sign-in (password_must_change).
  // TEST_FIXTURES=1 (test installations only) keeps it as typed unless `temporary: true`, so end-to-end suites can
  // invite colleagues and sign in as them; the gate itself is covered by tests that ask for `temporary`.
  const mustChange = process.env.TEST_FIXTURES !== "1" || b.temporary === true;
  const userId = await d.users.ensureUser(b.email, b.displayName, b.password, { mustChange });
  await withTransaction(d.pool, (c) => inviteMember(c, { userId, email: b.email, displayName: b.displayName, roleNames: b.roleNames }));
  // New accounts get an activation email to choose their password; existing accounts get a heads-up to sign in.
  // When the email cannot go out (no SMTP, relay down) the link comes back instead, for the admin to hand over.
  let emailed = false;
  let activationUrl: string | null = null;
  let activationKind: "activate" | "login" | null = null;
  if (!b.password) {
    try {
      const r = await sendActivation(d.accounts, userId, p.id, { existingAccount: hadAccount, locale });
      emailed = true;
      activationKind = r.kind;
    } catch (err) {
      if (err instanceof ActivationMailError) {
        activationUrl = err.url;
        activationKind = err.kind;
        logger.error({ err: err.cause, userId }, "invite email failed; activation link handed back");
      } else logger.error({ err, userId }, "invite email failed");
    }
  }
  return { userId, emailed, existingAccount: hadAccount, activationUrl, activationKind, emailConfigured: d.accounts.mailer.configured !== false };
}

/**
 * Offboarding / re-enabling. Disabling also signs the person out everywhere (the installation is their only
 * workspace). Returns false when nothing changed. Throws MemberStateError for the caller to map.
 */
export async function setMembershipEnabled(d: Pick<MemberDeps, "pool" | "users">, userId: string, enabled: boolean): Promise<boolean> {
  const changed = await withTransaction(d.pool, (c) => setMemberEnabled(c, userId, enabled));
  if (!changed) return false;
  if (enabled) return true;
  await d.users.logoutAll(userId, "disabled").catch((err) => logger.warn({ err, userId }, "sign-out after disable failed"));
  return true;
}
