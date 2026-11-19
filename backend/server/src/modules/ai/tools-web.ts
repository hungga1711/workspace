import { z } from "zod";
import { siteOf } from "./progress.js";
import { ToolProblem, type Tool } from "./tools.js";
import { clip, en, enc, str, work, type Say, type Write } from "./workspace-kit.js";

/**
 * A linked web page for an AI that has no web tools of its own: a model on the company's server, an agent
 * that cannot be held to its web tools. Offered only when the question links a page (tool-select.ts, area "web"); an
 * AI with its own page reading (Claude, Gemini, Claude Code) may use either. Read by the work module's fenced reader
 * (no private or local addresses), as the asker. There is no web search here: the answer says so (WEB_RULES).
 */

const PROBLEM: Record<string, Say> = {
  private: { en: "the page needs a sign-in or is not shared", vi: "trang cần đăng nhập hoặc chưa được chia sẻ" },
  folder: { en: "it is a folder, not a page", vi: "đó là một thư mục, không phải một trang" },
  unreachable: { en: "the site did not answer", vi: "trang web không phản hồi" },
  unreadable: { en: "the page has no readable text", vi: "trang không có nội dung đọc được" },
  refused: { en: "this address cannot be opened from here (private or not http/https)", vi: "không mở được địa chỉ này (địa chỉ nội bộ hoặc không phải http/https)" },
};

export const READ: Tool[] = [
  {
    name: "read_webpage",
    description:
      "Read a web page outside the workspace by its address (https://…), as plain text, to summarize it or answer from it. Google Docs, Sheets and Slides links shared with anyone are read too. Only for an address the user gave; this tool cannot search the web.",
    permission: "task.read",
    input: z.object({ url: z.string().trim().url().max(2000) }),
    jsonSchema: { type: "object", properties: { url: str("the page's full address, https://…") }, required: ["url"] },
    async run(ctx, input) {
      const r = await work<{ ok: boolean; kind: string; text?: string; cut?: boolean; problem?: string }>(ctx, "GET", `/link-text?url=${enc(input.url)}`);
      if (!r.ok)
        throw new ToolProblem(`${en(ctx) ? "Could not read the page" : "Không đọc được trang"}: ${(PROBLEM[r.problem ?? ""] ?? PROBLEM.unreachable!)[en(ctx) ? "en" : "vi"]}.`);
      const site = siteOf(input.url);
      return {
        ok: true,
        content: `${site}\n\n${clip(r.text ?? "", 40_000)}${r.cut ? (en(ctx) ? "\n\n(The page is longer: only its beginning was read.)" : "\n\n(Trang dài hơn: chỉ đọc phần đầu.)") : ""}`,
        sources: [{ type: "web", id: input.url, title: site.slice(0, 200), url: input.url }],
      };
    },
  },
];
export const WRITE: Write[] = [];
export const TITLES: Record<string, Say> = { read_webpage: { en: "Read a web page", vi: "Đọc trang web" } };
