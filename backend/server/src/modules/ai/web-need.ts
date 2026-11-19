/**
 * Whether a question needs the connected AI's own web or cloud tools: searching the web, reading a page,
 * running code over an attached spreadsheet. Off for every other question: on a computer's AI (Claude Code) turning
 * tools on costs ~10 s per answer, and a hosted model with web tools may search when nothing asked for it. Only
 * web/cloud tools ever: the files and shell of a connected computer are never offered for answers.
 *
 * Deterministic and cheap (no model call), on the folded question (no accents, lower case): vi, en, zh, es.
 */

export interface WebNeed {
  /** Look things up on the web: the question asks for it, or for news, competitors, market prices. */
  search: boolean;
  /** Read the pages the question links to. */
  fetch: boolean;
  /** Run code over an attached spreadsheet or document (the provider's own sandbox). */
  code: boolean;
  /** The outside addresses in the question (never the app's own screens, which the workspace tools read). */
  urls: string[];
}

export const NO_WEB: WebNeed = { search: false, fetch: false, code: false, urls: [] };

const fold = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase();

const SEARCH =
  /\b(tim (kiem )?(tren|o tren|qua) (mang|web|internet|google|online)|tra (cuu|google) (tren mang|online|tren web|tren internet)|tren (mang|internet|web)|google (giup|thu|xem)|search (the )?(web|internet|online)|web search|search for .{2,60} online|look (it |this |that )?up online|on the (web|internet)|google (it|this|that|for)|tin tuc|news|bao chi|doi thu|competitors?|gia (thi truong|hien tai|hom nay)|market price|current price|price of|ty gia|exchange rate|buscar en (la )?(web|internet)|en internet|noticias|competencia|precio (actual|de mercado))\b|搜索|网上|上网|新闻|竞争对手|市场价|汇率/;

/** Analysis words: with a spreadsheet attached, the provider's code sandbox computes instead of the model guessing. */
const ANALYSE =
  /\b(phan tich|tinh|tong|trung binh|loc|so sanh|thong ke|bieu do|ve|analy[sz]\w*|calculat\w*|sum|total|average|mean|median|filter|compare|chart|plot|pivot|statistic\w*|trend|analiza\w*|calcula\w*|promedio|grafic\w*)\b|分析|计算|统计|图表|平均/;
const SHEET = /[\w\-. ]+\.(xlsx|xls|csv|tsv)\b/i;
const DOCUMENT = /[\w\-. ]+\.(docx|pptx|pdf)\b/i;

const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]]+/gi;

/** An outside page: the app's own screens (/app/…) and private addresses are read by the workspace tools, not fetched. */
export function outsideUrls(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const raw = m[0].replace(/[.,;:!?]+$/, "");
    let u: URL;
    try {
      u = new URL(raw);
    } catch {
      continue;
    }
    const host = u.hostname.toLowerCase();
    if (u.pathname.startsWith("/app/") || host === "localhost" || host.endsWith(".local") || /^(127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) continue;
    if (!out.includes(u.toString())) out.push(u.toString());
    if (out.length >= 5) break;
  }
  return out;
}

/**
 * What a question needs. `attached`: the names of the files sent with it (or the message text that lists them), so a
 * spreadsheet to analyse turns the code sandbox on.
 */
export function webNeed(question: string, attached: readonly string[] = []): WebNeed {
  const q = fold(question);
  const urls = outsideUrls(question);
  const files = attached.join("\n");
  const sheet = SHEET.test(files);
  const doc = DOCUMENT.test(files);
  return {
    search: SEARCH.test(q),
    fetch: urls.length > 0,
    // A spreadsheet always (the numbers are what people ask about); a document only when the question asks to compute.
    code: sheet || (doc && ANALYSE.test(q)),
    urls,
  };
}

export const needsWeb = (n: WebNeed | null | undefined) => !!n && (n.search || n.fetch || n.code);
