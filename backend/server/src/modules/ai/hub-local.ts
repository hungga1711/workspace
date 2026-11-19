import type { Lang } from "./local-model.js";

/**
 * The built-in model's answers for AI › Tiến độ and Áp dụng AI: sentences put together from the same facts the page
 * shows (no text is generated beyond them), so the "analyze" buttons work in an installation without a hosted model.
 */

interface Reason {
  kind: string;
  count?: number;
  days?: number;
}
interface ProgressFacts {
  scope?: "team" | "self";
  people?: number;
  totals?: Record<string, number>;
  attention?: { userId: string; name: string; reasons: Reason[]; open: number }[];
  doingWell?: { name: string; done7: number }[];
}

const REASON: Record<Lang, Record<string, (r: Reason) => string>> = {
  vi: {
    overdue: (r) => `${r.count} việc trễ`,
    blocked: (r) => `${r.count} việc bị kẹt`,
    atRisk: (r) => `${r.count} việc có nguy cơ trễ`,
    stale: (r) => `${r.count} việc lâu chưa cập nhật`,
    quiet: (r) => `${r.days} ngày không cập nhật gì`,
    slowing: () => "tuần này xong ít hơn hẳn mọi khi",
    overloaded: (r) => `đang ôm ${r.count} việc`,
  },
  en: {
    overdue: (r) => `${r.count} late task${r.count === 1 ? "" : "s"}`,
    blocked: (r) => `${r.count} blocked task${r.count === 1 ? "" : "s"}`,
    atRisk: (r) => `${r.count} task${r.count === 1 ? "" : "s"} at risk`,
    stale: (r) => `${r.count} task${r.count === 1 ? "" : "s"} without an update`,
    quiet: (r) => `no update for ${r.days} days`,
    slowing: () => "much less done this week than usual",
    overloaded: (r) => `holding ${r.count} tasks`,
  },
};

export function localProgress(facts: ProgressFacts, lang: Lang): string {
  const en = lang === "en";
  const t = facts.totals ?? {};
  const att = facts.attention ?? [];
  const why = (a: (typeof att)[number]) => a.reasons.map((r) => REASON[lang][r.kind]?.(r) ?? r.kind).join(", ");
  if (facts.scope === "self") {
    const me = att[0];
    return JSON.stringify({
      summary: me
        ? en
          ? `Your work needs a look: ${why(me)}.`
          : `Việc của bạn cần xem lại: ${why(me)}.`
        : en
          ? "Your work is on track: nothing late or blocked."
          : "Việc của bạn đang ổn: không có gì trễ hay kẹt.",
      people: [],
      next: me
        ? me.reasons.map((r) =>
            r.kind === "overdue"
              ? en
                ? "Finish or re-date the late tasks first, and tell whoever is waiting."
                : "Làm xong hoặc dời hạn các việc trễ trước, báo cho người đang chờ."
              : r.kind === "blocked"
                ? en
                  ? "Ask for what is blocking you today, or hand that task back."
                  : "Hỏi ngay người đang chặn việc, hoặc trả lại việc đó."
                : en
                  ? "Post a short progress update on the tasks you are working on."
                  : "Cập nhật tiến độ ngắn cho các việc đang làm.",
          )
        : [],
    });
  }
  const late = t.overdue ?? 0;
  const summary = en
    ? `${facts.people ?? 0} people, ${t.open ?? 0} open tasks, ${late} late and ${t.blocked ?? 0} blocked; ${t.done7 ?? 0} done in the last 7 days.${
        att[0]
          ? ` Start with ${att
              .slice(0, 3)
              .map((a) => a.name)
              .join(", ")}.`
          : ""
      }${facts.doingWell?.length ? ` ${facts.doingWell.map((d) => d.name).join(", ")} had a good week.` : ""}`
    : `${facts.people ?? 0} người, ${t.open ?? 0} việc đang mở, ${late} việc trễ và ${t.blocked ?? 0} việc kẹt; ${t.done7 ?? 0} việc xong trong 7 ngày.${
        att[0]
          ? ` Nên bắt đầu với ${att
              .slice(0, 3)
              .map((a) => a.name)
              .join(", ")}.`
          : ""
      }${facts.doingWell?.length ? ` ${facts.doingWell.map((d) => d.name).join(", ")} có một tuần tốt.` : ""}`;
  return JSON.stringify({
    summary,
    people: att.map((a) => {
      const first = a.name.split(" ")[0] ?? a.name;
      const kinds = new Set(a.reasons.map((r) => r.kind));
      const nudge = kinds.has("blocked")
        ? en
          ? `Hi ${first}, I see something is blocking you. What do you need from me to move it forward?`
          : `Chào ${first}, mình thấy có việc đang bị kẹt. Bạn cần mình hỗ trợ gì để gỡ không?`
        : kinds.has("overdue")
          ? en
            ? `Hi ${first}, a few tasks are past their due date. Can you share where they stand and a realistic new date?`
            : `Chào ${first}, vài việc đã quá hạn. Bạn cập nhật giúp tình hình và hạn mới thực tế nhé?`
          : en
            ? `Hi ${first}, could you post a quick progress update on what you are working on?`
            : `Chào ${first}, bạn cập nhật nhanh tiến độ các việc đang làm giúp mình nhé?`;
      return { userId: a.userId, why: en ? `${a.name}: ${why(a)}.` : `${a.name}: ${why(a)}.`, nudge };
    }),
    next: en
      ? ["Send the nudges to the people at the top of the list.", "Re-date or reassign work that cannot land on time.", "Thank the people who had a good week."]
      : ["Gửi lời nhắc cho những người đầu danh sách.", "Dời hạn hoặc giao lại việc không kịp.", "Ghi nhận những người có tuần tốt."],
  });
}

interface AdoptionFacts {
  scope?: "team" | "self";
  suggestions?: { topic: string; tasks: number; coverage: number; departments?: string[] }[];
}
const PROMPT: Record<Lang, Record<string, string>> = {
  vi: {
    writing: "Soạn [loại văn bản] gửi [người nhận] về [chủ đề]. Ý chính: [ý 1], [ý 2]. Giọng văn: [lịch sự/ngắn gọn]. Dài khoảng [số] câu.",
    sales: "Soạn email báo giá cho khách hàng [ngành] quan tâm tới [sản phẩm]. Nêu 3 lợi ích, giá [mức giá] và đề nghị một cuộc gọi tuần này.",
    analysis: "Đây là bảng số liệu [mô tả, đã bỏ thông tin cá nhân]. Tóm tắt 3 xu hướng chính, điểm bất thường và gợi ý một biểu đồ phù hợp.",
    code: "Giải thích lỗi sau và đề xuất cách sửa, kèm một test tái hiện lỗi: [dán thông báo lỗi và đoạn code liên quan].",
    planning: "Mục tiêu: [mục tiêu], hạn chót [ngày]. Chia thành các bước nhỏ, ước lượng thời gian từng bước và chỉ ra 3 rủi ro chính.",
    translation: "Dịch đoạn sau sang [ngôn ngữ], giữ giọng văn [trang trọng/thân mật], giữ nguyên tên riêng: [đoạn văn].",
    research: "Tóm tắt nhanh về [chủ đề] cho người mới: khái niệm chính, các lựa chọn phổ biến và 5 câu hỏi cần kiểm chứng.",
    hr: "Viết mô tả công việc cho vị trí [chức danh] ở phòng [phòng ban]: nhiệm vụ, yêu cầu, quyền lợi (không ghi lương).",
    design: "Viết brief thiết kế cho [ấn phẩm]: mục tiêu, người xem, thông điệp chính, kích thước và 3 hướng ý tưởng.",
  },
  en: {
    writing: "Draft a [kind of message] to [recipient] about [topic]. Key points: [point 1], [point 2]. Tone: [polite/brief]. About [n] sentences.",
    sales: "Draft a quote email for a [industry] customer interested in [product]. Give 3 benefits, the price [price] and propose a call this week.",
    analysis: "Here is a table [describe it, personal data removed]. Summarise the 3 main trends, anything unusual, and suggest a fitting chart.",
    code: "Explain this error and propose a fix with a test that reproduces it: [paste the error and the relevant code].",
    planning: "Goal: [goal], deadline [date]. Break it into small steps, estimate each, and name the 3 main risks.",
    translation: "Translate the following into [language], keeping a [formal/friendly] tone and all names unchanged: [text].",
    research: "Give a newcomer a quick overview of [topic]: key ideas, common options and 5 questions to verify.",
    hr: "Write a job description for [title] in [department]: duties, requirements, benefits (no salary).",
    design: "Write a design brief for [piece]: goal, audience, key message, sizes and 3 idea directions.",
  },
};
const TOPIC: Record<Lang, Record<string, string>> = {
  vi: {
    writing: "soạn thảo",
    sales: "bán hàng",
    analysis: "phân tích số liệu",
    code: "lập trình",
    planning: "lập kế hoạch",
    translation: "dịch",
    research: "tìm hiểu",
    hr: "nhân sự",
    design: "thiết kế",
  },
  en: {
    writing: "writing",
    sales: "sales",
    analysis: "data analysis",
    code: "coding",
    planning: "planning",
    translation: "translation",
    research: "research",
    hr: "HR",
    design: "design",
  },
};

export function localAdoption(facts: AdoptionFacts, lang: Lang): string {
  const en = lang === "en";
  const s = (facts.suggestions ?? []).filter((x) => PROMPT[lang][x.topic]);
  return JSON.stringify({
    summary: s.length
      ? en
        ? `Most room for AI: ${s.map((x) => `${TOPIC.en[x.topic]} (${x.tasks} tasks, ${Math.round(x.coverage * 100)}% using AI)`).join(", ")}.`
        : `Nhiều chỗ nhất để dùng AI: ${s.map((x) => `${TOPIC.vi[x.topic]} (${x.tasks} việc, ${Math.round(x.coverage * 100)}% đang dùng AI)`).join(", ")}.`
      : en
        ? "Not enough clearly named work to suggest anything yet."
        : "Chưa đủ việc có tên rõ ràng để gợi ý.",
    ideas: s.slice(0, 4).map((x) => ({
      title: en ? `Use AI for ${TOPIC.en[x.topic]}` : `Dùng AI cho việc ${TOPIC.vi[x.topic]}`,
      topic: x.topic,
      who: (x.departments ?? []).join(", "),
      how: en
        ? "Start from the sample prompt, fill in the brackets, then read the answer critically and fix facts and figures before using it."
        : "Bắt đầu từ prompt mẫu, điền phần trong ngoặc, rồi đọc kỹ câu trả lời và sửa lại số liệu trước khi dùng.",
      prompt: PROMPT[lang][x.topic],
    })),
  });
}

/** What to ask AI for, per kind of work, when the built-in model writes a task's prompt. */
const ASK: Record<Lang, Record<string, string>> = {
  vi: {
    writing: "Hãy soạn bản nháp đầu tiên, liệt kê những thông tin tôi cần bổ sung và đưa thêm một phiên bản ngắn gọn hơn.",
    sales: "Hãy soạn email gửi khách (ngắn, rõ lợi ích, có lời mời hành động) và 3 câu khách có thể hỏi kèm cách trả lời.",
    analysis: "Hãy gợi ý các chỉ số nên xem, cách trình bày (bảng, biểu đồ) và những câu hỏi số liệu cần trả lời.",
    code: "Hãy chia việc thành các bước kỹ thuật, chỉ ra các trường hợp dễ lỗi cần test và cách kiểm tra trước khi gửi duyệt.",
    planning: "Hãy chia thành các bước nhỏ có thời lượng ước tính, sắp thứ tự và chỉ ra 3 rủi ro lớn nhất kèm cách phòng.",
    translation: "Tôi sẽ dán nội dung cần dịch: hãy dịch tự nhiên, giữ thuật ngữ chuyên ngành và đánh dấu câu chưa chắc.",
    research: "Hãy cho tôi bức tranh tổng quan, các phương án chính kèm ưu nhược điểm và những điều cần kiểm chứng.",
    hr: "Hãy soạn bản nháp rõ ràng, thân thiện và nêu những điểm cần xác nhận với quản lý.",
    design: "Hãy viết brief thiết kế (mục tiêu, người dùng, thông điệp chính), gợi ý 3 hướng ý tưởng và phần chữ cần có.",
    other: "Hãy gợi ý cách làm từng bước, phần nào AI có thể làm giúp và phần nào tôi nên tự kiểm tra.",
  },
  en: {
    writing: "Write a first draft, list what information I still need to add, and give a shorter version too.",
    sales: "Write an email to the customer (short, clear benefit, a call to action) and 3 questions they may ask with answers.",
    analysis: "Suggest the measures to look at, how to present them (table, chart) and the questions the numbers should answer.",
    code: "Break it into technical steps, list the edge cases worth testing and how to check it before review.",
    planning: "Break it into small steps with estimates, put them in order and name the 3 biggest risks with how to prevent them.",
    translation: "I'll paste the text: translate it naturally, keep the technical terms and mark any sentence you're unsure of.",
    research: "Give me an overview, the main options with pros and cons, and what to verify at official sources.",
    hr: "Write a clear, friendly draft and list what to confirm with a manager.",
    design: "Write a design brief (goal, audience, key message), suggest 3 directions and the copy it needs.",
    other: "Suggest how to do it step by step, which parts AI can do for me and which I should check myself.",
  },
};

/** The built-in model's prompt for one task: its code and title, then the ask for its kind of work. */
export function localTaskPrompt(facts: { code?: string; title?: string; topic?: string }, lang: Lang): string {
  const ask = ASK[lang][facts.topic ?? "other"] ?? ASK[lang].other!;
  const task = `${facts.code ?? ""} "${facts.title ?? ""}"`.trim();
  const intro = lang === "en" ? `I'm working on ${task}.` : `Tôi đang làm việc ${task}.`;
  const more = lang === "en" ? "Ask me if you need more detail." : "Hỏi lại tôi nếu cần thêm thông tin.";
  return JSON.stringify({ prompt: `${intro} ${ask} ${more}` });
}
