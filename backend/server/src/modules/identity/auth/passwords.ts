import bcrypt from "bcrypt";

/**
 * Password hashing: bcrypt, cost 12 (~200 ms on one core), on the libuv thread pool (async API) so the event
 * loop keeps serving while a hash runs. bcrypt reads at most 72 bytes; longer passwords are refused rather
 * than silently truncated (passwordProblem), so two passwords sharing their first 72 bytes never collide.
 */
const BCRYPT_COST = Number(process.env.BCRYPT_COST ?? 12);
const MAX_PASSWORD_BYTES = 72;

export const hashPassword = (password: string) => bcrypt.hash(password, BCRYPT_COST);

let dummy: Promise<string> | null = null;

/**
 * Checks a password against a stored hash. Without a hash (unknown email, account with no password yet)
 * it still compares against a dummy hash, so the answer takes as long as for a real account.
 */
export async function checkPassword(password: string, hash: string | null | undefined): Promise<boolean> {
  if (Buffer.byteLength(password, "utf8") > MAX_PASSWORD_BYTES) {
    await bcrypt.compare("x", await (dummy ??= hashPassword("dummy-password-for-timing")));
    return false;
  }
  if (!hash) {
    await bcrypt.compare(password, await (dummy ??= hashPassword("dummy-password-for-timing")));
    return false;
  }
  return bcrypt.compare(password, hash);
}
