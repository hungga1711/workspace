// workspace AI Insights: runs on the AI sites listed in sites.js (ChatGPT, Claude, Gemini, Copilot and the rest).
// When the person sends a prompt it records the prompt (and, if the company's policy says so, the answer once it has
// finished), and shows a small notice on the page so nobody is recorded without knowing (Vietnam Decree 13/2023 on
// personal data). Before anything leaves, the company's safety net applies: warn, redact or block sensitive data.
(() => {
  if (window.__workspaceAi) return;
  window.__workspaceAi = true;

  // The registry (sites.js, loaded before this file): one entry per AI site.
  const site = WORKSPACE_AI_SITES.find((x) => x.hosts.includes(location.hostname) && (!x.path || location.pathname === x.path || location.pathname.startsWith(`${x.path}/`)));
  if (!site) return;

  let connected = false;
  let server = null;
  let captureResponses = false;
  let mode = "warn";
  let keywords = [];
  // The connection and the policy can change while the page is open (options page, the next batch): ask again and
  // redraw the notice.
  const refresh = () => {
    // After an extension update the old copy of this script stays on open pages without a runtime.
    if (!chrome.runtime?.id) return;
    chrome.runtime.sendMessage({ type: "state" }, (s) => {
      if (chrome.runtime.lastError) return;
      connected = !!s?.connected;
      server = typeof s?.server === "string" ? s.server : null;
      captureResponses = !!s?.captureResponses;
      mode = ["warn", "redact", "block"].includes(s?.sensitiveMode) ? s.sensitiveMode : "warn";
      keywords = Array.isArray(s?.keywords) ? s.keywords.filter((k) => typeof k === "string") : [];
      notice();
    });
  };
  refresh();
  chrome.storage.onChanged.addListener((c, area) => {
    if (area === "local" && (c.server || c.token || c.status || c.captureResponses || c.sensitiveMode || c.keywords)) refresh();
  });

  const textOf = (el) => (el ? (el.value ?? el.innerText ?? "").trim() : "");
  const msg = (key, ...subs) => chrome.i18n.getMessage(key, subs);

  // ---- the same checks and placeholders as workspace (backend/server/src/modules/ai/insight.ts)
  // The rule table and the order of replacements are copied byte for byte from insight.ts; change both together.
  const KINDS = { personal_id: "kindPersonalId", card: "kindCard", secret: "kindSecret", contacts: "kindContacts", bank_account: "kindBankAccount", keyword: "kindKeyword" };
  const luhn = (d) => {
    let sum = 0;
    for (let i = 0; i < d.length; i++) {
      let x = Number(d[d.length - 1 - i]);
      if (i % 2 === 1) {
        x *= 2;
        if (x > 9) x -= 9;
      }
      sum += x;
    }
    return sum % 10 === 0;
  };
  const keywordPattern = () => {
    const terms = keywords.map((k) => k.trim()).filter((k) => k.length >= 2);
    if (!terms.length) return null;
    terms.sort((a, b) => b.length - a.length);
    return new RegExp(`(?<![\\p{L}\\p{N}])(?:${terms.map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})(?![\\p{L}\\p{N}])`, "giu");
  };
  /** IBAN check digits (ISO 7064 mod 97-10) over the letters-and-digits form; spaces are ignored. */
  const ibanOk = (raw) => {
    const s = raw.replace(/ /g, "");
    if (s.length < 15 || s.length > 34) return false;
    let rem = 0;
    for (const ch of s.slice(4) + s.slice(0, 4)) {
      for (const d of ch >= "A" && ch <= "Z" ? String(ch.charCodeAt(0) - 55) : ch) rem = (rem * 10 + Number(d)) % 97;
    }
    return rem === 1;
  };
  /** Chinese resident ID: 17 digits weighted mod 11, the 18th is the check character (0–9 or X). */
  const cnIdOk = (m) => {
    const s = m.toUpperCase();
    const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    let sum = 0;
    for (let i = 0; i < 17; i++) sum += Number(s[i]) * w[i];
    return "10X98765432"[sum % 11] === s[17];
  };
  /** Spanish DNI (8 digits) or NIE (X/Y/Z then 7 digits): the letter is the number mod 23 in a fixed table. */
  const esIdOk = (m) => {
    const s = m.replace(/[- ]/g, "").toUpperCase();
    const n = Number(s.slice(0, 8).replace(/^[XYZ]/, (c) => String("XYZ".indexOf(c))));
    return "TRWAGMYFPDXBNJZSQVHLCKE"[n % 23] === s[8];
  };
  /** Brazilian CPF: two check digits over the first nine; all-same-digit numbers are not issued. */
  const cpfOk = (m) => {
    const d = m.replace(/\D/g, "");
    if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
    const check = (len) => {
      let sum = 0;
      for (let i = 0; i < len; i++) sum += Number(d[i]) * (len + 1 - i);
      const r = (sum * 10) % 11;
      return (r === 10 ? 0 : r) === Number(d[len]);
    };
    return check(9) && check(10);
  };
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
    urlCreds:
      /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)()(?!(?:password|pass|passwd|pwd|secret|changeme|x+|\*+|<[^>\s]*>|\$\{[^}\s]*\}|\{\{[^}\s]*\}\}|\$[A-Za-z_]\w*)@)[^\s:/@]+(?=@)/gi,
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
  };
  const has = (re, text) => new RegExp(re.source, re.flags.replace("g", "")).test(text);
  const cardOk = (m) => {
    const digits = m.replace(/\D/g, "");
    return digits.length >= 13 && digits.length <= 19 && luhn(digits);
  };
  const sensitive = (text) => {
    const out = new Set();
    const R = SENSITIVE_RULES;
    if (
      [R.idVn, R.idVnBare, R.idWord, R.ssn, R.ssnWord, R.passport, R.nric, R.nino, R.curp, R.rfc].some((re) => has(re, text)) ||
      [...text.matchAll(R.idCn)].some((m) => cnIdOk(m[0])) ||
      [...text.matchAll(R.idEs)].some((m) => esIdOk(m[0])) ||
      [...text.matchAll(R.cpf)].some((m) => cpfOk(m[0]))
    )
      out.add("personal_id");
    for (const m of text.matchAll(R.card)) if (text[(m.index ?? 0) - 1] !== "+" && cardOk(m[0])) out.add("card");
    if (has(R.token, text) || has(R.jwt, text) || has(R.pem, text) || has(R.password, text) || has(R.credential, text) || has(R.bearer, text) || has(R.urlCreds, text))
      out.add("secret");
    const emails = text.match(R.email)?.length ?? 0;
    const intl = text.match(R.phoneIntl)?.length ?? 0;
    // Vietnamese numbers are counted on the text without the international ones, so +84 912 345 678 counts once.
    const vn = text.replace(R.phoneIntl, " ").match(R.phoneVn)?.length ?? 0;
    const cn = text.replace(R.phoneIntl, " ").match(R.phoneCn)?.length ?? 0;
    if (emails + intl + vn + cn >= 3) out.add("contacts");
    if (has(R.bankVn, text) || has(R.bankEn, text) || has(R.swift, text) || [...text.matchAll(R.iban)].some((m) => ibanOk(m[0]))) out.add("bank_account");
    if (keywordPattern()?.test(text)) out.add("keyword");
    return [...out];
  };
  const redact = (text) => {
    const counts = {};
    const R = SENSITIVE_RULES;
    const hit = (kind, placeholder) => {
      counts[kind] = (counts[kind] ?? 0) + 1;
      return placeholder;
    };
    const afterWord = (kind, placeholder) => (_m, w, sep) => `${w}${sep}${hit(kind, placeholder)}`;
    let t = text
      .replace(R.pem, () => hit("secret", "[SECRET]"))
      .replace(R.password, afterWord("secret", "[SECRET]"))
      .replace(R.credential, afterWord("secret", "[SECRET]"))
      .replace(R.bearer, afterWord("secret", "[SECRET]"))
      .replace(R.urlCreds, afterWord("secret", "[SECRET]"))
      .replace(R.token, () => hit("secret", "[SECRET]"))
      .replace(R.jwt, () => hit("secret", "[SECRET]"))
      .replace(R.email, () => hit("contacts", "[EMAIL]"));
    const kw = keywordPattern();
    if (kw) t = t.replace(kw, () => hit("keyword", "[KEYWORD]"));
    t = t
      .replace(R.bankVn, afterWord("bank_account", "[STK]"))
      .replace(R.bankEn, afterWord("bank_account", "[ACCOUNT]"))
      .replace(R.iban, (m) => (ibanOk(m) ? hit("bank_account", "[IBAN]") : m))
      .replace(R.swift, afterWord("bank_account", "[ACCOUNT]"))
      .replace(R.idVn, afterWord("personal_id", "[CCCD]"))
      .replace(R.idWord, afterWord("personal_id", "[ID]"))
      .replace(R.ssnWord, afterWord("personal_id", "[ID]"))
      .replace(R.ssn, () => hit("personal_id", "[ID]"))
      .replace(R.passport, afterWord("personal_id", "[ID]"))
      .replace(R.nric, () => hit("personal_id", "[ID]"))
      .replace(R.nino, () => hit("personal_id", "[ID]"))
      .replace(R.idCn, (m) => (cnIdOk(m) ? hit("personal_id", "[ID]") : m))
      .replace(R.curp, () => hit("personal_id", "[ID]"))
      .replace(R.rfc, () => hit("personal_id", "[ID]"))
      .replace(R.idEs, (m) => (esIdOk(m) ? hit("personal_id", "[ID]") : m))
      .replace(R.cpf, (m) => (cpfOk(m) ? hit("personal_id", "[ID]") : m))
      .replace(R.phoneIntl, () => hit("contacts", "[PHONE]"))
      .replace(R.card, (m) => (cardOk(m) ? hit("card", "[CARD]") : m))
      .replace(R.idVnBare, () => hit("personal_id", "[CCCD]"))
      .replace(R.phoneVn, () => hit("contacts", "[PHONE]"))
      .replace(R.phoneCn, () => hit("contacts", "[PHONE]"));
    return { text: t, counts };
  };

  const send = (event) => {
    // After the extension is updated or reloaded, this old copy of the script can no longer reach it.
    try {
      chrome.runtime.sendMessage({ type: "capture", event }).catch(() => undefined);
    } catch {
      // Extension context invalidated: the page is left alone.
    }
  };
  const pageUrl = () => location.href.split("#")[0];
  const safety = (action, kinds) => send({ kind: "safety", url: pageUrl(), action, kinds, count: 1, at: new Date().toISOString() });

  /** A field a prompt is typed in: a textarea, a rich-text editor, or a one-line text input (Meta AI, You.com). */
  const isField = (el) =>
    !!el && (el.tagName === "TEXTAREA" || el.isContentEditable || (el.tagName === "INPUT" && ["text", "search", ""].includes((el.getAttribute("type") ?? "").toLowerCase())));
  // The field typed in last: pressing the send button moves the focus to the button, and the site's own selector
  // may no longer match after a redesign.
  let lastField = null;
  const composer = () => {
    const a = document.activeElement;
    if (isField(a)) return a;
    return document.querySelector(site.input) ?? (lastField?.isConnected ? lastField : null);
  };
  /**
   * The send button when the site's own selector no longer matches (a redesign, a translated label): a button that
   * says or looks like "send" and sits in the same block as the composer. Only asked while the composer holds text.
   */
  const SEND_WORDS = /\b(send|submit|ask)\b|gửi|发送|發送|enviar|envoyer|senden|送信/i;
  const genericSend = (target) => {
    const b = target.closest("button, [role='button']");
    if (!b || b.disabled || b.getAttribute("aria-disabled") === "true") return null;
    const c = composer();
    if (!c || !textOf(c)) return null;
    const says = `${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("title") ?? ""} ${b.getAttribute("data-testid") ?? ""} ${b.id}`;
    if (NOT_SEND.test(says) || !(b.getAttribute("type") === "submit" || SEND_WORDS.test(says.replace(/[-_]/g, " ")))) return null;
    // Next to the composer: the same form, or a shared ancestor a few levels up (never a button elsewhere on the page).
    if (c.closest("form")?.contains(b)) return b;
    let up = c;
    for (let i = 0; i < 6 && up && up !== document.body && up.tagName !== "MAIN"; i++, up = up.parentElement) if (up.contains(b)) return b;
    return null;
  };
  // "Send feedback", "Share", "Send invite": buttons that send something other than the prompt.
  const NOT_SEND = /feedback|report|share|invite|phản hồi|反馈/i;
  const sendButton = (target) => {
    const b = target.closest(site.send);
    if (b) return NOT_SEND.test(`${b.getAttribute("aria-label") ?? ""} ${b.getAttribute("title") ?? ""}`) ? null : b;
    return genericSend(target);
  };
  /** Puts text in the composer the way typing would, so the site's own state (React, ProseMirror) follows. */
  const setComposer = (el, text) => {
    el.focus();
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value").set.call(el, text);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    } else {
      document.execCommand("selectAll", false);
      document.execCommand("insertText", false, text);
    }
  };
  const stop = (e) => {
    e.preventDefault();
    e.stopImmediatePropagation();
  };

  // A send we started ourselves after the person accepted the redacted text: let it through once.
  let bypass = false;
  let pendingRedactions = null;
  /** true = go ahead; false = stopped here (the event is cancelled before the site sees it). */
  const allow = (e, viaKey, pressed) => {
    if (!connected) return true;
    if (bypass) {
      bypass = false;
      return true;
    }
    const c = composer();
    const text = textOf(c);
    const kinds = sensitive(text);
    if (!kinds.length) return true;
    const names = kinds.map((k) => msg(KINDS[k])).join(", ");
    if (mode === "block") {
      stop(e);
      safety("block", kinds);
      panel({ title: msg("blockTitle"), body: msg("blockBody", names), actions: [{ label: msg("blockOk"), primary: true }] });
      return false;
    }
    if (mode === "redact") {
      stop(e);
      const r = redact(text);
      // Name what is actually replaced: a single email is redacted though only three or more count as a contact list.
      const replaced = Object.keys(r.counts).filter((k) => KINDS[k]);
      panel({
        title: msg("redactTitle"),
        body: msg("redactBody", replaced.length ? replaced.map((k) => msg(KINDS[k])).join(", ") : names),
        preview: r.text,
        actions: [
          { label: msg("redactCancel") },
          {
            label: msg("redactSend"),
            primary: true,
            run: () => {
              setComposer(c, r.text);
              pendingRedactions = r.counts;
              bypass = true;
              // Give the site a moment to take the new text (its send button may enable only then).
              setTimeout(() => {
                // The button when there is one (a site may ignore a key press it did not see typed); the key otherwise.
                const button = (pressed?.isConnected ? pressed : null) ?? document.querySelector(site.send);
                if (button && !button.disabled) button.click();
                else c.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
              }, 80);
            },
          },
        ],
      });
      return false;
    }
    const ok = window.confirm(msg("confirmSensitive", names));
    safety("warn", kinds);
    if (!ok) stop(e);
    return ok;
  };
  // ChatGPT /c/<id>, Claude /chat/<id>, Gemini /app/<id>: the page id is the conversation.
  const conversationKey = () => location.pathname.replace(/\/$/, "") || "/";

  let pending = "";
  const remember = (e) => {
    if (e?.target instanceof Element && isField(e.target)) lastField = e.target;
    const t = textOf(composer());
    if (t) pending = t;
  };
  const HINT_FRESH_MS = 2 * 3600_000;
  const submit = () => {
    const prompt = pending || textOf(composer());
    pending = "";
    const redactions = pendingRedactions;
    pendingRedactions = null;
    if (!prompt || !connected) return;
    const at = new Date().toISOString();
    // The page as it was when the person pressed send: a prompt that leaves early (see `leaving`) is filed here.
    const sentFrom = { url: pageUrl(), conversation: conversationKey() };
    let hint;
    chrome.storage.local.get(["hintsEnabled", "lastTaskSeen"]).then(({ hintsEnabled, lastTaskSeen }) => {
      if (hintsEnabled && lastTaskSeen?.taskId && Date.now() - new Date(lastTaskSeen.seenAt).getTime() <= HINT_FRESH_MS)
        hint = { taskId: lastTaskSeen.taskId, seenAt: lastTaskSeen.seenAt };
    });
    let gone = false;
    const go = (early) => {
      if (gone) return;
      gone = true;
      clearTimeout(timer);
      waiting.delete(go);
      const { url, conversation } = early ? sentFrom : { url: pageUrl(), conversation: conversationKey() };
      // The prompt goes at once (a closed tab must not lose it); the answer follows on its own if kept.
      send({ url, conversation, prompt: prompt.slice(0, 20000), response: null, model: "", at, ...(hint ? { hint } : {}), ...(redactions ? { redactions } : {}) });
      if (early) return;
      // A task code in the prompt (T-157): offer to link this chat to it, once per conversation.
      const code = taskCodeIn(prompt);
      if (code) askLink(url, conversation, code);
      waitForAnswer((answer) => {
        if (!answer) return;
        if (captureResponses) send({ url, conversation, prompt: "", response: answer.slice(0, 40000), model: "", at: new Date().toISOString() });
        askFeedback(url, conversation);
      });
    };
    // The id of a new conversation appears in the URL a moment after the first send, so the prompt waits for it.
    const timer = setTimeout(go, 1500);
    waiting.add(go);
  };
  // Prompts still waiting for their conversation id when the tab closes or loads another page leave right then.
  const waiting = new Set();
  window.addEventListener("pagehide", () => {
    for (const go of [...waiting]) go(true);
  });

  // The last answer on the page, once it has stopped changing for 3 seconds (at most 2 minutes).
  const waitForAnswer = (done) => {
    let last = "";
    let still = 0;
    let waited = 0;
    const tick = setInterval(() => {
      const nodes = document.querySelectorAll(site.answer);
      const text = nodes.length ? textOf(nodes[nodes.length - 1]) : "";
      waited += 1000;
      if (text && text === last) still += 1000;
      else still = 0;
      last = text;
      if ((text && still >= 3000) || waited > 120000) {
        clearInterval(tick);
        done(text);
      }
    }, 1000);
  };

  document.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Enter" || e.shiftKey || e.isComposing) return;
      const c = composer();
      if (!c || !(c === e.target || c.contains(e.target))) return;
      if (!allow(e, true)) return;
      remember();
      submit();
    },
    true,
  );
  document.addEventListener("input", remember, true);
  document.addEventListener(
    "click",
    (e) => {
      const pressed = e.target instanceof Element ? sendButton(e.target) : null;
      if (pressed) {
        if (!allow(e, false, pressed)) return;
        remember();
        submit();
      }
    },
    true,
  );

  // ---- in-page UI (shadow DOM, so the site's styles neither break it nor see it)
  const STYLE = `
    .card{font:13px/1.45 system-ui,sans-serif;color:#0b1220;background:#fff;border:1px solid #e7e7ea;border-radius:12px;box-shadow:0 12px 32px rgb(11 18 32/.16);padding:16px;max-width:440px}
    h2{font-size:14px;margin:0 0 6px}
    p{margin:0 0 10px;color:#3f3f46}
    pre{white-space:pre-wrap;word-break:break-word;background:#f4f4f5;border-radius:8px;padding:10px;margin:0 0 12px;max-height:240px;overflow:auto;font:12px/1.5 ui-monospace,monospace}
    .row{display:flex;gap:8px;justify-content:flex-end;flex-wrap:wrap}
    button{font:600 13px system-ui,sans-serif;border-radius:8px;padding:7px 12px;cursor:pointer;border:1px solid #e7e7ea;background:#fff;color:#0b1220}
    button.primary{background:#4f46e5;border-color:#4f46e5;color:#fff}
    .chip{display:flex;align-items:center;gap:6px;font:500 12px/1.3 system-ui,sans-serif;color:#1e1b4b;background:#fff;border:1px solid #c7d2fe;border-radius:999px;padding:4px 6px 4px 12px;box-shadow:0 4px 12px rgb(11 18 32/.08)}
    .chip button{font-weight:500;font-size:12px;padding:3px 10px;border-radius:999px}
    .chip .x{border:0;background:transparent;color:#5c5c66;padding:3px 6px}
  `;
  const mount = (css, html) => {
    const host = document.createElement("div");
    host.style.cssText = css;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `<style>${STYLE}</style>${html}`;
    document.documentElement.appendChild(host);
    return { host, root };
  };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

  /** The redact / block explanation, over the page, keyboard-reachable; Escape closes it. */
  function panel({ title, body, preview, actions }) {
    const { host, root } = mount(
      "position:fixed;inset:0;z-index:2147483647;display:grid;place-items:center;background:rgb(11 18 32/.35)",
      `<div class="card" role="dialog" aria-modal="true" aria-labelledby="t" data-wx="panel">
        <h2 id="t">${esc(title)}</h2><p>${esc(body)}</p>${preview != null ? `<pre data-wx="preview">${esc(preview)}</pre>` : ""}
        <div class="row">${actions.map((a, i) => `<button type="button" data-i="${i}" class="${a.primary ? "primary" : ""}">${esc(a.label)}</button>`).join("")}</div>
      </div>`,
    );
    const close = () => host.remove();
    root.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        close();
        actions[Number(b.dataset.i)].run?.();
      }),
    );
    root.addEventListener("keydown", (e) => {
      if (e.key === "Escape") close();
    });
    root.querySelector("button.primary")?.focus();
  }

  // The same rule as the server: upper-case prefix, dash, digits; GPT-4, COVID-19 and standards are not tasks.
  const NOT_TASKS = new Set([
    "GPT",
    "COVID",
    "ISO",
    "UTF",
    "SHA",
    "RFC",
    "CVE",
    "TLS",
    "SSL",
    "HTTP",
    "IPV",
    "MP",
    "H",
    "ES",
    "ECMA",
    "IEC",
    "EN",
    "PCI",
    "SOC",
    "WCAG",
    "PEP",
    "BS",
    "NO",
    "GDPR",
  ]);
  // Workspace codes and synced keys (T-157, ENG-123, AB2-7), then ClickUp ids ("#86b1x2y3z", "CU-86b1x2y3z").
  const taskCodeIn = (text) => {
    for (const m of text.matchAll(/(?<![A-Za-z0-9_-])([A-Z][A-Z0-9]{0,9}-\d{1,7})(?![A-Za-z0-9_-])/g)) if (!NOT_TASKS.has(m[1].slice(0, m[1].indexOf("-")))) return m[1];
    for (const m of text.matchAll(/(?<![A-Za-z0-9_#])(?:#|CU-)([0-9a-z]{7,12})(?![A-Za-z0-9_-])/gi)) if (/\d/.test(m[1]) && /[a-z]/i.test(m[1])) return `#${m[1].toUpperCase()}`;
    return null;
  };

  /**
   * "Link this chat to T-157?" once per conversation. Linking counts the chat for that task (workspace checks the
   * person can see it); "Not this" drops the suggestion. Ignoring it leaves the suggestion in workspace › Mine › AI.
   */
  async function askLink(url, conversation, code) {
    const key = `${location.hostname}${conversation}`;
    const { linkAsked = [] } = await chrome.storage.local.get("linkAsked");
    if (linkAsked.includes(key)) return;
    await chrome.storage.local.set({ linkAsked: [...linkAsked, key].slice(-300) });
    const { host, root } = mount(
      "position:fixed;right:16px;bottom:112px;z-index:2147483646",
      `<div class="chip" role="group" aria-label="${esc(msg("linkAsk", code))}" data-wx="link">
        <span>${esc(msg("linkAsk", code))}</span>
        <button type="button" data-v="link">${esc(msg("linkYes"))}</button>
        <button type="button" data-v="decline">${esc(msg("linkNo"))}</button>
        <button type="button" class="x" aria-label="${esc(msg("feedbackDismiss"))}">×</button>
      </div>`,
    );
    root.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.dataset.v) send({ kind: "link", url, conversation, code, decline: b.dataset.v === "decline", at: new Date().toISOString() });
        host.remove();
      }),
    );
  }

  /** "Did AI help?" once per conversation, after its first answer; one tap, or dismissed. */
  async function askFeedback(url, conversation) {
    const key = `${location.hostname}${conversation}`;
    const { feedbackAsked = [] } = await chrome.storage.local.get("feedbackAsked");
    if (feedbackAsked.includes(key)) return;
    await chrome.storage.local.set({ feedbackAsked: [...feedbackAsked, key].slice(-300) });
    const { host, root } = mount(
      "position:fixed;right:16px;bottom:64px;z-index:2147483646",
      `<div class="chip" role="group" aria-label="${esc(msg("feedbackAsk"))}" data-wx="feedback">
        <span>${esc(msg("feedbackAsk"))}</span>
        <button type="button" data-v="yes">${esc(msg("feedbackYes"))}</button>
        <button type="button" data-v="partly">${esc(msg("feedbackPartly"))}</button>
        <button type="button" data-v="no">${esc(msg("feedbackNo"))}</button>
        <button type="button" class="x" aria-label="${esc(msg("feedbackDismiss"))}">×</button>
      </div>`,
    );
    root.querySelectorAll("button").forEach((b) =>
      b.addEventListener("click", () => {
        if (b.dataset.v) send({ kind: "feedback", url, conversation, helpful: b.dataset.v, at: new Date().toISOString() });
        host.remove();
      }),
    );
  }

  // The notice: a small pill in the corner; it expands to say what is recorded and where to read more. Drawn again
  // in place when the connection or the policy changes, keeping whether it was open.
  let noticeRoot = null;
  function notice() {
    const link = typeof server === "string" && /^https?:\/\/[^\s"'<>]+$/.test(server) ? server.replace(/\/$/, "") : null;
    if (!noticeRoot) {
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;right:16px;bottom:16px;z-index:2147483647";
      noticeRoot = host.attachShadow({ mode: "open" });
      document.documentElement.appendChild(host);
    }
    const wasOpen = !!noticeRoot.querySelector(".pill.open");
    noticeRoot.innerHTML = `
      <style>
        .pill{font:500 12px/1.3 system-ui,sans-serif;color:#1e1b4b;background:#eef0fe;border:1px solid #c7d2fe;border-radius:8px;padding:6px 10px;cursor:pointer;box-shadow:0 4px 12px rgb(11 18 32/.08);max-width:300px}
        .dot{display:inline-block;width:7px;height:7px;border-radius:50%;background:#4f46e5;margin-right:6px;vertical-align:middle}
        .more{display:none;margin-top:6px;font-weight:400;color:#3730a3}
        .open .more{display:block}
        a{color:#4338ca}
      </style>
      <div class="pill" role="status" tabindex="0">
        <span class="dot"></span>${connected ? msg("noticeOn") : msg("noticeOff")}
        <div class="more">${
          connected
            ? `${msg(captureResponses ? "noticeWhatBoth" : "noticeWhatPrompts")}${mode !== "warn" ? ` ${msg(mode === "redact" ? "noticeRedact" : "noticeBlock")}` : ""}${
                link ? ` <a href="${link}/app/me?tab=ai" target="_blank" rel="noopener">${msg("noticePolicy")}</a>` : ""
              }`
            : msg("noticeConnect")
        }</div>
      </div>`;
    const pill = noticeRoot.querySelector(".pill");
    if (wasOpen) pill.classList.add("open");
    pill.addEventListener("click", () => pill.classList.toggle("open"));
  }
})();
