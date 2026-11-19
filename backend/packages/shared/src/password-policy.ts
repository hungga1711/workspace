/**
 * The password rule (identity enforces it on sign-up and changes; platform on `/setup`, which creates the first
 * account). Why a password is rejected: a stable code the UI translates, plus an English message for API clients.
 */
export function passwordProblem(pw: string): { reason: "too_short" | "too_long" | "letters_and_digits"; message: string } | null {
  if (pw.length < 8) return { reason: "too_short", message: "Password needs at least 8 characters." };
  // bcrypt reads 72 bytes (a Vietnamese letter with diacritics takes 2–3 of them).
  if (pw.length > 128 || Buffer.byteLength(pw, "utf8") > 72) return { reason: "too_long", message: "Password can be at most 72 bytes." };
  if (!/[A-Za-z]/.test(pw) || !/\d/.test(pw)) return { reason: "letters_and_digits", message: "Password needs both letters and numbers." };
  return null;
}
