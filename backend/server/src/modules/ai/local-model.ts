import { dayKey, DEFAULT_TIME_ZONE, startOfDay } from "@workspace/shared";

/**
 * Pure helpers for the built-in extractive model (providers.ts LocalProvider): language detection, reading Markdown
 * as plain sentences, keywords, and the plain-words task edit parser. No model, no I/O, so they are unit-tested
 * directly (local-model.test.ts). Everything works in English and Vietnamese: demos and air-gapped trials run on this
 * model in either language.
 */
export type Lang = "en" | "vi";

/** Case- and accent-insensitive form for matching ("Tuấn" finds "tuan"). */
export const fold = (t: string) => t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d");

const VI_MARKS = /[ăâđêôơưàáạảãằắặẳẵầấậẩẫèéẹẻẽềếệểễìíịỉĩòóọỏõồốộổỗờớợởỡùúụủũừứựửữỳýỵỷỹ]/i;
const VI_WORDS = /\b(cua|toi|minh|viec|lam|nay|khong|duoc|nhung|cho|voi|gi|sao|bao nhieu|hom nay|ngay mai)\b/;
const EN_WORDS = /\b(the|my|what|who|which|is|are|to|for|of|and|please|how|when|set|change|make|due|next|this|summari[sz]e|show|find|write)\b/;

/** The language a piece of text is written in, or null when it does not say (a name, a code, "T-104"). */
export function detectLang(text: string): Lang | null {
  if (VI_MARKS.test(text)) return "vi";
  const f = fold(text);
  if (VI_WORDS.test(f)) return "vi";
  if (EN_WORDS.test(f)) return "en";
  return null;
}

/**
 * The language to answer in: the question's own language when it shows one, else what the caller asked for in the
 * system prompt ("Reply in Vietnamese"), else English (the product default; also for Chinese and Spanish, which this
 * model does not write).
 */
export function replyLang(system: string, question: string): Lang {
  const asked = detectLang(question);
  if (asked) return asked;
  if (/\b(write|reply|answer) in vietnamese\b/i.test(system)) return "vi";
  // English, and Chinese or Spanish (this model writes neither: English reads for both), else the product's default.
  return "en";
}

const TABLE_RULE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const cellsOf = (row: string) =>
  row
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((c) => c.trim());

/**
 * Markdown as plain lines a reader can take as sentences: a table becomes one line per row, read with its header
 * ("Team lunch: Limit £25 per person; Approval Manager"); headings, emphasis, links, list markers and raw mention
 * tokens go. `names` turns `<@id>` into the person's name; unknown ids are dropped, never shown raw.
 */
export function plainLines(md: string, names: Record<string, string> = {}): string[] {
  const src = md.replace(/\r/g, "").split("\n");
  const out: string[] = [];
  for (let i = 0; i < src.length; i++) {
    const line = src[i]!;
    // A table: header row, rule row, body rows.
    if (/^\s*\|.*\|\s*$/.test(line) && TABLE_RULE.test(src[i + 1] ?? "")) {
      const head = cellsOf(line);
      i += 2;
      for (; i < src.length && /^\s*\|.*\|\s*$/.test(src[i]!); i++) {
        const cells = cellsOf(src[i]!);
        const rest = cells
          .slice(1)
          .map((c, k) => (c ? `${head[k + 1] ? `${head[k + 1]} ` : ""}${c}` : ""))
          .filter(Boolean);
        out.push(inline(`${cells[0] ?? ""}${rest.length ? `: ${rest.join("; ")}` : ""}`, names));
      }
      i--;
      continue;
    }
    if (TABLE_RULE.test(line)) continue;
    const l = inline(line, names);
    if (l) out.push(l);
  }
  return out.filter((l) => l.length > 1);
}

function inline(l: string, names: Record<string, string>): string {
  return l
    .replace(/<@(?:agent:)?([\w-]{1,64})>/g, (_m, id: string) => (names[id] ? `@${names[id]}` : ""))
    .replace(/^\s*(#{1,6}|>)\s*/, "")
    .replace(/^\s*([-*•]|\d+[.)]|\[[ xX]?\])\s+/, "")
    .replace(/^\s*\|/, "")
    .replace(/\|\s*$/, "")
    .replace(/\s*\|\s*/g, ", ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, "$1$2")
    .replace(/(^|[^\w*])\*([^*\n]+)\*(?![\w*])/g, "$1$2")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(?:📍|✅|☑️|🔴|🟡|🟢)\s*/gu, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

/** Sentences from Markdown, markup removed. */
export function plainSentences(md: string, names: Record<string, string> = {}): string[] {
  return plainLines(md, names)
    .flatMap((l) => l.split(/(?<=[.!?。])\s+/))
    .map((s) => s.trim())
    .filter((s) => s.length > 3);
}

const STOP_EN = new Set(
  "a an the of to in on at for by with from about into over and or but is are was were be been am do does did have has had i me my mine we our us you your he she it its they them their this that these those what which who whom whose when where why how can could would should will shall may might must please tell show give find get list let make any some all there here up out more most just also very not no yes than then so if as summarise summarize summary explain describe write draft about overview".split(
    " ",
  ),
);
const STOP_VI = new Set(
  "la cua toi minh ban cho voi va hoac nhung cac mot nhung nay kia do gi nao sao the nao bao nhieu co khong duoc da dang se thi ma o tai trong ngoai len xuong ve hay giup tom tat liet ke tim xem cho biet ai".split(
    " ",
  ),
);

/** The words worth searching for in a question, most specific first (longer words first, stop words gone). */
export function keywords(q: string, max = 4): string[] {
  const seen = new Set<string>();
  const words = fold(q)
    .replace(/<@[\w:-]+>/g, " ")
    .split(/[^a-z0-9-]+/)
    .filter((w) => w.length > 1 && !STOP_EN.has(w) && !STOP_VI.has(w) && !/^@?ai$/.test(w));
  const kept = words.filter((w) => (seen.has(w) ? false : (seen.add(w), true)));
  return kept.sort((a, b) => b.length - a.length).slice(0, max);
}

/** Overlap of a sentence with keywords, plural-insensitive ("receipts" matches "receipt"). */
export function overlap(sentence: string, words: string[]): number {
  const stem = (w: string) => w.replace(/(ies|es|s)$/, "");
  const have = new Set(
    fold(sentence)
      .split(/[^a-z0-9£$€%-]+/)
      .map(stem),
  );
  return words.filter((w) => have.has(stem(w))).length;
}

// ---------------------------------------------------------------------------------------------- task edits

export interface RosterEntry {
  id: string;
  name: string;
  title?: string;
  load?: number;
}

const WEEKDAYS_EN = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const WEEKDAYS_VI: Record<string, number> = { "chu nhat": 0, "thu hai": 1, "thu ba": 2, "thu tu": 3, "thu nam": 4, "thu sau": 5, "thu bay": 6 };
const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTH_RE = "(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)";
const monthIndex = (m: string) => MONTHS.findIndex((x) => x.startsWith(m.slice(0, 3)));

const addDays = (key: string, n: number) => new Date(Date.parse(`${key}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const weekday = (key: string) => new Date(`${key}T00:00:00Z`).getUTCDay();
const keyOf = (y: number, m: number, d: number) => {
  const dt = new Date(Date.UTC(y, m, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m && dt.getUTCDate() === d ? dt.toISOString().slice(0, 10) : null;
};

/**
 * The day a request names, as "YYYY-MM-DD" in the workspace zone: today, tomorrow, in 3 days, next week, (this|next)
 * Friday, end of the week/month, 6/11, 6/11/2026, 2026-11-06, 6 November, Nov 6th; Vietnamese hôm nay, ngày mai,
 * 3 ngày nữa, tuần sau, thứ sáu (tuần sau), 20/11. Day/month order is the British and Vietnamese one.
 * `null` when no date is named; "none" when the request clears the due date.
 */
export function parseDay(text: string, now: Date, tz: string = DEFAULT_TIME_ZONE): string | "none" | null {
  const f = fold(text);
  const today = dayKey(now, tz);
  if (/\b(no|remove( the)?|clear( the)?|without( a)?) (due ?date|deadline)\b|bo han|xoa han/.test(f)) return "none";
  const iso = f.match(/\b(\d{4})-(\d{2})-(\d{2})\b/);
  if (iso) return keyOf(Number(iso[1]), Number(iso[2]) - 1, Number(iso[3]));
  const year = Number(today.slice(0, 4));
  // A day without a year that already passed (more than a month ago) means next year's.
  const ahead = (m: number, d: number, y?: number) => {
    const k = keyOf(y ?? year, m, d);
    if (!k || y !== undefined) return k;
    return k < addDays(today, -31) ? keyOf(year + 1, m, d) : k;
  };
  // "6/11" or "6/11/2026"; with dots only when a year follows, so a version such as "v1.2" is not a date.
  const dm = f.match(/\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/) ?? f.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/);
  if (dm) {
    const y = dm[3] ? Number(dm[3].length === 2 ? `20${dm[3]}` : dm[3]) : undefined;
    return ahead(Number(dm[2]) - 1, Number(dm[1]), y);
  }
  const dMonth = f.match(new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?(?: of)? ${MONTH_RE}\\b(?:,? (\\d{4}))?`));
  if (dMonth) return ahead(monthIndex(dMonth[2]!), Number(dMonth[1]), dMonth[3] ? Number(dMonth[3]) : undefined);
  const monthD = f.match(new RegExp(`\\b${MONTH_RE} (\\d{1,2})(?:st|nd|rd|th)?\\b(?:,? (\\d{4}))?`));
  if (monthD) return ahead(monthIndex(monthD[1]!), Number(monthD[2]), monthD[3] ? Number(monthD[3]) : undefined);
  const vnDay = f.match(/\bngay (\d{1,2})(?: thang (\d{1,2}))?\b/);
  if (vnDay) return ahead(vnDay[2] ? Number(vnDay[2]) - 1 : Number(today.slice(5, 7)) - 1, Number(vnDay[1]));

  if (/\bday after tomorrow\b|\bngay kia\b/.test(f)) return addDays(today, 2);
  if (/\btomorrow\b|\bngay mai\b/.test(f)) return addDays(today, 1);
  if (/\b(today|tonight|end of (the )?day|eod)\b|\bhom nay\b/.test(f)) return today;
  const inN = f.match(/\bin (\d{1,3}|a|one|two|three|four|five|six|seven) (day|week|month)s?\b/) ?? f.match(/\b(\d{1,3}) (ngay|tuan|thang) nua\b/);
  if (inN) {
    const words: Record<string, number> = { a: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7 };
    const n = words[inN[1]!] ?? Number(inN[1]);
    const unit = inN[2]!;
    if (unit === "day" || unit === "ngay") return addDays(today, n);
    if (unit === "week" || unit === "tuan") return addDays(today, 7 * n);
    const [y, m, d] = today.split("-").map(Number) as [number, number, number];
    return keyOf(y, m - 1 + n, Math.min(d, 28)) ?? addDays(today, 30 * n);
  }
  const wdNow = weekday(today);
  const nextMonday = addDays(today, (8 - wdNow) % 7 || 7);
  if (/\bend of (the |this )?week\b|\bcuoi tuan\b/.test(f)) return addDays(today, (5 - wdNow + 7) % 7);
  if (/\bend of (the |this )?month\b|\bcuoi thang\b/.test(f)) {
    const [y, m] = today.split("-").map(Number) as [number, number];
    return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  }
  // A weekday: "Friday"/"this Friday"/"by Friday" is the coming one; "next Friday" the one in next week.
  const en = f.match(/\b(next|this|coming|by|on)?\s*(sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/);
  const vi = Object.keys(WEEKDAYS_VI).find((k) => f.includes(k));
  if (en || vi) {
    const target = en ? WEEKDAYS_EN.indexOf(en[2]!) : WEEKDAYS_VI[vi!]!;
    const nextWeek = en ? en[1] === "next" : /tuan sau|tuan toi/.test(f);
    if (nextWeek) return addDays(nextMonday, (target + 6) % 7);
    return addDays(today, (target - wdNow + 7) % 7 || 7);
  }
  if (/\bnext week\b|\btuan sau\b|\btuan toi\b/.test(f)) return nextMonday;
  if (/\bnext month\b|\bthang sau\b/.test(f)) {
    const [y, m] = today.split("-").map(Number) as [number, number];
    return keyOf(y, m, 1);
  }
  return null;
}

/** The end of that working day (17:00 in the zone), as an ISO instant: what a due date set in words means. */
const dueAtOf = (key: string, tz: string = DEFAULT_TIME_ZONE) => new Date(startOfDay(key, tz).getTime() + 17 * 3600_000).toISOString();

/** The roster entry a request names ("Maya", "maya patel", "Tuấn"), whole words only. */
export function findPerson(text: string, roster: RosterEntry[]): RosterEntry | undefined {
  const f = ` ${fold(text).replace(/[^a-z0-9]+/g, " ")} `;
  const full = roster.find(
    (r) =>
      r.name &&
      f.includes(
        ` ${fold(r.name)
          .replace(/[^a-z0-9]+/g, " ")
          .trim()} `,
      ),
  );
  if (full) return full;
  // A first (or last) name alone, when only one person has it.
  const parts = (r: RosterEntry) =>
    fold(r.name)
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")
      .filter((p) => p.length > 1);
  const hits = roster.filter((r) => parts(r).some((p) => f.includes(` ${p} `)));
  return hits.length === 1 ? hits[0] : undefined;
}

export interface TaskPatch {
  title?: string;
  status?: "todo" | "in_progress" | "review" | "done" | "cancelled";
  priority?: "low" | "medium" | "high" | "urgent";
  dueAt?: string | null;
  assigneeId?: string | null;
  blockedReason?: string | null;
}

/**
 * A task change asked for in plain words ("due next Friday, high priority, assign to Maya") as field changes.
 * English and Vietnamese; anything it does not recognise is left alone (the person sees the proposal first).
 */
export function parseTaskRequest(request: string, opts: { now: Date; timeZone?: string; roster?: RosterEntry[] }): TaskPatch {
  const tz = opts.timeZone ?? DEFAULT_TIME_ZONE;
  const patch: TaskPatch = {};

  // Title first, and taken out of the rest: "rename it to Ship on Friday" must not also move the due date.
  const rename = request.match(
    /(?:rename(?: it| this| the task)?|change the (?:title|name)|retitle(?: it)?|set the title|call it|đổi tên(?: việc)?(?: thành)?)\s*(?:to|as|thành|:)?\s*["“']?([^"”'\n]{2,200}?)["”']?\s*$/i,
  );
  let rest = request;
  if (rename?.[1]) {
    patch.title = rename[1].trim();
    rest = request.slice(0, rename.index);
  }
  const r = fold(rest);

  const day = parseDay(rest, opts.now, tz);
  if (day === "none") patch.dueAt = null;
  else if (day) patch.dueAt = dueAtOf(day, tz);

  if (/\b(urgent|asap|critical|emergency)\b|khan cap|\bkhan\b|\bgap\b/.test(r)) patch.priority = "urgent";
  else if (/\b(high(est)?( priority)?|priority (to |is |as )?high|important|bump (it )?up)\b|uu tien cao|quan trong/.test(r)) patch.priority = "high";
  else if (/\b(low(est)?( priority)?|priority (to |is |as )?low|not urgent|whenever)\b|uu tien thap|khong gap/.test(r)) patch.priority = "low";
  else if (/\b(medium|normal)( priority)?\b|priority (to |is |as )?(medium|normal)|uu tien (trung binh|vua)/.test(r)) patch.priority = "medium";

  if (/\b(unblock(ed)?|no longer blocked|not blocked( any ?more)?)\b|het bi chan|bo chan/.test(r)) patch.blockedReason = null;
  else {
    const blocked = rest.match(/\bblocked(?: by| on| because(?: of)?| until| waiting (?:for|on))?\s+(.{3,200})$/i) ?? rest.match(/bị chặn (?:vì|do|bởi) (.{3,200})$/i);
    if (blocked?.[1]) patch.blockedReason = blocked[1].trim().replace(/[.!]$/, "");
  }

  if (/\b(cancel(led)?|drop (it|this|the task)|won'?t do)\b|\bhuy\b/.test(r)) patch.status = "cancelled";
  else if (
    /\b(done|complete(d)?|finish(ed)?|close (it|this)|mark (it |this )?(as )?(done|complete))\b|hoan thanh|da xong|xong roi/.test(r) &&
    !/\b(due|by|finish (it )?by|done by)\b/.test(r)
  )
    patch.status = "done";
  else if (/\b(ready for review|in review|to review|needs? review|send (it )?for review)\b|cho duyet|duyet lai/.test(r)) patch.status = "review";
  else if (/\b(in progress|start(ed)?( it| working)?|working on it|begin|underway)\b|dang lam|bat dau/.test(r)) patch.status = "in_progress";
  else if (/\b(to ?do|not started|reopen(ed)?|back to (to ?do|backlog))\b|chua bat dau|mo lai/.test(r)) patch.status = "todo";

  if (/\b(unassign(ed)?|no assignee|remove the assignee)\b|bo nguoi lam/.test(r)) patch.assigneeId = null;
  else if (opts.roster?.length) {
    const who =
      rest.match(/\b(?:assign(?:ed)?|give|hand(?: it)?(?: over)?|reassign|move|pass)(?: it| this| the task)?\s+(?:over\s+)?to\s+(.{2,80})$/i) ??
      rest.match(/(?:giao|chuyển|chuyen)(?: việc)?(?: này)? cho\s+(.{2,80})$/i);
    const named = who?.[1] ? findPerson(who[1], opts.roster) : /\b(assign|giao|chuyen)\b/.test(r) ? findPerson(rest, opts.roster) : undefined;
    if (named) patch.assigneeId = named.id;
  }
  return patch;
}

// ---------------------------------------------------------------------------------------------- assignee

/** Kinds of work, with the words that show up in tasks about them and in the job titles of people who do them. */
const AREAS: { task: RegExp; title: RegExp }[] = [
  {
    task: /\b(front-?end|ui|css|react|page|component|design system|storybook|layout|toggle|button|browser|web|landing|homepage|widget|dashboard|board)\b/,
    title: /front-?end|full-?stack|\bui\b|web/,
  },
  {
    task: /\b(back-?end|api|database|db|webhook|service|server|endpoint|payments?|logging|migration|queue|cache|rate limits?|auth)\b/,
    title: /back-?end|full-?stack|platform|api/,
  },
  { task: /\b(ios|android|mobile|app store|google play)\b/, title: /mobile|ios|android/ },
  { task: /\b(design|mock-?ups?|figma|wireframes?|visual|brand|illustration)\b/, title: /design|\bux\b/ },
  { task: /\b(tests?|qa|bugs?|regression|e2e)\b/, title: /\bqa\b|test|quality/ },
  { task: /\b(deploy|ci|infra|infrastructure|kubernetes|monitoring|uptime|incident)\b/, title: /devops|\bsre\b|infrastructure|platform/ },
  { task: /\b(data|analytics?|forecast|sql|metrics?|report)\b/, title: /data|analyst|analytics/ },
  { task: /\b(campaign|seo|newsletter|social|press|content|blog|launch email|webinar|event)\b/, title: /marketing|seo|content|events?|brand|growth/ },
  { task: /\b(deal|prospects?|demo|quote|crm|pipeline|renewal|leads?)\b/, title: /sales|account executive|development rep|business development/ },
  { task: /\b(invoices?|expenses?|payroll|budget|audit|accounting|tax|reconcil\w*|close)\b/, title: /financ|accountant|controller|payroll/ },
  { task: /\b(support|tickets?|helpdesk|customer repl\w*|onboarding call)\b/, title: /support|customer success/ },
  { task: /\b(hiring|recruit\w*|onboarding|leave|hr|policy|offboarding)\b/, title: /people|\bhr\b|recruit|talent|office/ },
  { task: /\b(contracts?|legal|compliance|gdpr|nda)\b/, title: /legal|counsel/ },
  { task: /\b(roadmap|prd|requirements?|spec|discovery)\b/, title: /product manager|product owner/ },
];

/** Folded, with plurals made singular ("webhooks" → "webhook"), for the kind-of-work patterns below. */
const workText = (t: string) =>
  fold(t)
    .replace(/\b([a-z]{3,}?)(?:ies)\b/g, "$1y")
    .replace(/\b([a-z]{3,}[^s])s\b/g, "$1");

/**
 * The best person for a task: whose job title fits the kind of work (frontend task → frontend engineer), then the
 * one with the fewest open tasks. Someone named in the task itself (title or description) comes first.
 */
export function suggestAssignee(taskText: string, roster: RosterEntry[], lang: Lang): { assigneeId: string | null; reason: string } {
  if (!roster.length) return { assigneeId: null, reason: "" };
  const named = findPerson(taskText, roster);
  if (named) return { assigneeId: named.id, reason: lang === "en" ? `${named.name} is named in the task.` : `${named.name} được nhắc tên trong việc.` };
  const f = workText(taskText);
  const areas = AREAS.filter((a) => a.task.test(f));
  const score = (r: RosterEntry) => areas.filter((a) => a.title.test(fold(r.title ?? ""))).length;
  const ranked = [...roster].sort((a, b) => score(b) - score(a) || (a.load ?? 0) - (b.load ?? 0));
  const pick = ranked[0]!;
  const role = (pick.title ?? "").split(",")[0]!.trim();
  const load = pick.load;
  const tasks = (n: number) => (lang === "en" ? `${n} open task${n === 1 ? "" : "s"}` : `${n} việc mở`);
  if (score(pick) > 0) {
    const first = pick.name.split(" ")[0];
    if (lang === "en") return { assigneeId: pick.id, reason: `${role} fits this work${load === undefined ? "" : `, and ${first} has ${tasks(load)}`}.` };
    return { assigneeId: pick.id, reason: `Công việc hợp với vai trò ${role}${load === undefined ? "" : `, và ${pick.name} đang có ${tasks(load)}`}.` };
  }
  // No job title fits and no workload is known: better no suggestion than an arbitrary name.
  if (load === undefined) return { assigneeId: null, reason: "" };
  return { assigneeId: pick.id, reason: lang === "en" ? `Lightest workload right now (${tasks(load)}).` : `Đang có ít việc mở nhất (${load}).` };
}

/** Step lists by kind of work, for a task whose description lists none (the title alone says what kind it is). */
const STEPS: { task: RegExp; en: string[]; vi: string[] }[] = [
  {
    task: AREAS[0]!.task,
    en: ["Check the design and agree what done looks like", "Build the UI", "Handle loading, empty and error states", "Test on desktop and mobile", "Review and release"],
    vi: ["Xem thiết kế và thống nhất thế nào là xong", "Làm giao diện", "Xử lý trạng thái đang tải, trống và lỗi", "Kiểm tra trên máy tính và điện thoại", "Review và phát hành"],
  },
  {
    task: AREAS[1]!.task,
    en: ["Write down the API and data changes", "Implement the change", "Add tests", "Deploy and watch the logs"],
    vi: ["Ghi lại thay đổi API và dữ liệu", "Làm thay đổi", "Viết test", "Triển khai và theo dõi log"],
  },
  {
    task: AREAS[7]!.task,
    en: ["Agree the goal and the audience", "Draft the content", "Get it reviewed", "Schedule and publish", "Check the results after a week"],
    vi: ["Thống nhất mục tiêu và đối tượng", "Viết nội dung", "Nhờ duyệt", "Lên lịch và đăng", "Xem kết quả sau một tuần"],
  },
];

/**
 * Concrete steps for a task: the list written in its description when there is one, otherwise steps for its kind of
 * work (or a plain plan) built around its title, so "Break into subtasks" proposes something even before anyone
 * has written a description.
 */
export function planSteps(title: string, listed: string[], lang: Lang): string[] {
  if (listed.length) return listed.slice(0, 8);
  const t = title.replace(/[.!?]$/, "");
  const kind = STEPS.find((k) => k.task.test(workText(t)));
  if (kind) return lang === "en" ? kind.en : kind.vi;
  return lang === "en"
    ? [`Agree the scope of “${t}” and what done looks like`, "Do the work", "Get it reviewed", "Share the result and close the task"]
    : [`Thống nhất phạm vi “${t}” và thế nào là xong`, "Làm việc chính", "Nhờ review", "Chia sẻ kết quả và đóng việc"];
}

// ---------------------------------------------------------------------------------------------- documents

/** Sentences that ask someone to do something, in either language. */
export const looksLikeAction = (s: string) =>
  /^(please |make sure |remember to |don'?t forget to )?(submit|send|book|review|update|add|check|prepare|ask|share|read|sign|file|approve|schedule|confirm|finish|complete|write|create|set up|follow up|fill|attach|upload|plan|organi[sz]e|contact|call|email|invite|test|fix|ship|publish|draft)\b/i.test(
    s,
  ) ||
  /\b(need(s)? to|has to|have to|must|should|will|by (monday|tuesday|wednesday|thursday|friday|eod|end of)|deadline|todo|action:)\b/i.test(s) ||
  /\b(cần|phải|hãy|nhớ|nhờ|trước ngày|hạn chót)\b/i.test(s);

/** The sentences of a document that answer a question, best first; empty when none shares a keyword with it. */
export function answerFrom(doc: string, question: string, max = 2): string[] {
  const words = keywords(question, 6);
  if (!words.length) return [];
  const ranked = plainSentences(doc)
    .map((s, i) => ({ s, i, n: overlap(s, words) }))
    .filter((x) => x.n > 0)
    .sort((a, b) => b.n - a.n || a.i - b.i);
  const best = ranked[0]?.n ?? 0;
  return ranked
    .filter((x) => x.n >= Math.max(1, best - 1))
    .slice(0, max)
    .map((x) => x.s);
}

/**
 * A section written from the document for a request ("a short paragraph about receipts"): a heading from the topic,
 * then the document's own sentences about it (or its main points when nothing matches), as one readable paragraph.
 */
export function draftSection(request: string, title: string, doc: string, lang: Lang): string {
  const words = keywords(request.replace(/\b(short|long|paragraph|section|intro(duction)?|summary|bullet(s)?|list|đoạn|ngắn|phần)\b/gi, " "), 4);
  const topic = words.length ? words[words.length - 1]! : fold(title);
  const heading = topic.charAt(0).toUpperCase() + topic.slice(1);
  const related = words.length ? answerFrom(doc, words.join(" "), 4) : [];
  const base = related.length ? related : plainSentences(doc).slice(0, 3);
  const bullets = /\b(list|bullets?|checklist|steps)\b|liet ke|cac buoc/.test(fold(request));
  const body = bullets ? base.map((s) => `- ${s}`).join("\n") : base.map((s) => (/[.!?]$/.test(s) ? s : `${s}.`)).join(" ");
  if (!body.trim()) return lang === "en" ? `## ${heading}\n\nAdd the details about ${topic} here.` : `## ${heading}\n\nThêm nội dung về ${topic} ở đây.`;
  return `## ${heading}\n\n${body}`;
}

// ---------------------------------------------------------------------------------------------- follow-ups

export interface Turn {
  role: "user" | "assistant";
  content: string;
}

/** What a conversation was last about: a person, a project or a document, as the earlier turns name them. */
export interface Subject {
  person?: string;
  project?: string;
  doc?: string;
}

const NAME = "[A-ZÀ-Ỹ][\\p{L}'’-]+(?: [A-ZÀ-Ỹ][\\p{L}'’-]+){1,2}";

/** The people, project and document an answer (or a question) names, first one each. */
function subjectsIn(t: Turn): Subject {
  const s: Subject = {};
  for (const raw of t.content.split("\n")) {
    const l = raw.replace(/^\s*[-*]\s+/, "").trim();
    const project = l.match(/^P-\d+: ([^:]+?):/)?.[1];
    if (project && !s.project) s.project = project.trim();
    // "Tom Becker: Frontend Lead, …" or "Tessa Byrne, Senior Frontend Engineer: …" (people and team answers).
    const person = t.role === "assistant" ? l.match(new RegExp(`^(${NAME})(?:,| ·|: (?!Limit|Approval))`, "u"))?.[1] : undefined;
    if (person && !s.person && !/^(Here|Đây|Annual|On|Expense|Travel|Team)\b/.test(person)) s.person = person;
    const doc = l.match(/\(([^()]{3,80})\)$/)?.[1] ?? l.match(/^(?:Here is a summary of|Tóm tắt) “([^”]{3,80})”/)?.[1] ?? l.match(/^“([^”]{3,80})” (?:is owned by|do)/)?.[1];
    if (doc && !s.doc && t.role === "assistant" && !/^\d|approved|pending|đã duyệt|chờ duyệt|OVERDUE/.test(doc)) s.doc = doc;
  }
  if (t.role === "user") {
    // A name the person typed ("How is Tessa doing?"): capitalised words that do not start the sentence.
    const typed = t.content.match(new RegExp(`(?<!^)\\b(${NAME}|[A-ZÀ-Ỹ][\\p{L}'’-]{2,})\\b`, "u"))?.[1];
    if (typed && !/^(I|AI|The|What|Who|How|Which|When|Where|Is|Are|Do|Does|My|Our)$/.test(typed)) s.person = typed;
  }
  return s;
}

/** The most recent person, project and document the conversation mentioned (each from the latest turn naming one). */
function lastSubject(history: Turn[]): Subject {
  const out: Subject = {};
  for (const t of [...history].reverse()) {
    const s = subjectsIn(t);
    if (!out.person && s.person) out.person = s.person;
    if (!out.project && s.project) out.project = s.project;
    if (!out.doc && s.doc) out.doc = s.doc;
    if (out.person && out.project && out.doc) break;
  }
  return out;
}

/** Earlier questions in a shape a new subject can be put into ("Who is the X?", "What is X working on?"). */
const TEMPLATES: { re: RegExp; make: (x: string) => string }[] = [
  { re: /^\s*(?:who is|who's)\s+(?:the\s+)?.+?\??\s*$/i, make: (x) => `Who is ${/^(the|a|an|our)\b/i.test(x) ? x : `the ${x}`}?` },
  { re: /^\s*(?:what is|what's)\s+.+?\s+working on\??\s*$/i, make: (x) => `What is ${x} working on?` },
  { re: /^\s*how(?:'s| is)\s+.+?\s+doing\??\s*$/i, make: (x) => `How is ${x} doing?` },
  { re: /status of\s+(?:the\s+)?.+?\s+project/i, make: (x) => `What is the status of the ${x.replace(/^the\s+/i, "")} project?` },
  { re: /^\s*ai (?:là|phụ trách)\s+.+$/i, make: (x) => `Ai là ${x}?` },
  { re: /^\s*.+?\s+đang làm gì/i, make: (x) => `${x} đang làm gì?` },
];

/**
 * A follow-up question as one that stands alone, for the offline model, which reads one question at a time.
 * "What is he working on?" after an answer about Tom Becker → "What is Tom Becker working on?"; "and the design
 * lead?" after "Who is the frontend lead?" → "Who is the design lead?"; "how is that project going?" names the last
 * project. Vietnamese: "anh ấy/chị ấy …", "còn X thì sao?". A question that needs nothing from before is unchanged.
 */
export function resolveFollowUp(question: string, history: Turn[]): string {
  const q = question.trim();
  if (!history.length) return q;
  // "and the design lead?", "what about Maya?", "còn Lily thì sao?": the last question that has a shape, about X.
  const ellipsis = q.match(/^(?:and|what about|how about|and what about)\s+(.+?)\s*\??$/i)?.[1] ?? q.match(/^(?:thế\s+)?còn\s+(.+?)(?:\s+thì sao)?\s*\??$/i)?.[1];
  if (ellipsis) {
    const x = ellipsis.trim();
    const asked = [...history].reverse().filter((t) => t.role === "user");
    // "the design lead" is a role: it goes back into the last "who is …" question, even with a turn in between.
    if (/^(the|our|a|an)\s/i.test(x)) {
      const who = asked.find((t) => TEMPLATES[0]!.re.test(t.content.trim()));
      if (who) return TEMPLATES[0]!.make(x);
    }
    // "how many tasks are overdue for her?" then "what about Tom?": the same question, for Tom.
    const prev = asked[0]?.content.trim() ?? "";
    if (/\b(for|of|về|của)\s+[^?]+\??$/i.test(prev) && !/^(the|our|a|an)\s/i.test(x)) return prev.replace(/\b(for|of|về|của)\s+[^?]+(\??)$/i, `$1 ${x}$2`);
    for (const t of asked) {
      const tpl = TEMPLATES.find((tp) => tp.re.test(t.content.trim()));
      if (tpl) return tpl.make(x);
    }
    return ellipsis;
  }
  const s = lastSubject(history);
  let out = q;
  if (s.person) {
    out = out
      .replace(/\b(he|she|they|him|them)\b/gi, s.person)
      .replace(/\b(his|her|their)\b(?=\s+\w)/gi, `${s.person}'s`)
      .replace(/\b(her|him)\b/gi, s.person)
      .replace(/\b(anh ấy|chị ấy|cô ấy|em ấy|bạn ấy|ông ấy|bà ấy|người này|người đó|họ)(?=\s|\?|$)/giu, s.person);
  }
  if (s.project) out = out.replace(/\b(that|this|the same) project\b/gi, `the ${s.project} project`).replace(/dự án (đó|này)/giu, `dự án ${s.project}`);
  if (s.doc) out = out.replace(/\b(that|this) (document|doc|page|policy)\b/gi, s.doc).replace(/tài liệu (đó|này)/giu, s.doc);
  // A bare "it" means the last project, else the last document.
  const thing = s.project ? `the ${s.project} project` : s.doc;
  if (thing) out = out.replace(/\bit\b(?=[\s?.!]|$)/i, thing).replace(/\babout that\b/i, `about ${thing}`);
  return out;
}
