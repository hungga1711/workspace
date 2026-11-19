/**
 * What an AI conversation is about, without a model: a topic from keywords (Vietnamese and English) and
 * flags for data that should not leave the company (ID numbers, cards, secrets, many contacts). Used for
 * every source; when a hosted model is configured, ai-activity also asks it for a one-line summary.
 */

export const TOPICS = ["code", "writing", "analysis", "translation", "research", "sales", "hr", "design", "planning", "other"] as const;
export type Topic = (typeof TOPICS)[number];

/** Whole words or phrases, case-insensitive, with Unicode word edges (JS `\b` treats "gì" as two words). */
export const words = (alternation: string) => new RegExp(`(?<![\\p{L}\\p{N}])${alternation}(?![\\p{L}\\p{N}])`, "iu");

const RULES: [Topic, RegExp][] = [
  [
    "code",
    words(
      String.raw`(code|bug|lỗi|function|hàm|api|sql|query|typescript|javascript|python|java|react|docker|deploy|regex|stack ?trace|exception|git|unit test|refactor|lập trình)`,
    ),
  ],
  ["translation", words(String.raw`(dịch|translate|translation|sang tiếng|into (english|vietnamese)|tiếng anh|tiếng nhật|tiếng trung)`)],
  [
    "analysis",
    words(String.raw`(excel|sheet|bảng tính|công thức|formula|pivot|số liệu|dữ liệu|data|phân tích|analy[sz]\p{L}*|biểu đồ|chart|báo cáo tài chính|doanh thu|forecast|dự báo|kpi)`),
  ],
  ["sales", words(String.raw`(khách hàng|customer|báo giá|quotation|proposal|hợp đồng|contract|chào hàng|sales|bán hàng|đàm phán|negotiat\p{L}*|lead|crm)`)],
  [
    "hr",
    words(
      String.raw`(tuyển dụng|recruit\p{L}*|ứng viên|candidate|phỏng vấn|interview|jd\b|job description|lương|salary|nghỉ phép|đánh giá nhân viên|performance review|onboard\p{L}*)`,
    ),
  ],
  ["design", words(String.raw`(thiết kế|design|logo|banner|ảnh|image|poster|ui|ux|figma|màu sắc|font)`)],
  ["planning", words(String.raw`(kế hoạch|plan|roadmap|lịch trình|timeline|okr|mục tiêu|chiến lược|strategy|ưu tiên|priorit\p{L}*)`)],
  ["writing", words(String.raw`(viết|soạn|email|thư|bài đăng|post|caption|nội dung|content|tóm tắt|summari[sz]e|rewrite|sửa câu|văn bản|thông báo|biên bản)`)],
  ["research", words(String.raw`(là gì|what is|how (to|does)|tại sao|why|so sánh|compare|giải thích|explain|tìm hiểu|research|nghiên cứu)`)],
];

/** The first rule that matches wins; rules are ordered from the most specific to the most general. */
export function classifyTopic(text: string): Topic {
  for (const [topic, re] of RULES) if (re.test(text)) return topic;
  return "other";
}

export const SENSITIVE = ["personal_id", "card", "secret", "contacts", "bank_account", "keyword"] as const;
export type Sensitive = (typeof SENSITIVE)[number];

const luhn = (digits: string) => {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
};

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The company's own terms (client names, project codes) as one case-insensitive, whole-word pattern. */
function keywordPattern(keywords: readonly string[]): RegExp | null {
  const terms = keywords.map((k) => k.trim()).filter((k) => k.length >= 2);
  if (!terms.length) return null;
  // Longest first, so "Sao Mai 2" wins over "Sao Mai".
  terms.sort((a, b) => b.length - a.length);
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map(escapeRe).join("|")})(?![\\p{L}\\p{N}])`, "giu");
}

/** IBAN check digits (ISO 7064 mod 97-10) over the letters-and-digits form; spaces are ignored. */
const ibanOk = (raw: string) => {
  const s = raw.replace(/ /g, "");
  if (s.length < 15 || s.length > 34) return false;
  let rem = 0;
  for (const ch of s.slice(4) + s.slice(0, 4)) {
    for (const d of ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch) rem = (rem * 10 + Number(d)) % 97;
  }
  return rem === 1;
};

/** Chinese resident ID: 17 digits weighted mod 11, the 18th is the check character (0–9 or X). */
const cnIdOk = (m: string) => {
  const s = m.toUpperCase();
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  let sum = 0;
  for (let i = 0; i < 17; i++) sum += Number(s[i]) * w[i]!;
  return "10X98765432"[sum % 11] === s[17];
};
/** Spanish DNI (8 digits) or NIE (X/Y/Z then 7 digits): the letter is the number mod 23 in a fixed table. */
const esIdOk = (m: string) => {
  const s = m.replace(/[- ]/g, "").toUpperCase();
  const n = Number(s.slice(0, 8).replace(/^[XYZ]/, (c) => String("XYZ".indexOf(c))));
  return "TRWAGMYFPDXBNJZSQVHLCKE"[n % 23] === s[8];
};
/** Brazilian CPF: two check digits over the first nine; all-same-digit numbers are not issued. */
const cpfOk = (m: string) => {
  const d = m.replace(/\D/g, "");
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const check = (len: number) => {
    let sum = 0;
    for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
    const r = (sum * 10) % 11;
    return (r === 10 ? 0 : r) === Number(d[len]);
  };
  return check(9) && check(10);
};

// The rules below are mirrored byte for byte in frontend/web/src/lib/sensitive.ts and
// frontend/browser-extension/content.js; change all three together. Each is written with the `g` flag and used
// through fresh calls (`test` on a `g` regex keeps state), so `re.test` is always on a new RegExp instance.
const SENSITIVE_RULES = {
  // Vietnamese ID (CCCD 12 / CMND 9 digits) or a passport number, digits only, next to the word that names it.
  idVn: /\b(cccd|cmnd|căn cước|citizen id|passport|hộ chiếu)(\b[^\d\n]{0,20})\d{9,12}/gi,
  // Any bare 12-digit number starting with 0: the CCCD shape.
  idVnBare: /\b0\d{11}\b/g,
  // "national id", "id number", "identity number", "id card" followed by 8–14 digits.
  idWord: /\b(national id|id number|identity number|id card)([^\d\n]{0,20}?)\b\d{8,14}\b/gi,
  // US Social Security number in its dashed form.
  ssn: /\b\d{3}-\d{2}-\d{4}\b/g,
  // US Social Security number next to "ssn" or "social security", with spaces, dashes or nothing between the groups.
  ssnWord: /\b(ssn|social security)([^\d\n]{0,20}?)\b\d{3}[ -]?\d{2}[ -]?\d{4}\b/gi,
  // A passport number next to the word: 6–9 letters and digits with at least one digit (digits-only ones are idVn).
  passport: /\b(passport|hộ chiếu)([^\d\n]{0,20}?)\b(?=[A-Z0-9]{0,8}\d)[A-Z0-9]{6,9}\b/gi,
  // Singapore NRIC / FIN: S, T, F, G or M, seven digits, a check letter.
  nric: /\b[STFGM]\d{7}[A-Z]\b/g,
  // UK National Insurance number: two letters, six digits, a letter A–D.
  nino: /\b[A-Z]{2}\d{6}[A-D]\b/g,
  // Chinese resident ID: area code, birth date (1800–2099), sequence, check character (see `cnIdOk`).
  idCn: /\b[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx]\b/g,
  // Spanish DNI (8 digits + letter) or NIE (X/Y/Z + 7 digits + letter), optional dash or space (see `esIdOk`).
  idEs: /\b(?:\d{8}|[XYZ][- ]?\d{7})[- ]?[A-Z]\b/g,
  // Mexican CURP: 4 letters, birth date, sex, state, 3 consonants, 1 check pair.
  curp: /\b[A-Z][AEIOUX][A-Z]{2}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[HM][A-Z]{2}[B-DF-HJ-NP-TV-Z]{3}[A-Z\d]\d\b/g,
  // Mexican RFC: 3 (company) or 4 (person) letters, a date, a 3-character homoclave.
  rfc: /\b[A-Z&Ñ]{3,4}\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])[A-Z\d]{2}[\dA]\b/g,
  // Brazilian CPF, formatted 000.000.000-00 or 11 bare digits (see `cpfOk`).
  cpf: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g,
  // Chinese mobile numbers without a country code: 1, then 3–9, then nine digits (+86 ones are phoneIntl).
  phoneCn: /\b1[3-9]\d{9}\b/g,
  // 13–19 digits with optional spaces or dashes; only kept when the Luhn check passes (see `luhn`).
  card: /\b(?:\d[ -]?){12,18}\d\b/g,
  // API keys and tokens by prefix: OpenAI and Anthropic, Stripe, AWS, GitHub, GitLab, Slack, Google (API key, OAuth
  // client secret), SendGrid, Hugging Face, npm, DigitalOcean, Shopify, Mailgun, a Telegram bot, Slack and Discord webhooks.
  token:
    /(sk-[A-Za-z0-9_-]{16,}|sk_(?:live|test)_[A-Za-z0-9]{10,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{20,}|xox[bpa]-[A-Za-z0-9-]{10,}|xapp-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{30,}|GOCSPX-[A-Za-z0-9_-]{20,}|SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{30,}|hf_[A-Za-z0-9]{30,}|npm_[A-Za-z0-9]{36}|dop_v1_[a-f0-9]{64}|shp(?:at|ss|ca|pa)_[a-fA-F0-9]{32}|key-[0-9a-f]{32}|rk_(?:live|test)_[A-Za-z0-9]{10,}|\b\d{8,10}:AA[A-Za-z0-9_-]{30,}|hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]{20,}|discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{30,})/g,
  // A JSON Web Token: three base64url parts of 20+ characters, the first starting with eyJ.
  jwt: /\beyJ[A-Za-z0-9_-]{17,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/g,
  // A PEM private key (RSA, EC, OPENSSH, …) with a body, up to its END line or the end of the text ("…" in its place is none).
  pem: /-----BEGIN [A-Z ]*PRIVATE KEY-----\s*(?!x{3}|X{3})[A-Za-z0-9+/=]{3}[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  // "password: …", "mật khẩu = …", DB_PASSWORD=…, "password": "…" with a value on the same line. Not an empty value
  // or a stand-in for one (password: "", (empty), để trống, ***, <your password>, [SECRET], {{…}}, ${…}, null).
  password:
    /(?<![\p{L}\d])(password|passwd|mật khẩu|pwd)(["']?[ \t]*[:=][ \t]*["']?)(?!(?:null|none|nil|undefined|empty|trống|để trống|\(empty\)|\(trống\)|\*+|x{3,}|X{3,}|<[^>\n]*>|\[[^\]\n]*\]|\{\{[^}\n]*\}\}|\$\{[^}\n]*\}|\$[A-Za-z_]\w*)(?=$|[\s"',;)])|[/~])[^\s"',;]+/gimu,
  // A key, secret or token in config or code (SECRET_KEY=…, "api_key": "…", AWS_SECRET_ACCESS_KEY=…, client_secret: …):
  // a value of 8+ characters with a digit, or of 20+, that is not a stand-in (<…>, ${…}, $VAR, your-api-key-here, ***).
  credential:
    /(?<![\p{L}\d])((?:aws[_ -]?)?secret[_ -]?access[_ -]?key|(?:client|app|api|private|access|auth|refresh|session|signing|encryption|master|webhook)[_ -]?(?:secret|key|token)|secret[_ -]?key|apikey|secret|token)(["']?[ \t]*[:=][ \t]*["']?)(?!(?:null|none|nil|undefined|empty|trống|để trống|\(empty\)|\(trống\)|\*+|x{3,}|X{3,}|<[^>\n]*>|\[[^\]\n]*\]|\{\{[^}\n]*\}\}|\$\{[^}\n]*\}|\$[A-Za-z_]\w*)(?=$|[\s"',;)]))(?=[^\s"',;]*\d|[^\s"',;]{20})[^\s"',;]{8,}/gimu,
  // An Authorization header or a bearer token: "Authorization: Bearer …", "Bearer …".
  bearer:
    /\b(authorization[ \t]*:[ \t]*(?:bearer|basic|token)|bearer)([ \t]+)(?!(?:null|none|nil|undefined|empty|trống|để trống|\(empty\)|\(trống\)|\*+|x{3,}|X{3,}|<[^>\n]*>|\[[^\]\n]*\]|\{\{[^}\n]*\}\}|\$\{[^}\n]*\}|\$[A-Za-z_]\w*)(?=$|[\s"',;)]))(?=[A-Za-z0-9._~+/=-]*\d)[A-Za-z0-9._~+/=-]{16,}/gi,
  // The password in a URL (postgres://user:pass@host, https://user:pass@git…), not a stand-in (user:password@, <password>).
  urlCreds: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)()(?!(?:password|pass|passwd|pwd|secret|changeme|x+|\*+|<[^>\s]*>|\$\{[^}\s]*\}|\{\{[^}\s]*\}\}|\$[A-Za-z_]\w*)@)[^\s:/@]+(?=@)/gi,
  email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
  // International phone numbers with a country code: +1 555 123 4567, +44 (20) 7946 0958, +84-912-345-678.
  phoneIntl: /\+\d{1,3}[\s-]?\(?\d{1,4}\)?[\s-]?\d{3,4}[\s-]?\d{3,4}\b/g,
  // Vietnamese mobile numbers: +84 or 0, then 3/5/7/8/9 and eight digits.
  phoneVn: /(?:\+84|\b0)(?:3|5|7|8|9)\d{8}\b/g,
  // Vietnamese bank account next to the words that name it.
  bankVn: /\b(stk|số tài khoản|tài khoản ngân hàng)(\b[^\d\n]{0,15})\d{8,16}/gi,
  // English "account number", "acct no", "routing number", "ABA" followed by 8–17 digits.
  bankEn: /\b(account (?:no\.?|number|#)|acct\.?(?: no\.?| number)?|routing(?: number| no\.?)?|aba)(\b[^\d\n]{0,15})\d{8,17}/gi,
  // An IBAN, compact or in groups of four, that passes the mod-97 check (see `ibanOk`).
  iban: /\b[A-Z]{2}\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?)\b/g,
  // A SWIFT/BIC code (8 or 11 upper-case characters) after "swift:", "bic =" or "swift code"; a bare "SWIFT WORD" is not one.
  swift: /\b([Ss][Ww][Ii][Ff][Tt]|[Bb][Ii][Cc])((?:[ /]?[Cc][Oo][Dd][Ee])?[ \t]*[:#=-][ \t]*|[ /]?[Cc][Oo][Dd][Ee][ \t]+)\b[A-Z]{6}[A-Z0-9]{2}(?:[A-Z0-9]{3})?\b/g,
} as const;
const has = (re: RegExp, text: string) => new RegExp(re.source, re.flags.replace("g", "")).test(text);
const cardOk = (m: string) => {
  const digits = m.replace(/\D/g, "");
  return digits.length >= 13 && digits.length <= 19 && luhn(digits);
};

/**
 * Kinds of data in the text that a company would not want pasted into an outside AI. `keywords` are the
 * company's own terms (Admin › AI); the browser extension runs the same checks before anything is sent.
 */
export function detectSensitive(text: string, keywords: readonly string[] = []): Sensitive[] {
  const out = new Set<Sensitive>();
  if (
    [
      SENSITIVE_RULES.idVn,
      SENSITIVE_RULES.idVnBare,
      SENSITIVE_RULES.idWord,
      SENSITIVE_RULES.ssn,
      SENSITIVE_RULES.ssnWord,
      SENSITIVE_RULES.passport,
      SENSITIVE_RULES.nric,
      SENSITIVE_RULES.nino,
      SENSITIVE_RULES.curp,
      SENSITIVE_RULES.rfc,
    ].some((re) => has(re, text)) ||
    [...text.matchAll(SENSITIVE_RULES.idCn)].some((m) => cnIdOk(m[0])) ||
    [...text.matchAll(SENSITIVE_RULES.idEs)].some((m) => esIdOk(m[0])) ||
    [...text.matchAll(SENSITIVE_RULES.cpf)].some((m) => cpfOk(m[0]))
  )
    out.add("personal_id");
  for (const m of text.matchAll(SENSITIVE_RULES.card)) if (text[(m.index ?? 0) - 1] !== "+" && cardOk(m[0])) out.add("card");
  if (
    has(SENSITIVE_RULES.token, text) ||
    has(SENSITIVE_RULES.jwt, text) ||
    has(SENSITIVE_RULES.pem, text) ||
    has(SENSITIVE_RULES.password, text) ||
    has(SENSITIVE_RULES.credential, text) ||
    has(SENSITIVE_RULES.bearer, text) ||
    has(SENSITIVE_RULES.urlCreds, text)
  )
    out.add("secret");
  const emails = text.match(SENSITIVE_RULES.email)?.length ?? 0;
  const intl = text.match(SENSITIVE_RULES.phoneIntl)?.length ?? 0;
  // Vietnamese numbers are counted on the text without the international ones, so +84 912 345 678 counts once.
  const vn = text.replace(SENSITIVE_RULES.phoneIntl, " ").match(SENSITIVE_RULES.phoneVn)?.length ?? 0;
  const cn = text.replace(SENSITIVE_RULES.phoneIntl, " ").match(SENSITIVE_RULES.phoneCn)?.length ?? 0;
  if (emails + intl + vn + cn >= 3) out.add("contacts");
  if (
    has(SENSITIVE_RULES.bankVn, text) ||
    has(SENSITIVE_RULES.bankEn, text) ||
    has(SENSITIVE_RULES.swift, text) ||
    [...text.matchAll(SENSITIVE_RULES.iban)].some((m) => ibanOk(m[0]))
  )
    out.add("bank_account");
  if (keywordPattern(keywords)?.test(text)) out.add("keyword");
  return [...out];
}

/**
 * What replaces each removed part; the extension uses the same set, so people learn one. Vietnamese forms keep
 * the labels Vietnamese users know ([CCCD], [STK]); the international ones read for everyone else.
 */
const PLACEHOLDERS = {
  secret: "[SECRET]",
  email: "[EMAIL]",
  keyword: "[KEYWORD]",
  bank_account: "[STK]",
  account: "[ACCOUNT]",
  iban: "[IBAN]",
  personal_id: "[CCCD]",
  id: "[ID]",
  card: "[CARD]",
  phone: "[PHONE]",
} as const;

/**
 * Sensitive parts replaced by placeholders, with how many of each kind were replaced (emails and phones count
 * as `contacts`). Used for the "redact before sending" policy, the prompt library and what managers read. Pure:
 * the same text and keywords always give the same result. Mirrored in frontend/browser-extension/content.js.
 */
export function redactWithCounts(text: string, keywords: readonly string[] = []): { text: string; counts: Partial<Record<Sensitive, number>> } {
  const counts: Partial<Record<Sensitive, number>> = {};
  const hit = (kind: Sensitive, placeholder: string) => {
    counts[kind] = (counts[kind] ?? 0) + 1;
    return placeholder;
  };
  const afterWord = (kind: Sensitive, placeholder: string) => (_m: string, w: string, sep: string) => `${w}${sep}${hit(kind, placeholder)}`;
  let t = text
    .replace(SENSITIVE_RULES.pem, () => hit("secret", PLACEHOLDERS.secret))
    .replace(SENSITIVE_RULES.password, afterWord("secret", PLACEHOLDERS.secret))
    .replace(SENSITIVE_RULES.credential, afterWord("secret", PLACEHOLDERS.secret))
    .replace(SENSITIVE_RULES.bearer, afterWord("secret", PLACEHOLDERS.secret))
    .replace(SENSITIVE_RULES.urlCreds, afterWord("secret", PLACEHOLDERS.secret))
    .replace(SENSITIVE_RULES.token, () => hit("secret", PLACEHOLDERS.secret))
    .replace(SENSITIVE_RULES.jwt, () => hit("secret", PLACEHOLDERS.secret))
    .replace(SENSITIVE_RULES.email, () => hit("contacts", PLACEHOLDERS.email));
  const kw = keywordPattern(keywords);
  if (kw) t = t.replace(kw, () => hit("keyword", PLACEHOLDERS.keyword));
  t = t
    .replace(SENSITIVE_RULES.bankVn, afterWord("bank_account", PLACEHOLDERS.bank_account))
    .replace(SENSITIVE_RULES.bankEn, afterWord("bank_account", PLACEHOLDERS.account))
    .replace(SENSITIVE_RULES.iban, (m) => (ibanOk(m) ? hit("bank_account", PLACEHOLDERS.iban) : m))
    .replace(SENSITIVE_RULES.swift, afterWord("bank_account", PLACEHOLDERS.account))
    .replace(SENSITIVE_RULES.idVn, afterWord("personal_id", PLACEHOLDERS.personal_id))
    .replace(SENSITIVE_RULES.idWord, afterWord("personal_id", PLACEHOLDERS.id))
    .replace(SENSITIVE_RULES.ssnWord, afterWord("personal_id", PLACEHOLDERS.id))
    .replace(SENSITIVE_RULES.ssn, () => hit("personal_id", PLACEHOLDERS.id))
    .replace(SENSITIVE_RULES.passport, afterWord("personal_id", PLACEHOLDERS.id))
    .replace(SENSITIVE_RULES.nric, () => hit("personal_id", PLACEHOLDERS.id))
    .replace(SENSITIVE_RULES.nino, () => hit("personal_id", PLACEHOLDERS.id))
    .replace(SENSITIVE_RULES.idCn, (m) => (cnIdOk(m) ? hit("personal_id", PLACEHOLDERS.id) : m))
    .replace(SENSITIVE_RULES.curp, () => hit("personal_id", PLACEHOLDERS.id))
    .replace(SENSITIVE_RULES.rfc, () => hit("personal_id", PLACEHOLDERS.id))
    .replace(SENSITIVE_RULES.idEs, (m) => (esIdOk(m) ? hit("personal_id", PLACEHOLDERS.id) : m))
    .replace(SENSITIVE_RULES.cpf, (m) => (cpfOk(m) ? hit("personal_id", PLACEHOLDERS.id) : m))
    .replace(SENSITIVE_RULES.phoneIntl, () => hit("contacts", PLACEHOLDERS.phone))
    .replace(SENSITIVE_RULES.card, (m) => (cardOk(m) ? hit("card", PLACEHOLDERS.card) : m))
    .replace(SENSITIVE_RULES.idVnBare, () => hit("personal_id", PLACEHOLDERS.personal_id))
    .replace(SENSITIVE_RULES.phoneVn, () => hit("contacts", PLACEHOLDERS.phone))
    .replace(SENSITIVE_RULES.phoneCn, () => hit("contacts", PLACEHOLDERS.phone));
  return { text: t, counts };
}

/** The text with sensitive parts replaced by placeholders (see `redactWithCounts`). */
export function redact(text: string, keywords: readonly string[] = []): string {
  return redactWithCounts(text, keywords).text;
}

/**
 * What a manager may read: `redact`, plus any other long run of digits masked, because a title stored before a
 * rule existed, or a number in a format no rule knows, must not show an ID to someone who is not its owner.
 */
export function maskForReader(text: string, keywords: readonly string[] = []): string {
  return redact(text, keywords).replace(/(?:\d[ -]?){9,19}\d/g, (m) => "•".repeat(Math.min(8, m.replace(/\D/g, "").length)));
}

/** A short title from the first prompt: its first line (sensitive parts masked), cut at a word, at most 80 characters. */
export function titleFrom(text: string): string {
  const line = maskForReader(text.trim().split(/\n/)[0]!).replace(/\s+/g, " ").trim();
  if (line.length <= 80) return line;
  const cut = line.slice(0, 80);
  return `${cut.slice(0, cut.lastIndexOf(" ") > 40 ? cut.lastIndexOf(" ") : 80)}…`;
}

export const SOURCES = [
  "company",
  "chatgpt",
  "claude",
  "gemini",
  "copilot",
  "perplexity",
  "deepseek",
  "grok",
  "meta",
  "poe",
  "qwen",
  "kimi",
  "doubao",
  "you",
  "huggingchat",
  "zai",
  "duckai",
  "import",
  "other",
] as const;
export type Source = (typeof SOURCES)[number];

/** Which tool a page belongs to, from its host (the extension reports the URL). */
export function sourceFromHost(host: string): Exclude<Source, "company" | "import"> {
  const h = host.toLowerCase();
  const is = (d: string) => h === d || h.endsWith(`.${d}`);
  if (is("chatgpt.com") || h === "chat.openai.com") return "chatgpt";
  if (is("claude.ai")) return "claude";
  if (h === "gemini.google.com") return "gemini";
  // Copilot moved to copilot.com (the old address redirects); Microsoft 365 Copilot is the same tool at work.
  if (is("copilot.microsoft.com") || is("copilot.com") || h === "m365.cloud.microsoft" || h === "copilot.cloud.microsoft") return "copilot";
  if (is("perplexity.ai")) return "perplexity";
  if (h === "chat.deepseek.com") return "deepseek";
  if (is("grok.com")) return "grok";
  if (is("meta.ai")) return "meta";
  if (h === "poe.com") return "poe";
  if (h === "chat.qwen.ai") return "qwen";
  if (is("kimi.com") || is("kimi.ai") || h === "kimi.moonshot.cn") return "kimi";
  if (is("doubao.com")) return "doubao";
  if (is("you.com")) return "you";
  // The extension only runs under huggingface.co/chat.
  if (h === "huggingface.co") return "huggingchat";
  if (h === "chat.z.ai") return "zai";
  if (h === "duck.ai") return "duckai";
  return "other";
}
