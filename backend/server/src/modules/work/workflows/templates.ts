import {
  normalizeConfig,
  normalizeSteps,
  runnerOf,
  type Category,
  type Environment,
  type Guardrails,
  type InputType,
  type Output,
  type Runner,
  type WorkflowConfig,
  type WorkflowStep,
} from "./model.js";

/**
 * Ready-made workflows for every department. A copy is made when one is used, so a team changes
 * it freely. Written in English and Vietnamese; Chinese and Spanish get the English text (the model reads English
 * either way).
 *
 * How each one is built, because of how a run passes data (render.ts):
 * - A later step reads exactly what it needs with {{steps.<key>}}; {{previous}} is the last result plus any note an
 *   approver gave since, so the step right after an approval reads {{previous}}.
 * - The last AI step returns only the deliverable: that text is posted on the task, saved as a page, and its
 *   "- [ ]" lines become subtasks when the output says so. So only lines meant as subtasks are written as checkboxes.
 * - No AI result reaches the task unlooked at: a `check` (an AI judge, or a command's exit code on a runner) sends
 *   weak work back to the step that made it before a person is asked to approve.
 * - A check's criteria stand on their own (the judge reads the result under review), so anything that must be
 *   compared with a source is first corrected by an AI "verify" step that reads that source.
 * - The first AI step is told what is worth asking about; the others decide and say what they assumed.
 */

type L = "vi" | "en";
type Tx = Record<L, string>;
const t = (en: string, vi: string): Tx => ({ en, vi });

interface TemplateInput {
  key: string;
  label: Tx;
  type?: InputType;
  options?: Record<L, string[]>;
  required?: boolean;
  placeholder?: Tx;
  default?: Tx;
}
type TemplateStep = Omit<WorkflowStep, "title" | "prompt" | "role" | "criteria"> & { title: Tx; prompt?: Tx; role?: Tx; criteria?: Tx };

export interface Template {
  key: string;
  category: Category;
  name: Tx;
  description: Tx;
  /** How to use it, a line each: what to put in the task, what to set up once. */
  uses: Record<L, string[]>;
  /** Where it runs; absent = the company's AI on the server. */
  environment?: Environment;
  inputs?: TemplateInput[];
  /** The playbook skeleton the company fills in (resources.notes). */
  notes?: Tx;
  taskFiles?: boolean;
  guardrails?: Partial<Guardrails>;
  output?: Partial<Output>;
  steps: TemplateStep[];
}

const approval = (key: string, title: Tx, approver?: WorkflowStep["approver"]): TemplateStep => ({ key, kind: "approval", title, ...(approver ? { approver } : {}) });
const APPROVE = t("Approve", "Duyệt");
const TO_REVIEW: TemplateStep = { key: "to-review", kind: "status", status: "review", title: t("Move to In review", "Chuyển sang Đang duyệt") };

/** The rule every writing step ends with: nothing invented. */
const ONLY = t(
  "Use only what the task, the inputs and the reference material say. Where they do not say, write [missing] instead of guessing.",
  "Chỉ dùng những gì việc, thông tin đầu vào và tài liệu tham chiếu nêu. Chỗ nào không có thì ghi [thiếu], không đoán.",
);

export const TEMPLATES: Template[] = [
  // ── Engineering: on the assignee's computer with their coding agent, ending in a pull request ─────────────────
  {
    key: "ship-change",
    category: "coding",
    environment: { kind: "computer" },
    name: t("Ship a change: plan → approve → code → tests → review → PR", "Làm thay đổi code: kế hoạch → duyệt → code → test → review → PR"),
    description: t(
      "Runs on the assignee's computer with their coding agent. The agent plans, a person approves the plan, the agent writes the code and tests, failing tests go back to it, it reviews its own work and opens a pull request.",
      "Chạy trên máy người được giao, bằng coding agent của họ. Agent lập kế hoạch, người duyệt kế hoạch, agent viết code và test, test hỏng thì trả về cho agent sửa, agent tự review rồi mở pull request.",
    ),
    uses: {
      en: [
        "Describe the change and what “done” means in the task",
        "The assignee starts the run from their repository folder",
        "Change the test command if the project does not use npm",
      ],
      vi: ["Mô tả thay đổi và thế nào là “xong” trong việc", "Người được giao bấm Chạy từ thư mục repo của họ", "Đổi lệnh test nếu dự án không dùng npm"],
    },
    guardrails: { maxMinutes: 120, stepMinutes: 30 },
    steps: [
      {
        key: "plan",
        kind: "ai",
        model: "opus",
        role: t("A staff engineer: reads the code before planning.", "Kỹ sư trưởng: đọc code trước khi lập kế hoạch."),
        title: t("Plan", "Lập kế hoạch"),
        prompt: t(
          "Read the task below and the code in this folder. Write a short change plan in Markdown: ## Approach, ## Files to touch, ## How it will be tested, ## Risks. Do not edit code yet. Ask only if the task leaves the expected behaviour unclear.\n\n{{task}}",
          "Đọc việc dưới đây và mã nguồn trong thư mục này. Viết kế hoạch thay đổi ngắn gọn bằng Markdown: ## Cách làm, ## Các file cần sửa, ## Cách kiểm thử, ## Rủi ro. Chưa sửa code. Chỉ hỏi khi việc chưa nói rõ hành vi mong muốn.\n\n{{task}}",
        ),
      },
      approval("approve-plan", t("Approve the plan", "Duyệt kế hoạch")),
      {
        key: "code",
        kind: "ai",
        model: "sonnet",
        ask: false,
        title: t("Implement", "Viết code"),
        prompt: t(
          "Carry out the plan below on a new branch named after the task code; a note from the approver, if any, is at its end and comes first. Add tests for the change. Commit when done: the first line of the message says what changed, the body why. Then summarize what you changed.\n\nPlan:\n{{previous}}\n\n{{task}}",
          "Thực hiện kế hoạch dưới đây trên một nhánh mới đặt theo mã việc; ghi chú của người duyệt, nếu có, nằm ở cuối và được ưu tiên. Viết test cho phần thay đổi. Commit khi xong: dòng đầu của message nói đã đổi gì, phần thân nói vì sao. Sau đó tóm tắt những gì đã đổi.\n\nKế hoạch:\n{{previous}}\n\n{{task}}",
        ),
      },
      { key: "tests", kind: "check", command: "npm test", attempts: 3, onFail: "stop", title: t("Tests pass", "Test chạy qua") },
      {
        key: "review",
        kind: "ai",
        model: "opus",
        ask: false,
        role: t("A strict code reviewer.", "Người review code khắt khe."),
        title: t("Self-review", "Tự review"),
        prompt: t(
          "Review the changes on this branch against the main branch and against the task: bugs, edge cases, missing tests, anything the task asked for that is not done. Fix what needs fixing and commit. Then write for the human reviewer: ## What changed, ## Look closely at, ## Not done.\n\nThe plan:\n{{steps.plan}}\n\n{{task}}",
          "Review thay đổi trên nhánh hiện tại so với nhánh chính và so với việc: lỗi, trường hợp biên, thiếu test, phần việc yêu cầu mà chưa làm. Sửa những gì cần sửa và commit. Sau đó viết cho người review: ## Đã đổi gì, ## Cần xem kỹ, ## Chưa làm.\n\nKế hoạch:\n{{steps.plan}}\n\n{{task}}",
        ),
      },
      { key: "retest", kind: "check", command: "npm test", attempts: 2, onFail: "stop", title: t("Tests still pass", "Test vẫn chạy qua") },
      // A command, not an AI step: nothing here needs a model, and its output (the pull request's address) is the
      // result posted on the task.
      { key: "pr", kind: "command", title: t("Open a pull request", "Mở pull request"), command: "git push -u origin HEAD && gh pr create --fill" },
      TO_REVIEW,
    ],
  },
  {
    key: "fix-bug",
    category: "coding",
    environment: { kind: "computer" },
    name: t("Fix a bug: reproduce → approve → fix → tests → PR", "Sửa lỗi: tái hiện → duyệt → sửa → test → PR"),
    description: t(
      "Runs on the assignee's computer with their coding agent. The agent reproduces the bug with a failing test and finds the cause, a person approves the fix, the agent fixes it, failing tests go back to it, and it opens a pull request.",
      "Chạy trên máy người được giao, bằng coding agent của họ. Agent tái hiện lỗi bằng một test thất bại và tìm nguyên nhân, người duyệt cách sửa, agent sửa lỗi, test hỏng thì trả về cho agent, rồi mở pull request.",
    ),
    uses: {
      en: ["Put the bug report in the task: steps, expected, actual, version", "The assignee starts the run from their repository folder"],
      vi: ["Ghi báo cáo lỗi vào việc: các bước, mong đợi, thực tế, phiên bản", "Người được giao bấm Chạy từ thư mục repo của họ"],
    },
    guardrails: { maxMinutes: 90, stepMinutes: 30 },
    steps: [
      {
        key: "reproduce",
        kind: "ai",
        model: "opus",
        role: t("A debugger: proves the cause before proposing a fix.", "Người gỡ lỗi: chứng minh nguyên nhân trước khi đề xuất cách sửa."),
        title: t("Reproduce and find the cause", "Tái hiện và tìm nguyên nhân"),
        prompt: t(
          "Read the bug report in the task below and the code in this folder. On a new branch named after the task code, write a test that fails because of this bug and commit it; do not fix the bug yet. Then report: ## How to reproduce, ## Cause (file and function), ## Proposed fix, ## What else it could affect. Ask only if the report does not say how to trigger the bug.\n\n{{task}}",
          "Đọc báo cáo lỗi trong việc dưới đây và mã nguồn trong thư mục này. Trên một nhánh mới đặt theo mã việc, viết một test thất bại vì lỗi này và commit; chưa sửa lỗi. Sau đó báo cáo: ## Cách tái hiện, ## Nguyên nhân (file và hàm), ## Cách sửa đề xuất, ## Những chỗ khác có thể bị ảnh hưởng. Chỉ hỏi khi báo cáo không nói cách làm lỗi xảy ra.\n\n{{task}}",
        ),
      },
      approval("approve-fix", t("Approve the fix", "Duyệt cách sửa")),
      {
        key: "fix",
        kind: "ai",
        model: "sonnet",
        ask: false,
        title: t("Fix", "Sửa lỗi"),
        prompt: t(
          "Fix the bug as proposed below; a note from the approver, if any, is at the end and comes first. Make the failing test pass with the smallest change that removes the cause, not the symptom. Commit when done: the first line of the message says what was wrong, the body how it was fixed. Then summarize the fix in three lines.\n\nDiagnosis:\n{{previous}}\n\n{{task}}",
          "Sửa lỗi theo đề xuất dưới đây; ghi chú của người duyệt, nếu có, nằm ở cuối và được ưu tiên. Làm cho test đang thất bại chạy qua bằng thay đổi nhỏ nhất xử lý được nguyên nhân, không chỉ triệu chứng. Commit khi xong: dòng đầu của message nói lỗi gì, phần thân nói đã sửa thế nào. Sau đó tóm tắt cách sửa trong ba dòng.\n\nChẩn đoán:\n{{previous}}\n\n{{task}}",
        ),
      },
      { key: "tests", kind: "check", command: "npm test", attempts: 3, onFail: "stop", title: t("Tests pass", "Test chạy qua") },
      { key: "pr", kind: "command", title: t("Open a pull request", "Mở pull request"), command: "git push -u origin HEAD && gh pr create --fill" },
      TO_REVIEW,
    ],
  },
  {
    key: "review-pr",
    category: "coding",
    environment: { kind: "computer" },
    name: t("Review a pull request: review → security → report → approve", "Review pull request: review → bảo mật → báo cáo → duyệt"),
    description: t(
      "Runs on the reviewer's computer with their coding agent. The agent reads the pull request named in the task, lists what must be fixed and what is missing, checks security and data, merges both into one review, and waits for the reviewer before it is posted on the task.",
      "Chạy trên máy người review, bằng coding agent của họ. Agent đọc pull request nêu trong việc, liệt kê chỗ phải sửa và chỗ còn thiếu, soát bảo mật và dữ liệu, gộp thành một bài review, rồi chờ người review duyệt trước khi đăng lên việc.",
    ),
    uses: {
      en: ["Name the pull request (number or link) or the branch in the task", "The reviewer starts the run from their repository folder"],
      vi: ["Ghi pull request (số hoặc link) hoặc tên nhánh vào việc", "Người review bấm Chạy từ thư mục repo của họ"],
    },
    guardrails: { maxMinutes: 60, stepMinutes: 20, ask: "never" },
    steps: [
      {
        key: "review",
        kind: "ai",
        model: "opus",
        role: t("A strict code reviewer: every finding has a file, a line and a reason.", "Người review code khắt khe: mỗi nhận xét có file, dòng và lý do."),
        title: t("Review", "Review"),
        prompt: t(
          "The task below names a pull request or a branch. Check it out in this folder (gh pr checkout, or git fetch and git switch) and read its changes against the main branch. Do not edit code. Report in Markdown: ## Summary (what the change does, in two sentences), ## Must fix (bugs, broken edge cases, data loss), ## Should fix, ## Missing tests. Each finding: file and line, what is wrong, the change you suggest.\n\n{{task}}",
          "Việc dưới đây nêu một pull request hoặc một nhánh. Checkout nó trong thư mục này (gh pr checkout, hoặc git fetch rồi git switch) và đọc thay đổi so với nhánh chính. Không sửa code. Báo cáo bằng Markdown: ## Tóm tắt (thay đổi này làm gì, trong hai câu), ## Phải sửa (lỗi, trường hợp biên hỏng, mất dữ liệu), ## Nên sửa, ## Thiếu test. Mỗi nhận xét: file và dòng, sai ở đâu, đề xuất sửa thế nào.\n\n{{task}}",
        ),
      },
      {
        key: "security",
        kind: "ai",
        model: "sonnet",
        role: t("A security reviewer: assumes every input is hostile.", "Người soát bảo mật: coi mọi đầu vào là không đáng tin."),
        title: t("Security and data", "Bảo mật và dữ liệu"),
        prompt: t(
          'Read the changes on the checked-out branch against the main branch again, for security and data only: missing permission checks, unvalidated input, injection, secrets in code or logs, personal data exposed, migrations that lose data. Do not edit code. Return only the findings, each with file and line, the risk and the change you suggest; write "Nothing found" when there is nothing.\n\n{{task}}',
          'Đọc lại thay đổi trên nhánh đã checkout so với nhánh chính, chỉ về bảo mật và dữ liệu: thiếu kiểm tra quyền, đầu vào chưa được kiểm tra, injection, secret trong code hoặc log, lộ dữ liệu cá nhân, migration làm mất dữ liệu. Không sửa code. Chỉ trả về các nhận xét, mỗi nhận xét có file và dòng, rủi ro và đề xuất sửa; ghi "Không tìm thấy gì" khi không có.\n\n{{task}}',
        ),
      },
      {
        key: "report",
        kind: "ai",
        model: "sonnet",
        resources: false,
        title: t("One review", "Gộp thành một bài review"),
        prompt: t(
          "Merge the two reviews below into one, in Markdown: ## Summary, ## Must fix, ## Should fix, ## Security and data, ## Missing tests, ## Verdict (approve, approve after fixes, or request changes, and why in one sentence). Remove duplicates, keep every finding's file and line, order each section by severity. Add nothing new.\n\nCode review:\n{{steps.review}}\n\nSecurity review:\n{{steps.security}}",
          "Gộp hai bài review dưới đây thành một, bằng Markdown: ## Tóm tắt, ## Phải sửa, ## Nên sửa, ## Bảo mật và dữ liệu, ## Thiếu test, ## Kết luận (duyệt, duyệt sau khi sửa, hoặc yêu cầu thay đổi, kèm lý do trong một câu). Bỏ phần trùng, giữ file và dòng của từng nhận xét, xếp mỗi mục theo mức nghiêm trọng. Không thêm điều mới.\n\nReview code:\n{{steps.review}}\n\nReview bảo mật:\n{{steps.security}}",
        ),
      },
      {
        key: "check",
        kind: "check",
        attempts: 1,
        onFail: "continue",
        title: t("Findings are usable", "Nhận xét dùng được"),
        criteria: t(
          "Every finding names a file and a line or function\nEvery finding says what is wrong and suggests a change\nThe review ends with a verdict and its reason\nNo finding appears twice",
          "Mỗi nhận xét nêu file và dòng hoặc hàm\nMỗi nhận xét nói sai ở đâu và đề xuất cách sửa\nBài review kết thúc bằng kết luận kèm lý do\nKhông nhận xét nào lặp lại hai lần",
        ),
      },
      approval("approve", t("Approve the review", "Duyệt bài review"), "starter"),
    ],
  },
  {
    key: "repo-audit",
    category: "coding",
    environment: {
      kind: "sandbox",
      host: "company",
      isolation: "container",
      image: "node:22-slim",
      network: "on",
      setup: "npm ci --ignore-scripts || npm install --ignore-scripts",
    },
    name: t("Dependency audit in a sandbox: scan → report → check → approve", "Kiểm tra thư viện trong sandbox: quét → báo cáo → kiểm tra → duyệt"),
    description: t(
      "Clones the repository into a clean container on a company computer, runs the dependency scans there, and has the AI turn the raw results into a prioritized report whose upgrade actions become subtasks. Nothing runs on anyone's own computer.",
      "Clone repo vào một container sạch trên máy của công ty, chạy các lệnh quét thư viện ở đó, rồi AI biến kết quả thô thành báo cáo có ưu tiên; các việc nâng cấp trở thành việc con. Không có gì chạy trên máy cá nhân.",
    ),
    uses: {
      en: ["Set the repository address in Environment once", "Needs a company computer with Docker", "The raw scan files are attached to the task with the report"],
      vi: ["Điền địa chỉ repo trong phần Môi trường một lần", "Cần một máy của công ty có Docker", "Các file quét thô được đính kèm vào việc cùng báo cáo"],
    },
    inputs: [
      {
        key: "focus",
        label: t("Anything to look at first", "Điều cần xem trước"),
        placeholder: t("e.g. the payment packages", "vd. các gói liên quan thanh toán"),
      },
    ],
    guardrails: { maxMinutes: 45, stepMinutes: 15, ask: "never" },
    output: { files: true, subtasks: true },
    steps: [
      { key: "audit", kind: "command", title: t("Scan for known vulnerabilities", "Quét lỗ hổng đã biết"), command: "npm audit --json > ../out/audit.json || true" },
      { key: "outdated", kind: "command", title: t("List outdated packages", "Liệt kê gói đã cũ"), command: "npm outdated --json > ../out/outdated.json || true" },
      {
        key: "report",
        kind: "ai",
        model: "sonnet",
        role: t("A security engineer writing for the team that owns this code.", "Kỹ sư bảo mật viết cho nhóm sở hữu phần code này."),
        title: t("Write the report", "Viết báo cáo"),
        prompt: t(
          'Read ../out/audit.json (npm audit) and ../out/outdated.json (npm outdated) and package.json in this folder. Do not change any file in the repository. Write the report in Markdown and also save it as ../out/audit-report.md:\n## Summary (counts by severity, the one thing to do first)\n## Vulnerabilities (a table: package, severity, what it allows, fixed in, direct or transitive)\n## Outdated (only major versions behind, or packages no longer maintained)\n## Actions (a checklist, most urgent first: "- [ ] Upgrade <package> to <version>: <why>")\nUse only what the two files say; if a file is empty or missing, say so. Look first at: {{input.focus}}\n\n{{task}}',
          'Đọc ../out/audit.json (npm audit), ../out/outdated.json (npm outdated) và package.json trong thư mục này. Không sửa file nào trong repo. Viết báo cáo bằng Markdown và lưu thêm vào ../out/audit-report.md:\n## Tóm tắt (số lượng theo mức độ, việc cần làm đầu tiên)\n## Lỗ hổng (bảng: gói, mức độ, lỗ hổng cho phép điều gì, đã sửa ở phiên bản nào, trực tiếp hay gián tiếp)\n## Đã cũ (chỉ các gói chậm một phiên bản major trở lên, hoặc không còn được bảo trì)\n## Việc cần làm (checklist, gấp nhất trước: "- [ ] Nâng <gói> lên <phiên bản>: <vì sao>")\nChỉ dùng những gì hai file nêu; nếu file trống hoặc thiếu thì nói rõ. Xem trước: {{input.focus}}\n\n{{task}}',
        ),
      },
      {
        key: "check",
        kind: "check",
        attempts: 1,
        onFail: "continue",
        title: t("Report is actionable", "Báo cáo dùng được"),
        criteria: t(
          "The summary gives counts by severity\nEvery vulnerability row names the package, the severity and the fixed version or says none exists\nEvery action is a checklist line naming a package and a target version\nNo vulnerability is described without a package name",
          "Phần tóm tắt nêu số lượng theo mức độ\nMỗi dòng lỗ hổng nêu gói, mức độ và phiên bản đã sửa, hoặc nói chưa có\nMỗi việc cần làm là một dòng checklist nêu gói và phiên bản đích\nKhông lỗ hổng nào được mô tả mà thiếu tên gói",
        ),
      },
      approval("approve", APPROVE),
    ],
  },

  // ── Product ──────────────────────────────────────────────────────────────────────────────────────
  {
    key: "feature-spec",
    category: "product",
    name: t("Feature spec: problem → options → pick → spec → check", "Đặc tả tính năng: vấn đề → phương án → chọn → đặc tả → kiểm tra"),
    description: t(
      "The AI states the problem from the request in the task, offers two or three ways to solve it, a person picks one, and the AI writes the spec with acceptance criteria. The spec is checked, saved as a page, and its subtasks are created.",
      "AI nêu vấn đề từ yêu cầu trong việc, đưa hai hoặc ba cách giải quyết, người chọn một, rồi AI viết đặc tả có tiêu chí nghiệm thu. Đặc tả được kiểm tra, lưu thành một trang, và các việc con được tạo sẵn.",
    ),
    uses: {
      en: ["Put the request and who asked for it in the task", "When approving the options, write which one you pick"],
      vi: ["Ghi yêu cầu và ai yêu cầu vào việc", "Khi duyệt phương án, ghi rõ bạn chọn phương án nào"],
    },
    inputs: [
      { key: "users", label: t("Who is it for", "Dành cho ai"), placeholder: t("e.g. team leads on mobile", "vd. trưởng nhóm dùng điện thoại") },
      { key: "constraint", label: t("Constraints", "Ràng buộc"), placeholder: t("deadline, platform, what must not change", "hạn, nền tảng, điều không được thay đổi") },
    ],
    guardrails: { maxMinutes: 30 },
    output: { doc: true, subtasks: true },
    steps: [
      {
        key: "problem",
        kind: "ai",
        role: t("A product manager: starts from the user's problem, not the solution.", "Product manager: bắt đầu từ vấn đề của người dùng, không phải giải pháp."),
        title: t("Problem", "Vấn đề"),
        prompt: t(
          `From the request in the task below, write: ## Problem (what is hard today, for whom), ## How they cope now, ## What success looks like, ## Out of scope, ## Unknowns. ${ONLY.en} If it is unclear who has the problem or why it matters now, ask.\n\nFor: {{input.users}}\nConstraints: {{input.constraint}}\n\n{{task}}`,
          `Từ yêu cầu trong việc dưới đây, viết: ## Vấn đề (hôm nay khó ở đâu, với ai), ## Hiện họ xoay xở thế nào, ## Thành công trông ra sao, ## Ngoài phạm vi, ## Chưa rõ. ${ONLY.vi} Nếu chưa rõ ai gặp vấn đề hoặc vì sao bây giờ cần làm thì hỏi.\n\nDành cho: {{input.users}}\nRàng buộc: {{input.constraint}}\n\n{{task}}`,
        ),
      },
      {
        key: "options",
        kind: "ai",
        ask: false,
        role: t("A product engineer: weighs what the user gets against what it costs to build.", "Kỹ sư sản phẩm: cân giữa điều người dùng nhận được và công sức xây dựng."),
        title: t("Options", "Phương án"),
        prompt: t(
          "For the problem below, write ## Options: two or three genuinely different ways to solve it. For each: a short name, what the user sees, what has to change, effort (S, M or L), risks. Then ## Recommendation: the one you would pick and why. Respect the constraints: {{input.constraint}}\n\nProblem:\n{{steps.problem}}",
          "Với vấn đề dưới đây, viết ## Phương án: hai hoặc ba cách giải quyết thật sự khác nhau. Mỗi cách: một tên ngắn, người dùng thấy gì, phải thay đổi gì, công sức (S, M hoặc L), rủi ro. Sau đó ## Đề xuất: cách bạn sẽ chọn và vì sao. Tôn trọng các ràng buộc: {{input.constraint}}\n\nVấn đề:\n{{steps.problem}}",
        ),
      },
      approval("pick", t("Pick an option (note it when approving)", "Chọn phương án (ghi chú khi duyệt)")),
      {
        key: "spec",
        kind: "ai",
        ask: false,
        maxOutput: 4000,
        role: t("A product manager writing for the engineers who will build it.", "Product manager viết cho các kỹ sư sẽ xây dựng."),
        title: t("Spec", "Đặc tả"),
        prompt: t(
          'Write the spec for the option the approver picked (their note is at the end of the options; with no note, use the recommendation). Markdown: ## Problem (two sentences), ## What we build (what the user does, step by step), ## Acceptance criteria (a numbered list, each line testable; not checkboxes), ## Not in this version, ## Open questions, ## Subtasks (the only checkboxes in the document: "- [ ] Title (S, M or L)").\n\nProblem:\n{{steps.problem}}\n\nOptions and the pick:\n{{previous}}',
          'Viết đặc tả cho phương án người duyệt đã chọn (ghi chú của họ nằm cuối phần phương án; không có ghi chú thì dùng phương án đề xuất). Markdown: ## Vấn đề (hai câu), ## Sẽ xây dựng gì (người dùng làm gì, từng bước), ## Tiêu chí nghiệm thu (danh sách đánh số, mỗi dòng kiểm thử được; không dùng ô đánh dấu), ## Chưa làm ở phiên bản này, ## Câu hỏi còn mở, ## Việc con (những ô đánh dấu duy nhất trong tài liệu: "- [ ] Tiêu đề (S, M hoặc L)").\n\nVấn đề:\n{{steps.problem}}\n\nPhương án và lựa chọn:\n{{previous}}',
        ),
      },
      {
        key: "check",
        kind: "check",
        title: t("Spec can be built from", "Đặc tả đủ để xây dựng"),
        criteria: t(
          "Describes exactly one option, not several\nEvery acceptance criterion can be tested with a yes or no\nThe steps say what the user does and what they see\nThe only checkbox lines are subtasks, each with a size\nOpen questions are listed, not hidden in the text",
          "Chỉ mô tả đúng một phương án, không phải nhiều\nMỗi tiêu chí nghiệm thu kiểm thử được bằng có hoặc không\nCác bước nói người dùng làm gì và thấy gì\nNhững dòng có ô đánh dấu chỉ là việc con, mỗi dòng có kích cỡ\nCâu hỏi còn mở được liệt kê riêng, không lẫn trong bài",
        ),
      },
      approval("approve", APPROVE, "owner"),
    ],
  },
  {
    key: "bug-triage",
    category: "product",
    name: t("Bug triage: report → severity → check → approve", "Phân loại lỗi: báo cáo → mức độ → kiểm tra → duyệt"),
    description: t(
      "The AI restates the bug report in the task, asks once for what is missing, then proposes a severity, the area it belongs to, likely duplicates and the next step, and waits for approval.",
      "AI diễn đạt lại báo cáo lỗi trong việc, hỏi một lần những gì còn thiếu, rồi đề xuất mức độ nghiêm trọng, khu vực liên quan, các việc có thể trùng và bước tiếp theo, và chờ duyệt.",
    ),
    uses: {
      en: ["Paste the bug report into the task as it came in", "Describe your severity levels in Resources so the AI uses your scale"],
      vi: ["Dán nguyên báo cáo lỗi vào việc", "Mô tả các mức độ nghiêm trọng của công ty trong Tài nguyên để AI dùng đúng thang"],
    },
    notes: t(
      "## Severity scale\n- Critical: [e.g. data loss, nobody can sign in]\n- High: [a main flow is broken, no workaround]\n- Medium: [broken with a workaround]\n- Low: [cosmetic]\n\n## Areas and owners\n- [Area]: [team or person]",
      "## Thang mức độ\n- Nghiêm trọng: [vd. mất dữ liệu, không ai đăng nhập được]\n- Cao: [một luồng chính hỏng, không có cách tạm]\n- Trung bình: [hỏng nhưng có cách tạm]\n- Thấp: [chỉ là giao diện]\n\n## Khu vực và người phụ trách\n- [Khu vực]: [nhóm hoặc người]",
    ),
    guardrails: { maxMinutes: 20 },
    steps: [
      {
        key: "report",
        kind: "ai",
        model: "fast",
        role: t("A support engineer: restates the report, adds nothing to it.", "Kỹ sư hỗ trợ: diễn đạt lại báo cáo, không thêm gì vào."),
        title: t("Understand the report", "Hiểu báo cáo"),
        prompt: t(
          `From the bug report in the task below, write: ## Summary (one sentence), ## Steps to reproduce, ## Expected and actual, ## Version and environment, ## Missing (what the report does not say). ${ONLY.en} If the steps to reproduce or the version are missing, ask.\n\n{{task}}`,
          `Từ báo cáo lỗi trong việc dưới đây, viết: ## Tóm tắt (một câu), ## Các bước tái hiện, ## Mong đợi và thực tế, ## Phiên bản và môi trường, ## Còn thiếu (điều báo cáo chưa nói). ${ONLY.vi} Nếu thiếu các bước tái hiện hoặc phiên bản thì hỏi.\n\n{{task}}`,
        ),
      },
      {
        key: "triage",
        kind: "ai",
        ask: false,
        role: t(
          "An engineering manager triaging bugs: decides from evidence, says how sure.",
          "Trưởng nhóm kỹ thuật phân loại lỗi: quyết định theo bằng chứng, nói rõ mức chắc chắn.",
        ),
        title: t("Severity and next step", "Mức độ và bước tiếp theo"),
        prompt: t(
          'Write the triage note for the report below, in Markdown: ## Summary (one sentence), ## Steps to reproduce, ## Severity (one level from the scale in the reference material, or critical, high, medium or low when there is none; and why: who is affected, how often, is there a workaround), ## Area (the part of the product, and who should look at it if the reference or the task\'s context shows it), ## Possible duplicates (codes of similar tasks from the context, or "None found"), ## Next step (fix now, schedule, needs more information, or not a bug).\n\nReport:\n{{steps.report}}\n\n{{task}}',
          'Viết phiếu phân loại cho báo cáo dưới đây, bằng Markdown: ## Tóm tắt (một câu), ## Các bước tái hiện, ## Mức độ (một mức theo thang trong tài liệu tham chiếu; nếu không có thì nghiêm trọng, cao, trung bình hoặc thấp; và vì sao: ai bị ảnh hưởng, tần suất, có cách tạm xử lý không), ## Khu vực (phần nào của sản phẩm, và ai nên xem nếu tài liệu tham chiếu hoặc ngữ cảnh của việc cho biết), ## Có thể trùng (mã các việc tương tự trong ngữ cảnh, hoặc "Không thấy"), ## Bước tiếp theo (sửa ngay, xếp lịch, cần thêm thông tin, hoặc không phải lỗi).\n\nBáo cáo:\n{{steps.report}}\n\n{{task}}',
        ),
      },
      {
        key: "check",
        kind: "check",
        model: "fast",
        attempts: 1,
        onFail: "continue",
        title: t("Triage is complete", "Phiếu phân loại đầy đủ"),
        criteria: t(
          "Names exactly one severity level and gives a reason for it\nNames exactly one next step\nThe steps to reproduce are numbered, or the note says they are missing\nNo cause is stated as fact without evidence from the report",
          "Nêu đúng một mức độ và lý do\nNêu đúng một bước tiếp theo\nCác bước tái hiện được đánh số, hoặc phiếu nói rõ là thiếu\nKhông khẳng định nguyên nhân khi báo cáo không có bằng chứng",
        ),
      },
      approval("approve", APPROVE),
    ],
  },
  {
    key: "release-notes",
    category: "product",
    name: t("Release notes: changes → notes → verify → check → approve", "Ghi chú phát hành: thay đổi → ghi chú → đối chiếu → kiểm tra → duyệt"),
    description: t(
      "The AI lists what changed from the task, its subtasks and its project, writes the release notes with upgrade steps, corrects them against that list, and waits for approval. The notes are saved as a page.",
      "AI liệt kê các thay đổi từ việc, việc con và dự án, viết ghi chú phát hành kèm các bước nâng cấp, đối chiếu lại với danh sách đó, rồi chờ duyệt. Ghi chú được lưu thành một trang.",
    ),
    uses: {
      en: [
        "Use it on the release task: its subtasks and project are read as the list of changes",
        "Paste the changelog or merged pull requests into the task if they are not subtasks",
      ],
      vi: [
        "Dùng trên việc phát hành: việc con và dự án của nó được đọc làm danh sách thay đổi",
        "Dán changelog hoặc các pull request đã merge vào việc nếu chúng không phải việc con",
      ],
    },
    inputs: [
      { key: "version", label: t("Version", "Phiên bản"), required: true, placeholder: t("e.g. 2.4.0", "vd. 2.4.0") },
      {
        key: "audience",
        label: t("Written for", "Viết cho"),
        type: "choice",
        options: { en: ["End users", "Administrators", "Developers"], vi: ["Người dùng cuối", "Quản trị viên", "Lập trình viên"] },
        default: t("End users", "Người dùng cuối"),
      },
    ],
    guardrails: { maxMinutes: 25, ask: "never" },
    output: { doc: true },
    steps: [
      {
        key: "changes",
        kind: "ai",
        model: "fast",
        role: t("A release manager: exact, writes down only what the sources say.", "Người quản lý phát hành: chính xác, chỉ ghi điều nguồn có nói."),
        title: t("What changed", "Thay đổi"),
        prompt: t(
          "From the task below and its context (subtasks, comments, linked documents, the project's week), list every change in release {{input.version}}, one per line with its task code or source, under Added, Changed, Fixed and Removed. Mark with (upgrade) any change that needs something from the person upgrading: a migration, a new setting, a breaking change. Add nothing the sources do not say.\n\n{{task}}",
          "Từ việc dưới đây và ngữ cảnh của nó (việc con, bình luận, tài liệu được nhắc, tình hình tuần của dự án), liệt kê mọi thay đổi trong bản phát hành {{input.version}}, mỗi dòng một thay đổi kèm mã việc hoặc nguồn, theo các nhóm Thêm mới, Thay đổi, Sửa lỗi và Gỡ bỏ. Đánh dấu (nâng cấp) cho thay đổi cần người nâng cấp làm gì đó: migration, cấu hình mới, thay đổi không tương thích. Không thêm điều nguồn không nói.\n\n{{task}}",
        ),
      },
      {
        key: "notes",
        kind: "ai",
        role: t("A technical writer: one line per change, from the reader's side.", "Người viết tài liệu kỹ thuật: mỗi thay đổi một dòng, từ góc nhìn người đọc."),
        title: t("Release notes", "Ghi chú phát hành"),
        prompt: t(
          "Write the release notes for version {{input.version}} in Markdown from the list below, for this reader: {{input.audience}}. Sections: ## Added, ## Changed, ## Fixed, ## Removed (leave out an empty section), then ## Upgrade notes with the steps in order for every change marked (upgrade). One line per change, saying what the reader can now do or what is different, in their words, not the task's.\n\nChanges:\n{{steps.changes}}",
          "Viết ghi chú phát hành cho phiên bản {{input.version}} bằng Markdown từ danh sách dưới đây, cho người đọc này: {{input.audience}}. Các mục: ## Thêm mới, ## Thay đổi, ## Sửa lỗi, ## Gỡ bỏ (bỏ mục trống), rồi ## Lưu ý khi nâng cấp gồm các bước theo thứ tự cho mọi thay đổi có đánh dấu (nâng cấp). Mỗi thay đổi một dòng, nói người đọc giờ làm được gì hoặc khác đi thế nào, bằng lời của họ, không phải lời của việc.\n\nThay đổi:\n{{steps.changes}}",
        ),
      },
      {
        key: "verify",
        kind: "ai",
        resources: false,
        role: t("A strict reviewer who did not write these notes.", "Người soát khắt khe, không phải người viết ghi chú này."),
        title: t("Verify against the list", "Đối chiếu với danh sách"),
        prompt: t(
          "Check the release notes against the list of changes: remove any entry that is not in the list, add any change that is missing, and make sure the upgrade notes cover every change marked (upgrade). Return only the corrected notes, complete, with nothing before or after them.\n\nRelease notes:\n{{steps.notes}}\n\nList of changes:\n{{steps.changes}}",
          "Đối chiếu ghi chú phát hành với danh sách thay đổi: bỏ mục không có trong danh sách, thêm thay đổi còn thiếu, và bảo đảm phần lưu ý khi nâng cấp bao quát mọi thay đổi có đánh dấu (nâng cấp). Chỉ trả về toàn bộ ghi chú đã sửa, không thêm gì trước hoặc sau.\n\nGhi chú phát hành:\n{{steps.notes}}\n\nDanh sách thay đổi:\n{{steps.changes}}",
        ),
      },
      {
        key: "check",
        kind: "check",
        model: "fast",
        title: t("Notes are ready to publish", "Ghi chú sẵn sàng để đăng"),
        criteria: t(
          "Each change is one line and says what is different for the reader\nNo empty section, no internal task codes left in the text\nUpgrade notes are numbered steps, or the notes say no action is needed\nNo marketing words (best, amazing, revolutionary)\nNothing but the release notes: no commentary from the writer",
          "Mỗi thay đổi là một dòng và nói điều gì khác đi với người đọc\nKhông có mục trống, không còn mã việc nội bộ trong bài\nLưu ý khi nâng cấp là các bước đánh số, hoặc ghi rõ không cần làm gì\nKhông có từ quảng cáo (tốt nhất, tuyệt vời, đột phá)\nChỉ có ghi chú phát hành: không có lời bình của người viết",
        ),
      },
      approval("approve", APPROVE),
    ],
  },

  // ── Operations ───────────────────────────────────────────────────────────────────────────────────
  {
    key: "postmortem",
    category: "operations",
    name: t("Incident postmortem: timeline → causes → write-up → check → approve", "Postmortem sự cố: diễn biến → nguyên nhân → bản viết → kiểm tra → duyệt"),
    description: t(
      "Paste the incident notes into the task. The AI writes the timeline and impact, the causes without blaming anyone, then the full postmortem with action items. It is checked, saved as a page, and the action items become subtasks.",
      "Dán ghi chú sự cố vào việc. AI viết diễn biến và ảnh hưởng, nguyên nhân mà không đổ lỗi cho ai, rồi bản postmortem đầy đủ kèm việc cần làm. Bản viết được kiểm tra, lưu thành một trang, và các việc cần làm trở thành việc con.",
    ),
    uses: {
      en: ["Paste the incident notes or the chat log into the task, with times", "Works for any incident: an outage, a missed delivery, a complaint that escalated"],
      vi: ["Dán ghi chú sự cố hoặc nội dung chat vào việc, kèm giờ", "Dùng được cho mọi sự cố: hệ thống ngừng, giao hàng trễ, khiếu nại leo thang"],
    },
    guardrails: { maxMinutes: 30 },
    output: { doc: true, subtasks: true },
    steps: [
      {
        key: "timeline",
        kind: "ai",
        model: "fast",
        role: t("An incident scribe: exact times, no interpretation.", "Người ghi chép sự cố: giờ chính xác, không diễn giải."),
        title: t("Timeline and impact", "Diễn biến và ảnh hưởng"),
        prompt: t(
          'From the incident notes in the task below, write: ## Impact (who was affected, how, for how long), ## Timeline (one line per event: time, what happened, where it is from), ## Detection (how the team found out). Use only what the task and its context say; write "(gap)" where the notes skip time. If the start time, the end time or the impact is missing, ask.\n\n{{task}}',
          'Từ ghi chú sự cố trong việc dưới đây, viết: ## Ảnh hưởng (ai bị ảnh hưởng, thế nào, trong bao lâu), ## Diễn biến (mỗi sự kiện một dòng: giờ, chuyện gì xảy ra, lấy từ đâu), ## Phát hiện (đội biết bằng cách nào). Chỉ dùng điều có trong việc và ngữ cảnh; ghi "(thiếu)" ở chỗ ghi chú bỏ qua thời gian. Nếu thiếu giờ bắt đầu, giờ kết thúc hoặc mức ảnh hưởng thì hỏi.\n\n{{task}}',
        ),
      },
      {
        key: "causes",
        kind: "ai",
        ask: false,
        role: t(
          "An incident reviewer: blameless, looks for causes in the system, not in people.",
          "Người rà soát sự cố: không đổ lỗi, tìm nguyên nhân ở hệ thống chứ không ở con người.",
        ),
        title: t("Causes", "Nguyên nhân"),
        prompt: t(
          'From the timeline below, write: ## What went wrong (the trigger, the root cause, and what made it worse or slower to find and fix), ## What went well. Name systems and steps, never people. Mark anything the timeline does not show "(assumption)".\n\n{{steps.timeline}}',
          'Từ diễn biến dưới đây, viết: ## Điều gì đã sai (tác nhân kích hoạt, nguyên nhân gốc, và điều khiến sự cố nặng hơn hoặc chậm được phát hiện, khắc phục), ## Điều gì đã tốt. Nêu hệ thống và bước làm, không nêu tên người. Đánh dấu "(giả định)" cho điều diễn biến không cho thấy.\n\n{{steps.timeline}}',
        ),
      },
      {
        key: "writeup",
        kind: "ai",
        ask: false,
        maxOutput: 4000,
        title: t("Postmortem", "Bản postmortem"),
        prompt: t(
          'Write the postmortem in Markdown from the two parts below, changing no fact in them: ## Summary (three sentences: what happened, the impact, the cause), ## Impact, ## Timeline, ## Detection, ## What went wrong, ## What went well, ## Action items as the only checkboxes in the document: "- [ ] Action (prevent, detect or recover) · Owner · Due". At least one action for each cause. Use an owner or a date only when the task gives one; otherwise write [owner] or [date] for the approver to fill in.\n\nTimeline and impact:\n{{steps.timeline}}\n\nCauses:\n{{steps.causes}}',
          'Viết bản postmortem bằng Markdown từ hai phần dưới đây, không đổi dữ kiện nào: ## Tóm tắt (ba câu: chuyện gì xảy ra, ảnh hưởng, nguyên nhân), ## Ảnh hưởng, ## Diễn biến, ## Phát hiện, ## Điều gì đã sai, ## Điều gì đã tốt, ## Việc cần làm là những ô đánh dấu duy nhất trong tài liệu: "- [ ] Việc (ngăn tái diễn, phát hiện sớm hoặc khắc phục nhanh) · Người phụ trách · Hạn". Mỗi nguyên nhân có ít nhất một việc. Chỉ ghi người phụ trách hoặc hạn khi việc có nêu; nếu không thì ghi [người phụ trách] hoặc [hạn] để người duyệt điền.\n\nDiễn biến và ảnh hưởng:\n{{steps.timeline}}\n\nNguyên nhân:\n{{steps.causes}}',
        ),
      },
      {
        key: "check",
        kind: "check",
        title: t("Blameless and complete", "Không đổ lỗi và đầy đủ"),
        criteria: t(
          "No person is named as a cause; causes are systems, tools or steps\nEvery cause under What went wrong has at least one action item\nEvery timeline line has a time or is marked as a gap\nAction items are checkbox lines; nothing else is a checkbox\nThe summary states the impact with a duration or says it is unknown",
          "Không nêu tên người nào là nguyên nhân; nguyên nhân là hệ thống, công cụ hoặc bước làm\nMỗi nguyên nhân trong Điều gì đã sai có ít nhất một việc cần làm\nMỗi dòng diễn biến có giờ hoặc được đánh dấu là thiếu\nViệc cần làm là các dòng có ô đánh dấu; không dòng nào khác có ô đánh dấu\nPhần tóm tắt nêu ảnh hưởng kèm thời lượng, hoặc nói rõ chưa biết",
        ),
      },
      approval("approve", APPROVE, "owner"),
    ],
  },
  {
    key: "sop",
    category: "operations",
    name: t("Write an SOP: notes → outline → procedure → check → approve", "Viết quy trình (SOP): ghi chú → dàn ý → quy trình → kiểm tra → duyệt"),
    description: t(
      "Turn rough notes on how something is done into a standard operating procedure a new person can follow: who does what, in which order, how to tell it went right, what to do when it does not. Saved as a page.",
      "Biến ghi chú thô về cách làm một việc thành quy trình chuẩn mà người mới làm theo được: ai làm gì, theo thứ tự nào, làm sao biết đã đúng, khi sai thì làm gì. Lưu thành một trang.",
    ),
    uses: {
      en: ["Write down how the work is done today in the task, in any order", "The process owner approves the final page"],
      vi: ["Ghi cách đang làm hiện nay vào việc, theo thứ tự nào cũng được", "Người chịu trách nhiệm quy trình duyệt trang cuối cùng"],
    },
    inputs: [
      { key: "reader", label: t("Who follows it", "Ai sẽ làm theo"), required: true, placeholder: t("e.g. a new warehouse clerk", "vd. nhân viên kho mới") },
      { key: "tools", label: t("Tools and systems used", "Công cụ và hệ thống dùng"), placeholder: t("e.g. the ERP, the shared inbox", "vd. ERP, hộp thư chung") },
    ],
    guardrails: { maxMinutes: 25 },
    output: { doc: true },
    steps: [
      {
        key: "outline",
        kind: "ai",
        role: t("An operations analyst: finds the order and the gaps in how work is really done.", "Chuyên viên vận hành: tìm ra trình tự và chỗ hổng trong cách làm thực tế."),
        title: t("Outline", "Dàn ý"),
        prompt: t(
          `From the notes in the task below, outline the process for this reader: {{input.reader}}. Write: ## Trigger (what starts it), ## Roles, ## Steps in order (one line each: who, does what, with which tool), ## Decisions (where the path splits and on what), ## Gaps (what the notes do not say). Tools: {{input.tools}}. ${ONLY.en} If the notes do not say what starts the process or when it is finished, ask.\n\n{{task}}`,
          `Từ ghi chú trong việc dưới đây, lập dàn ý quy trình cho người đọc này: {{input.reader}}. Viết: ## Khi nào bắt đầu, ## Vai trò, ## Các bước theo thứ tự (mỗi bước một dòng: ai, làm gì, bằng công cụ nào), ## Điểm quyết định (chỗ nào rẽ nhánh và dựa vào đâu), ## Chỗ hổng (điều ghi chú chưa nói). Công cụ: {{input.tools}}. ${ONLY.vi} Nếu ghi chú không nói điều gì khởi động quy trình hoặc khi nào thì xong, hãy hỏi.\n\n{{task}}`,
        ),
      },
      {
        key: "procedure",
        kind: "ai",
        ask: false,
        maxOutput: 4000,
        role: t("A technical writer for people doing the work with their hands full.", "Người viết tài liệu cho người vừa làm vừa đọc."),
        title: t("Procedure", "Quy trình"),
        prompt: t(
          "Write the SOP in Markdown from the outline below, for this reader: {{input.reader}}. Sections: ## Purpose (one sentence), ## Scope (when it applies, when it does not), ## Roles, ## Before you start (access, tools, information needed), ## Steps (numbered; each starts with a verb, names who does it, is one action, and says how to tell it worked), ## If something goes wrong (the usual problems and what to do, who to call), ## Records (what is saved, where). Keep the gaps from the outline as [to confirm: …] at the place they belong.\n\nOutline:\n{{steps.outline}}",
          "Viết SOP bằng Markdown từ dàn ý dưới đây, cho người đọc này: {{input.reader}}. Các mục: ## Mục đích (một câu), ## Phạm vi (khi nào áp dụng, khi nào không), ## Vai trò, ## Trước khi bắt đầu (quyền truy cập, công cụ, thông tin cần có), ## Các bước (đánh số; mỗi bước bắt đầu bằng động từ, nêu ai làm, chỉ một hành động, và nói làm sao biết đã đúng), ## Khi có trục trặc (các vấn đề thường gặp và cách xử lý, gọi ai), ## Lưu hồ sơ (lưu gì, ở đâu). Giữ các chỗ hổng trong dàn ý dưới dạng [cần xác nhận: …] đúng chỗ của nó.\n\nDàn ý:\n{{steps.outline}}",
        ),
      },
      {
        key: "check",
        kind: "check",
        title: t("A new person could follow it", "Người mới làm theo được"),
        criteria: t(
          "Every step starts with a verb and names who does it\nNo step contains two separate actions\nEvery step that can fail says how to tell it worked\nNo jargon or abbreviation is used without being explained once\nThe section on problems names who to contact",
          "Mỗi bước bắt đầu bằng động từ và nêu ai làm\nKhông bước nào gồm hai hành động tách biệt\nMỗi bước có thể sai đều nói làm sao biết đã đúng\nKhông dùng thuật ngữ hay chữ viết tắt mà chưa giải thích một lần\nMục xử lý trục trặc nêu rõ liên hệ ai",
        ),
      },
      approval("approve", APPROVE, "owner"),
    ],
  },

  // ── Marketing ────────────────────────────────────────────────────────────────────────────────────
  {
    key: "launch-content",
    category: "marketing",
    name: t("Launch content: facts → angle → draft → fact-check → channels", "Nội dung ra mắt: dữ kiện → góc viết → bản nháp → soát → kênh"),
    description: t(
      "The AI gathers the facts from the task, offers three angles, a person picks one, then the AI writes the announcement, corrects every claim against the facts, adds a version for each channel, and waits for approval.",
      "AI gom dữ kiện từ việc, đưa ba góc viết, người chọn một, rồi AI viết bài công bố, soát từng khẳng định với dữ kiện, thêm bản cho từng kênh, và chờ duyệt.",
    ),
    uses: {
      en: ["Put what is launching, for whom and when in the task", "Fill in the brand voice in Resources once", "When approving the angles, write which one you pick"],
      vi: ["Ghi ra mắt cái gì, cho ai, khi nào vào việc", "Điền giọng thương hiệu trong Tài nguyên một lần", "Khi duyệt góc viết, ghi rõ bạn chọn góc nào"],
    },
    inputs: [
      { key: "audience", label: t("Audience", "Đối tượng"), required: true, placeholder: t("e.g. owners of small clinics", "vd. chủ phòng khám nhỏ") },
      { key: "channels", label: t("Channels", "Kênh đăng"), default: t("Blog, LinkedIn, Email", "Blog, Facebook, Email") },
      { key: "cta", label: t("Call to action", "Lời kêu gọi hành động"), placeholder: t("e.g. book a demo", "vd. đăng ký dùng thử") },
    ],
    notes: t(
      "## Brand voice\n- We sound: [plain, warm, direct…]\n- We never say: [words and claims to avoid]\n- Product names are written: [exact spelling]\n\n## Always include\n- [e.g. link, hotline, legal line]",
      "## Giọng thương hiệu\n- Giọng của chúng ta: [giản dị, ấm áp, thẳng thắn…]\n- Không bao giờ nói: [từ và khẳng định cần tránh]\n- Tên sản phẩm viết là: [đúng chính tả]\n\n## Luôn có\n- [vd. link, hotline, dòng pháp lý]",
    ),
    guardrails: { maxMinutes: 40 },
    steps: [
      {
        key: "facts",
        kind: "ai",
        model: "fast",
        role: t("A fact gatherer: exact, writes down only what the sources say.", "Người gom dữ kiện: chính xác, chỉ ghi điều nguồn có nói."),
        title: t("Fact sheet", "Bảng dữ kiện"),
        prompt: t(
          'From the task below and its context, write a fact sheet for the launch. At most 20 facts, one per line, each with where it comes from (task, comment, document title). Cover: what launches, for whom, when, price or how to get it, what is new, proof (numbers, customers, quotes). Then "## Not ready": anything the sources say is not available yet. Add nothing the sources do not say. If what launches or when is missing, ask.\n\nAudience: {{input.audience}}\n\n{{task}}',
          'Từ việc dưới đây và ngữ cảnh của nó, viết bảng dữ kiện cho đợt ra mắt. Tối đa 20 dữ kiện, mỗi dòng một dữ kiện kèm nguồn (việc, bình luận, tên tài liệu). Bao gồm: ra mắt cái gì, cho ai, khi nào, giá hoặc cách có được, điểm mới, bằng chứng (con số, khách hàng, trích dẫn). Sau đó "## Chưa sẵn sàng": những gì nguồn nói là chưa có. Không thêm điều nguồn không nói. Nếu thiếu ra mắt cái gì hoặc khi nào thì hỏi.\n\nĐối tượng: {{input.audience}}\n\n{{task}}',
        ),
      },
      {
        key: "angles",
        kind: "ai",
        ask: false,
        role: t("A content strategist who knows this audience.", "Người hoạch định nội dung hiểu đối tượng này."),
        title: t("Three angles", "Ba góc viết"),
        prompt: t(
          "Propose three different angles for the announcement, for this audience: {{input.audience}}. For each: a name, a headline under 70 characters, the first two sentences, and which facts it leans on. Use only facts from the sheet. End with the one you recommend and why.\n\nFact sheet:\n{{steps.facts}}",
          "Đề xuất ba góc viết khác nhau cho bài công bố, cho đối tượng này: {{input.audience}}. Mỗi góc: một tên, một tiêu đề dưới 70 ký tự, hai câu mở đầu, và dựa vào dữ kiện nào. Chỉ dùng dữ kiện trong bảng. Kết thúc bằng góc bạn đề xuất và vì sao.\n\nBảng dữ kiện:\n{{steps.facts}}",
        ),
      },
      approval("pick", t("Pick an angle (note it when approving)", "Chọn góc viết (ghi chú khi duyệt)")),
      {
        key: "draft",
        kind: "ai",
        ask: false,
        role: t("A writer: plain, concrete, no hype words.", "Người viết: giản dị, cụ thể, không thổi phồng."),
        title: t("Draft", "Bản nháp"),
        prompt: t(
          "Write the announcement in Markdown from the angle the approver picked (their note is at the end of the angles; with no note, use the recommended one). At most 500 words: headline, what it is in two sentences, three short sections, how to get it, and this call to action: {{input.cta}}. Follow the brand voice in the reference material. Every claim must come from the fact sheet; no superlatives, no numbers that are not in it.\n\nAngles and the pick:\n{{previous}}\n\nFact sheet:\n{{steps.facts}}",
          "Viết bài công bố bằng Markdown theo góc viết người duyệt đã chọn (ghi chú của họ nằm cuối phần góc viết; không có ghi chú thì dùng góc được đề xuất). Tối đa 500 từ: tiêu đề, sản phẩm là gì trong hai câu, ba phần ngắn, cách có được, và lời kêu gọi hành động này: {{input.cta}}. Theo giọng thương hiệu trong tài liệu tham chiếu. Mọi khẳng định phải có trong bảng dữ kiện; không dùng từ so sánh nhất, không dùng con số không có trong bảng.\n\nGóc viết và lựa chọn:\n{{previous}}\n\nBảng dữ kiện:\n{{steps.facts}}",
        ),
      },
      {
        key: "verify",
        kind: "ai",
        ask: false,
        resources: false,
        role: t("A strict fact-checker who did not write this.", "Người soát dữ kiện khắt khe, không phải người viết bài này."),
        title: t("Fact-check", "Soát dữ kiện"),
        prompt: t(
          "Check every sentence of the announcement against the fact sheet. Fix or remove any claim the sheet does not support, any hype word, any typo. Return only the corrected announcement, complete, with nothing before or after it.\n\nAnnouncement:\n{{steps.draft}}\n\nFact sheet:\n{{steps.facts}}",
          "Đối chiếu từng câu của bài công bố với bảng dữ kiện. Sửa hoặc bỏ mọi khẳng định bảng không chứng minh được, mọi từ thổi phồng, mọi lỗi chính tả. Chỉ trả về toàn bộ bài đã sửa, không thêm gì trước hoặc sau.\n\nBài công bố:\n{{steps.draft}}\n\nBảng dữ kiện:\n{{steps.facts}}",
        ),
      },
      {
        key: "channels",
        kind: "ai",
        ask: false,
        maxOutput: 4000,
        title: t("Channel versions", "Bản cho từng kênh"),
        prompt: t(
          'Return the announcement below unchanged under "## Announcement", then add one section per channel in this list: {{input.channels}}. Each version uses only what the announcement says, fits how that channel is read (length, opening line, hashtags only where the channel uses them; an email gets a subject line under 50 characters and a preview line), and ends with the call to action: {{input.cta}}.\n\n{{steps.verify}}',
          'Giữ nguyên bài công bố dưới đây trong mục "## Bài công bố", rồi thêm mỗi kênh trong danh sách này một mục: {{input.channels}}. Mỗi bản chỉ dùng điều bài công bố nói, hợp với cách đọc của kênh đó (độ dài, câu mở đầu, hashtag chỉ khi kênh đó dùng; email có tiêu đề dưới 50 ký tự và một dòng xem trước), và kết thúc bằng lời kêu gọi hành động: {{input.cta}}.\n\n{{steps.verify}}',
        ),
      },
      {
        key: "check",
        kind: "check",
        title: t("Ready to publish", "Sẵn sàng để đăng"),
        criteria: t(
          "There is an announcement and one clearly titled version per channel\nNo superlatives or hype words (best, leading, revolutionary, amazing)\nEvery version ends with a call to action\nNo version states a number or a date that the announcement does not state\nNo placeholder text such as [missing] is left in the channel versions",
          "Có bài công bố và mỗi kênh một bản có tiêu đề rõ\nKhông có từ so sánh nhất hay thổi phồng (tốt nhất, hàng đầu, đột phá, tuyệt vời)\nMỗi bản kết thúc bằng lời kêu gọi hành động\nKhông bản nào nêu con số hay ngày mà bài công bố không nêu\nKhông còn chữ giữ chỗ như [thiếu] trong các bản theo kênh",
        ),
      },
      approval("approve", t("Final approval", "Duyệt lần cuối"), "owner"),
      TO_REVIEW,
    ],
  },
  {
    key: "content-pack",
    category: "marketing",
    name: t("Campaign content pack: brief → message → posts → voice check → approve", "Bộ nội dung chiến dịch: brief → thông điệp → bài đăng → kiểm tra giọng → duyệt"),
    description: t(
      "From a campaign brief, the AI fixes the message (one idea, three proof points, what not to say), writes the posts for each channel in the brand's voice, checks them, and waits for approval.",
      "Từ brief chiến dịch, AI chốt thông điệp (một ý chính, ba điểm chứng minh, điều không nói), viết bài cho từng kênh theo giọng thương hiệu, kiểm tra, và chờ duyệt.",
    ),
    uses: {
      en: [
        "Put the campaign brief in the task: offer, dates, anything that must be said",
        "Fill in the brand voice in Resources once; attach the brand guide there if you have one",
      ],
      vi: ["Ghi brief chiến dịch vào việc: ưu đãi, ngày, điều bắt buộc phải nói", "Điền giọng thương hiệu trong Tài nguyên một lần; đính kèm brand guide ở đó nếu có"],
    },
    inputs: [
      { key: "goal", label: t("Goal of the campaign", "Mục tiêu chiến dịch"), required: true, placeholder: t("e.g. 200 sign-ups for the webinar", "vd. 200 lượt đăng ký webinar") },
      { key: "audience", label: t("Audience", "Đối tượng"), required: true },
      { key: "channels", label: t("Channels", "Kênh đăng"), default: t("LinkedIn, Facebook, Email", "Facebook, Zalo, Email") },
      { key: "posts", label: t("Posts per channel", "Số bài mỗi kênh"), type: "number", default: t("3", "3") },
    ],
    notes: t(
      "## Brand voice\n- We sound: [plain, warm, direct…]\n- We never say: [words and claims to avoid]\n- Emoji: [never / sparingly / freely]\n- Hashtags we use: [#…]\n\n## Always include\n- [e.g. link, hotline, legal line]",
      "## Giọng thương hiệu\n- Giọng của chúng ta: [giản dị, ấm áp, thẳng thắn…]\n- Không bao giờ nói: [từ và khẳng định cần tránh]\n- Emoji: [không dùng / dùng ít / thoải mái]\n- Hashtag hay dùng: [#…]\n\n## Luôn có\n- [vd. link, hotline, dòng pháp lý]",
    ),
    guardrails: { maxMinutes: 30 },
    steps: [
      {
        key: "message",
        kind: "ai",
        model: "fast",
        role: t("A campaign strategist: one idea, said clearly.", "Người hoạch định chiến dịch: một ý, nói cho rõ."),
        title: t("Message", "Thông điệp"),
        prompt: t(
          `From the brief in the task below, write the message for this campaign. Goal: {{input.goal}}. Audience: {{input.audience}}. Sections: ## One idea (one sentence the audience should remember), ## Proof (three points, each from the brief), ## Offer and dates, ## Call to action (one), ## Do not say (from the brand voice and the brief). ${ONLY.en} If the offer or the dates are missing, ask.\n\n{{task}}`,
          `Từ brief trong việc dưới đây, viết thông điệp cho chiến dịch. Mục tiêu: {{input.goal}}. Đối tượng: {{input.audience}}. Các mục: ## Một ý chính (một câu người đọc cần nhớ), ## Chứng minh (ba điểm, mỗi điểm lấy từ brief), ## Ưu đãi và ngày, ## Lời kêu gọi hành động (một), ## Không nói (theo giọng thương hiệu và brief). ${ONLY.vi} Nếu thiếu ưu đãi hoặc ngày thì hỏi.\n\n{{task}}`,
        ),
      },
      {
        key: "posts",
        kind: "ai",
        ask: false,
        maxOutput: 4000,
        role: t("A social media writer who writes the way this audience talks.", "Người viết mạng xã hội, viết theo cách đối tượng này nói chuyện."),
        title: t("Posts", "Bài đăng"),
        prompt: t(
          "Write the content pack in Markdown: for each channel in this list, {{input.channels}}, a section with {{input.posts}} posts, numbered. Each post opens differently (a question, a number, a short story, an objection), carries the one idea and one proof point, fits how the channel is read, and ends with the call to action. An email is a subject line under 50 characters, a preview line and a body under 150 words. Follow the brand voice in the reference material; say nothing from the Do not say list; use only facts in the message.\n\nMessage:\n{{steps.message}}",
          "Viết bộ nội dung bằng Markdown: mỗi kênh trong danh sách này, {{input.channels}}, một mục gồm {{input.posts}} bài, có đánh số. Mỗi bài mở đầu một kiểu khác nhau (một câu hỏi, một con số, một câu chuyện ngắn, một lời phản biện), mang ý chính và một điểm chứng minh, hợp với cách đọc của kênh, và kết thúc bằng lời kêu gọi hành động. Email gồm tiêu đề dưới 50 ký tự, một dòng xem trước và phần thân dưới 150 từ. Theo giọng thương hiệu trong tài liệu tham chiếu; không nói điều nào trong danh sách Không nói; chỉ dùng dữ kiện trong thông điệp.\n\nThông điệp:\n{{steps.message}}",
        ),
      },
      {
        key: "voice",
        kind: "check",
        title: t("Voice and message", "Giọng và thông điệp"),
        criteria: t(
          "Every channel has its own section with numbered posts\nEvery post ends with one call to action, the same one throughout\nNo two posts on a channel open the same way\nNo superlatives or hype words (best, number one, amazing, revolutionary)\nNo post states a price, a date or a number that differs from another post",
          "Mỗi kênh có mục riêng với các bài được đánh số\nMỗi bài kết thúc bằng một lời kêu gọi hành động, thống nhất trong cả bộ\nKhông có hai bài cùng kênh mở đầu giống nhau\nKhông có từ so sánh nhất hay thổi phồng (tốt nhất, số một, tuyệt vời, đột phá)\nKhông bài nào nêu giá, ngày hay con số khác với bài khác",
        ),
      },
      approval("approve", APPROVE),
    ],
  },
  {
    key: "seo-article",
    category: "marketing",
    name: t("SEO article: outline → approve → article → check → approve", "Bài viết SEO: dàn ý → duyệt → bài viết → kiểm tra → duyệt"),
    description: t(
      "For one keyword, the AI works out what the searcher wants and proposes an outline, a person approves it, and the AI writes the article with title, meta description and headings. It is checked and saved as a page.",
      "Với một từ khoá, AI xác định người tìm muốn gì và đề xuất dàn ý, người duyệt dàn ý, rồi AI viết bài kèm tiêu đề, mô tả meta và các đề mục. Bài được kiểm tra và lưu thành một trang.",
    ),
    uses: {
      en: ["Put what the company knows about the topic in the task: facts, examples, numbers", "The AI writes from what you give it; it does not invent statistics"],
      vi: ["Ghi những gì công ty biết về chủ đề vào việc: dữ kiện, ví dụ, con số", "AI viết từ những gì bạn đưa; nó không bịa số liệu"],
    },
    inputs: [
      { key: "keyword", label: t("Main keyword", "Từ khoá chính"), required: true },
      { key: "reader", label: t("Reader", "Người đọc"), placeholder: t("e.g. a first-time buyer comparing options", "vd. người mua lần đầu đang so sánh") },
      {
        key: "length",
        label: t("Length", "Độ dài"),
        type: "choice",
        options: { en: ["About 800 words", "About 1,200 words", "About 1,800 words"], vi: ["Khoảng 800 từ", "Khoảng 1.200 từ", "Khoảng 1.800 từ"] },
        default: t("About 1,200 words", "Khoảng 1.200 từ"),
      },
    ],
    guardrails: { maxMinutes: 30 },
    output: { doc: true },
    steps: [
      {
        key: "outline",
        kind: "ai",
        role: t("An SEO editor: starts from what the searcher wants to get done.", "Biên tập viên SEO: bắt đầu từ điều người tìm muốn làm được."),
        title: t("Outline", "Dàn ý"),
        prompt: t(
          `Plan an article for the keyword "{{input.keyword}}", for this reader: {{input.reader}}. Write: ## Search intent (what the person wants, in one sentence), ## Title options (three, under 60 characters, keyword near the start), ## Outline (H2 and H3 headings, one line each on what the section answers), ## Questions to answer (five the reader would ask), ## Facts we have (from the task and the reference, each usable in the article), ## Facts we lack. ${ONLY.en} If the task gives nothing about the topic beyond the keyword, ask what the company wants to say.\n\n{{task}}`,
          `Lập kế hoạch bài viết cho từ khoá "{{input.keyword}}", cho người đọc này: {{input.reader}}. Viết: ## Ý định tìm kiếm (người tìm muốn gì, trong một câu), ## Phương án tiêu đề (ba tiêu đề, dưới 60 ký tự, từ khoá gần đầu), ## Dàn ý (các đề mục H2 và H3, mỗi mục một dòng nói phần đó trả lời điều gì), ## Câu hỏi cần trả lời (năm câu người đọc sẽ hỏi), ## Dữ kiện đang có (từ việc và tài liệu tham chiếu, dùng được trong bài), ## Dữ kiện còn thiếu. ${ONLY.vi} Nếu việc không có gì về chủ đề ngoài từ khoá, hãy hỏi công ty muốn nói điều gì.\n\n{{task}}`,
        ),
      },
      approval("approve-outline", t("Approve the outline", "Duyệt dàn ý")),
      {
        key: "article",
        kind: "ai",
        ask: false,
        maxOutput: 6000,
        role: t("A writer who explains to one person, not to a search engine.", "Người viết giải thích cho một người, không phải cho máy tìm kiếm."),
        title: t("Article", "Bài viết"),
        prompt: t(
          'Write the article in Markdown from the approved outline (the approver\'s note, if any, is at its end and comes first). Length: {{input.length}}. Start with "Title:" (the chosen or first title option) and "Meta description:" (under 155 characters, with the keyword), then the article: the keyword "{{input.keyword}}" in the first 100 words and in at least one H2, short paragraphs, an answer in the first lines of each section, a short FAQ from the questions, and a closing section that says what to do next. Use only the facts listed as available; never invent a statistic, a quote or a source.\n\nOutline:\n{{previous}}',
          'Viết bài bằng Markdown theo dàn ý đã duyệt (ghi chú của người duyệt, nếu có, nằm ở cuối và được ưu tiên). Độ dài: {{input.length}}. Bắt đầu bằng "Tiêu đề:" (tiêu đề được chọn hoặc phương án đầu tiên) và "Mô tả meta:" (dưới 155 ký tự, có từ khoá), rồi đến bài: từ khoá "{{input.keyword}}" xuất hiện trong 100 từ đầu và ít nhất một H2, đoạn văn ngắn, mỗi phần trả lời ngay ở những dòng đầu, một phần FAQ ngắn từ các câu hỏi, và phần kết nói người đọc nên làm gì tiếp. Chỉ dùng các dữ kiện đang có; không bịa số liệu, trích dẫn hay nguồn.\n\nDàn ý:\n{{previous}}',
        ),
      },
      {
        key: "check",
        kind: "check",
        title: t("SEO basics and honesty", "SEO cơ bản và trung thực"),
        criteria: t(
          "Starts with a title under 60 characters and a meta description under 155 characters\nThe main keyword of the title appears in the first paragraph and in at least one H2 heading\nHeadings are H2 and H3 in a sensible order, none skipped\nNo statistic or quote appears without saying where it is from\nEnds with a section telling the reader what to do next",
          "Bắt đầu bằng tiêu đề dưới 60 ký tự và mô tả meta dưới 155 ký tự\nTừ khoá chính của tiêu đề xuất hiện trong đoạn đầu và ít nhất một đề mục H2\nCác đề mục là H2 và H3 theo thứ tự hợp lý, không nhảy cấp\nKhông có số liệu hay trích dẫn nào thiếu nguồn\nKết thúc bằng phần nói người đọc nên làm gì tiếp",
        ),
      },
      approval("approve", APPROVE),
    ],
  },

  // ── Sales ────────────────────────────────────────────────────────────────────────────────────────
  {
    key: "proposal",
    category: "sales",
    name: t("Proposal: needs → proposal → price check → approve", "Đề xuất báo giá: nhu cầu → đề xuất → soát giá → duyệt"),
    description: t(
      "From the customer's brief, the AI states what they need, writes the proposal with scope, timeline and a quote taken only from your price list, rechecks every price and total, and waits for the owner's approval. Saved as a page.",
      "Từ yêu cầu của khách, AI nêu nhu cầu, viết đề xuất gồm phạm vi, tiến độ và báo giá chỉ lấy từ bảng giá của công ty, soát lại từng mức giá và tổng, rồi chờ người phụ trách duyệt. Lưu thành một trang.",
    ),
    uses: {
      en: [
        "Put your price list and terms in Resources (as notes or a file) once",
        "Put the customer's request in the task, as they wrote it",
        "An item that is not in the price list is marked [price needed], never guessed",
      ],
      vi: [
        "Đưa bảng giá và điều khoản vào Tài nguyên (ghi chú hoặc file) một lần",
        "Dán yêu cầu của khách vào việc, đúng như họ viết",
        "Hạng mục không có trong bảng giá được đánh dấu [cần giá], không đoán",
      ],
    },
    inputs: [
      { key: "customer", label: t("Customer", "Khách hàng"), required: true },
      { key: "budget", label: t("Their budget, if known", "Ngân sách của khách, nếu biết") },
      { key: "valid", label: t("Quote valid until", "Báo giá có hiệu lực đến"), type: "date" },
    ],
    notes: t(
      "## Price list\n| Item | Unit | Price |\n|---|---|---|\n| [item] | [unit] | [price] |\n\n## Terms\n- Payment: [e.g. 50% on signing, 50% on delivery]\n- Discounts allowed: [e.g. up to 10% above …, by the sales lead only]\n- Taxes: [VAT …]\n\n## About us (two sentences for the proposal)\n[…]",
      "## Bảng giá\n| Hạng mục | Đơn vị | Đơn giá |\n|---|---|---|\n| [hạng mục] | [đơn vị] | [giá] |\n\n## Điều khoản\n- Thanh toán: [vd. 50% khi ký, 50% khi bàn giao]\n- Chiết khấu được phép: [vd. tối đa 10% cho đơn trên …, chỉ trưởng nhóm kinh doanh quyết]\n- Thuế: [VAT …]\n\n## Giới thiệu công ty (hai câu cho đề xuất)\n[…]",
    ),
    guardrails: { maxMinutes: 30 },
    output: { doc: true },
    steps: [
      {
        key: "needs",
        kind: "ai",
        model: "fast",
        role: t("A sales engineer: listens first, restates what the customer asked for.", "Kỹ sư bán hàng: nghe trước, diễn đạt lại điều khách yêu cầu."),
        title: t("Understand the need", "Hiểu nhu cầu"),
        prompt: t(
          `From the customer's request in the task below, for {{input.customer}}, write: ## What they need (in their words), ## Scope (items and quantities), ## Timeline they expect, ## Budget ({{input.budget}}), ## Assumptions we are making, ## Missing. ${ONLY.en} If quantities or the delivery date are missing and cannot be assumed, ask.\n\n{{task}}`,
          `Từ yêu cầu của khách trong việc dưới đây, cho {{input.customer}}, viết: ## Khách cần gì (theo lời của họ), ## Phạm vi (hạng mục và số lượng), ## Tiến độ họ mong đợi, ## Ngân sách ({{input.budget}}), ## Giả định của chúng ta, ## Còn thiếu. ${ONLY.vi} Nếu thiếu số lượng hoặc ngày giao mà không thể giả định thì hỏi.\n\n{{task}}`,
        ),
      },
      {
        key: "draft",
        kind: "ai",
        ask: false,
        maxOutput: 4000,
        role: t("An account manager writing to a decision maker: clear, specific, no filler.", "Người quản lý khách hàng viết cho người ra quyết định: rõ, cụ thể, không rườm rà."),
        title: t("Write the proposal", "Viết đề xuất"),
        prompt: t(
          'Write the proposal for {{input.customer}} in Markdown: ## Summary (their need and what we propose, three sentences), ## What you get (scope, item by item), ## Timeline, ## Quote (a table: item, quantity, unit, unit price, line total; then subtotal, discount if any, tax, total), ## Terms (payment, validity until {{input.valid}}), ## Assumptions, ## Next step. Every unit price must be copied from the price list in the reference material; for an item that is not in the list write "[price needed]" and leave it out of the totals. Apply a discount only if the terms in the reference allow it. Compute every line total and the total.\n\nThe need:\n{{steps.needs}}',
          'Viết đề xuất cho {{input.customer}} bằng Markdown: ## Tóm tắt (nhu cầu của khách và điều chúng ta đề xuất, ba câu), ## Khách nhận được gì (phạm vi, từng hạng mục), ## Tiến độ, ## Báo giá (bảng: hạng mục, số lượng, đơn vị, đơn giá, thành tiền; sau đó tạm tính, chiết khấu nếu có, thuế, tổng cộng), ## Điều khoản (thanh toán, hiệu lực đến {{input.valid}}), ## Giả định, ## Bước tiếp theo. Mọi đơn giá phải chép từ bảng giá trong tài liệu tham chiếu; hạng mục không có trong bảng thì ghi "[cần giá]" và không tính vào tổng. Chỉ áp dụng chiết khấu khi điều khoản trong tài liệu tham chiếu cho phép. Tính từng dòng thành tiền và tổng cộng.\n\nNhu cầu:\n{{steps.needs}}',
        ),
      },
      {
        key: "prices",
        kind: "ai",
        ask: false,
        maxOutput: 4000,
        role: t("A finance controller rechecking a quote before it leaves the company.", "Kiểm soát tài chính soát lại báo giá trước khi gửi khách."),
        title: t("Recheck prices and totals", "Soát giá và tổng"),
        prompt: t(
          'Recheck the quote in the proposal below against the price list and terms in the reference material: each unit price equals the list price (otherwise correct it, or write "[price needed]" if the item is not in the list), each line total equals quantity × unit price, the subtotal, discount, tax and total add up, and the discount is one the terms allow. Return only the corrected proposal, complete, with nothing before or after it.\n\n{{steps.draft}}',
          'Soát lại báo giá trong đề xuất dưới đây theo bảng giá và điều khoản trong tài liệu tham chiếu: mỗi đơn giá bằng giá trong bảng (nếu không thì sửa, hoặc ghi "[cần giá]" nếu hạng mục không có trong bảng), mỗi dòng thành tiền bằng số lượng × đơn giá, tạm tính, chiết khấu, thuế và tổng cộng khớp nhau, và chiết khấu nằm trong mức điều khoản cho phép. Chỉ trả về toàn bộ đề xuất đã sửa, không thêm gì trước hoặc sau.\n\n{{steps.draft}}',
        ),
      },
      {
        key: "check",
        kind: "check",
        title: t("Ready to send", "Sẵn sàng gửi khách"),
        criteria: t(
          "Has a quote table with quantity, unit price and line total for every item\nEvery line total equals quantity times unit price, and the total equals the sum after discount and tax\nStates payment terms and a validity date, or marks them as needed\nNames one clear next step for the customer\nNo internal note, cost or margin appears in the text",
          "Có bảng báo giá với số lượng, đơn giá và thành tiền cho từng hạng mục\nMỗi dòng thành tiền bằng số lượng nhân đơn giá, và tổng cộng bằng tổng sau chiết khấu và thuế\nNêu điều khoản thanh toán và ngày hiệu lực, hoặc đánh dấu là cần bổ sung\nNêu một bước tiếp theo rõ ràng cho khách\nKhông có ghi chú nội bộ, giá vốn hay biên lợi nhuận trong bài",
        ),
      },
      approval("approve", t("Approve before sending", "Duyệt trước khi gửi"), "owner"),
    ],
  },
  {
    key: "account-research",
    category: "sales",
    name: t("Call prep: account profile → call plan → check", "Chuẩn bị cuộc gọi: hồ sơ khách → kế hoạch gọi → kiểm tra"),
    description: t(
      "Before a meeting, the AI gathers what the workspace and your connected tools know about the account, marks every fact with its source, and writes a one-page call plan: likely pains, questions to ask, objections and the next step to aim for.",
      "Trước cuộc gặp, AI gom những gì workspace và các công cụ đã kết nối biết về khách hàng, ghi nguồn cho từng dữ kiện, và viết kế hoạch gọi một trang: vấn đề khách có thể gặp, câu hỏi cần hỏi, phản đối và bước tiếp theo cần đạt.",
    ),
    uses: {
      en: [
        "Paste what you know into the task: emails, notes from the last call, the company's website text",
        "With a CRM or web search connected in Admin › AI connections, the AI looks there too",
      ],
      vi: [
        "Dán những gì bạn biết vào việc: email, ghi chú cuộc gọi trước, nội dung trang web của khách",
        "Nếu đã kết nối CRM hoặc tìm kiếm web trong Admin › Kết nối AI, AI sẽ tra thêm ở đó",
      ],
    },
    inputs: [
      { key: "company", label: t("Company", "Công ty"), required: true },
      { key: "contact", label: t("Who you are meeting", "Bạn sẽ gặp ai"), placeholder: t("name and role", "tên và chức vụ") },
      { key: "goal", label: t("Goal of the meeting", "Mục tiêu cuộc gặp"), placeholder: t("e.g. agree on a pilot", "vd. chốt chạy thử") },
    ],
    notes: t(
      "## What we sell\n[products, who they are for, the problems they solve]\n\n## Our usual objections and answers\n- [objection]: [answer]",
      "## Chúng ta bán gì\n[sản phẩm, dành cho ai, giải quyết vấn đề gì]\n\n## Các phản đối thường gặp và cách trả lời\n- [phản đối]: [trả lời]",
    ),
    guardrails: { maxMinutes: 20, ask: "never" },
    steps: [
      {
        key: "profile",
        kind: "ai",
        role: t("A sales researcher: every fact has a source, unknown stays unknown.", "Người nghiên cứu khách hàng: mỗi dữ kiện có nguồn, chưa biết thì ghi chưa biết."),
        title: t("Account profile", "Hồ sơ khách hàng"),
        prompt: t(
          'Build a profile of {{input.company}} for a meeting with {{input.contact}}. Use the task below, its context and the tools you have; never use what you only believe. Write: ## Company (what they do, size, market), ## People (who we know there, their role), ## History with us (past tasks, deals, complaints), ## What changed lately, ## Unknown. After every fact write its source in brackets (task, comment, document title, tool, link). If you know nothing for a section, write "Unknown".\n\n{{task}}',
          'Lập hồ sơ về {{input.company}} cho cuộc gặp với {{input.contact}}. Dùng việc dưới đây, ngữ cảnh của nó và các công cụ bạn có; không dùng điều bạn chỉ tin là đúng. Viết: ## Công ty (làm gì, quy mô, thị trường), ## Con người (ta biết ai ở đó, vai trò của họ), ## Lịch sử với chúng ta (việc, hợp đồng, khiếu nại trước đây), ## Gần đây có gì thay đổi, ## Chưa biết. Sau mỗi dữ kiện ghi nguồn trong ngoặc vuông (việc, bình luận, tên tài liệu, công cụ, link). Mục nào không biết gì thì ghi "Chưa biết".\n\n{{task}}',
        ),
      },
      {
        key: "plan",
        kind: "ai",
        role: t("A sales coach preparing a rep for one specific meeting.", "Huấn luyện viên bán hàng chuẩn bị cho một cuộc gặp cụ thể."),
        title: t("Call plan", "Kế hoạch cuộc gọi"),
        prompt: t(
          "Write a one-page call plan in Markdown for the meeting with {{input.contact}} at {{input.company}}. Goal: {{input.goal}}. Sections: ## In one line (who they are and why now), ## What we know (five facts at most, with their sources), ## Likely pains (three, each marked as a hypothesis and tied to a fact), ## Questions to ask (five open questions, most important first), ## Objections to expect (each with a short answer, from the reference where it has one), ## Next step to ask for, ## Still unknown (what to find out in the call).\n\nProfile:\n{{steps.profile}}",
          "Viết kế hoạch cuộc gọi một trang bằng Markdown cho cuộc gặp với {{input.contact}} tại {{input.company}}. Mục tiêu: {{input.goal}}. Các mục: ## Một dòng (họ là ai và vì sao là lúc này), ## Điều đã biết (tối đa năm dữ kiện, kèm nguồn), ## Vấn đề có thể gặp (ba vấn đề, mỗi cái ghi rõ là giả thuyết và gắn với một dữ kiện), ## Câu hỏi cần hỏi (năm câu hỏi mở, quan trọng nhất trước), ## Phản đối có thể gặp (mỗi cái kèm câu trả lời ngắn, lấy từ tài liệu tham chiếu nếu có), ## Bước tiếp theo cần đề nghị, ## Còn chưa biết (điều cần tìm hiểu trong cuộc gọi).\n\nHồ sơ:\n{{steps.profile}}",
        ),
      },
      {
        key: "check",
        kind: "check",
        model: "fast",
        attempts: 1,
        onFail: "continue",
        title: t("Facts have sources", "Dữ kiện có nguồn"),
        criteria: t(
          "Every fact under What we know has a source in brackets\nEvery pain is marked as a hypothesis\nThe questions are open questions, not yes or no\nThere is exactly one next step to ask for\nFits on one page: under 450 words",
          "Mỗi dữ kiện trong Điều đã biết có nguồn trong ngoặc vuông\nMỗi vấn đề được ghi rõ là giả thuyết\nCác câu hỏi là câu hỏi mở, không phải có hoặc không\nCó đúng một bước tiếp theo cần đề nghị\nVừa một trang: dưới 450 từ",
        ),
      },
    ],
  },

  // ── Customer support ─────────────────────────────────────────────────────────────────────────────
  {
    key: "support-reply",
    category: "support",
    name: t("Customer reply: understand → draft → policy check → approve", "Trả lời khách: hiểu → soạn → soát chính sách → duyệt"),
    description: t(
      "The AI works out what the customer is asking and which policy applies, drafts the reply in your tone, and a check stops any promise your policy does not allow before the agent approves and sends it.",
      "AI xác định khách đang hỏi gì và chính sách nào áp dụng, soạn câu trả lời theo giọng của công ty, và bước kiểm tra chặn mọi lời hứa chính sách không cho phép trước khi nhân viên duyệt và gửi.",
    ),
    uses: {
      en: [
        "Paste the customer's message into the task",
        "Put your policies (refunds, warranty, delivery) in Resources once",
        "The reply is posted on the task; the agent copies it to the customer",
      ],
      vi: [
        "Dán tin nhắn của khách vào việc",
        "Đưa chính sách (hoàn tiền, bảo hành, giao hàng) vào Tài nguyên một lần",
        "Câu trả lời được đăng lên việc; nhân viên chép gửi cho khách",
      ],
    },
    inputs: [
      {
        key: "channel",
        label: t("Channel", "Kênh"),
        type: "choice",
        options: { en: ["Email", "Chat", "Social media"], vi: ["Email", "Chat", "Mạng xã hội"] },
        default: t("Email", "Email"),
      },
      {
        key: "tone",
        label: t("Tone", "Giọng"),
        type: "choice",
        options: { en: ["Warm", "Neutral", "Formal"], vi: ["Thân thiện", "Trung tính", "Trang trọng"] },
        default: t("Warm", "Thân thiện"),
      },
      { key: "decision", label: t("What we decided, if anything", "Điều đã quyết, nếu có"), placeholder: t("e.g. refund approved", "vd. đồng ý hoàn tiền") },
    ],
    notes: t(
      "## Policies\n- Refunds: [when, how long it takes]\n- Warranty: [what is covered, for how long]\n- Delivery: [times, who to contact]\n\n## We never promise\n- [e.g. exact delivery dates, compensation without a lead's approval]\n\n## Sign-off\n[how replies are signed]",
      "## Chính sách\n- Hoàn tiền: [khi nào, mất bao lâu]\n- Bảo hành: [bảo hành gì, trong bao lâu]\n- Giao hàng: [thời gian, liên hệ ai]\n\n## Không bao giờ hứa\n- [vd. ngày giao chính xác, bồi thường khi chưa có trưởng nhóm duyệt]\n\n## Lời chào cuối\n[cách ký tên trong câu trả lời]",
    ),
    guardrails: { maxMinutes: 15, stepMinutes: 5 },
    steps: [
      {
        key: "understand",
        kind: "ai",
        model: "fast",
        role: t(
          "A senior support agent: reads what the customer means, not only what they wrote.",
          "Nhân viên hỗ trợ lâu năm: đọc ra điều khách muốn nói, không chỉ điều họ viết.",
        ),
        title: t("Understand", "Hiểu yêu cầu"),
        prompt: t(
          `From the customer's message in the task below, write: ## They ask (each question or request on its own line), ## How they feel, ## Facts given (order, product, dates), ## Policy that applies (quote the line from the reference material, or "No policy found"), ## What we can offer, ## Missing. ${ONLY.en} Decision already made: {{input.decision}}. If the reply depends on a decision nobody has made (a refund, an exception), ask for it.\n\n{{task}}`,
          `Từ tin nhắn của khách trong việc dưới đây, viết: ## Khách hỏi gì (mỗi câu hỏi hoặc yêu cầu một dòng), ## Cảm xúc của khách, ## Dữ kiện đã có (đơn hàng, sản phẩm, ngày), ## Chính sách áp dụng (trích đúng dòng trong tài liệu tham chiếu, hoặc "Không thấy chính sách"), ## Ta có thể đề nghị gì, ## Còn thiếu. ${ONLY.vi} Điều đã quyết: {{input.decision}}. Nếu câu trả lời phụ thuộc vào một quyết định chưa ai đưa ra (hoàn tiền, ngoại lệ) thì hỏi.\n\n{{task}}`,
        ),
      },
      {
        key: "draft",
        kind: "ai",
        ask: false,
        title: t("Draft the reply", "Soạn câu trả lời"),
        prompt: t(
          "Write the reply to the customer, ready to send, for this channel: {{input.channel}}, in this tone: {{input.tone}}. Answer every question in the analysis, in the customer's language. Acknowledge the problem once, say what happens next and when only as far as the policy allows, and what the customer needs to do, if anything. Promise nothing that is under “We never promise” in the reference material. An email is under 150 words with a subject line; a chat or social reply is under 60 words with no subject. Sign off as the reference says. Return only the reply.\n\nAnalysis:\n{{steps.understand}}",
          "Viết câu trả lời cho khách, sẵn sàng để gửi, cho kênh này: {{input.channel}}, với giọng này: {{input.tone}}. Trả lời mọi câu hỏi trong phần phân tích, bằng ngôn ngữ của khách. Ghi nhận vấn đề một lần, nói điều gì sẽ xảy ra tiếp theo và khi nào trong phạm vi chính sách cho phép, và khách cần làm gì, nếu có. Không hứa điều nào thuộc mục “Không bao giờ hứa” trong tài liệu tham chiếu. Email dưới 150 từ và có tiêu đề; chat hoặc mạng xã hội dưới 60 từ và không có tiêu đề. Ký tên theo tài liệu tham chiếu. Chỉ trả về câu trả lời.\n\nPhân tích:\n{{steps.understand}}",
        ),
      },
      {
        key: "policy",
        kind: "check",
        model: "fast",
        title: t("Policy and tone", "Chính sách và giọng"),
        criteria: t(
          "Promises no refund, compensation, replacement or exact date unless it says this was decided or is policy\nApologizes at most once and does not blame the customer\nTells the customer what happens next\nContains no internal information: no staff names beyond the sign-off, no system names, no notes to self\nContains only the reply, ready to send",
          "Không hứa hoàn tiền, bồi thường, đổi hàng hay ngày chính xác, trừ khi nói rõ điều đó đã được quyết hoặc là chính sách\nXin lỗi nhiều nhất một lần và không đổ lỗi cho khách\nCho khách biết điều gì sẽ xảy ra tiếp theo\nKhông có thông tin nội bộ: không tên nhân viên ngoài phần ký tên, không tên hệ thống, không ghi chú cho bản thân\nChỉ gồm câu trả lời, sẵn sàng để gửi",
        ),
      },
      approval("approve", t("Approve and send", "Duyệt và gửi"), "assignee"),
    ],
  },
  {
    key: "faq-from-tickets",
    category: "support",
    name: t("FAQ from tickets: group → write → check → approve", "FAQ từ ticket: gom nhóm → viết → kiểm tra → duyệt"),
    description: t(
      "Paste a batch of customer questions. The AI groups them by what people actually ask, counts them, and writes the FAQ with answers taken only from your policies and from replies already given. Saved as a page.",
      "Dán một loạt câu hỏi của khách. AI gom theo điều khách thật sự hỏi, đếm số lần, và viết FAQ với câu trả lời chỉ lấy từ chính sách và các câu trả lời đã gửi. Lưu thành một trang.",
    ),
    uses: {
      en: [
        "Paste the tickets or chat excerpts into the task and into the Tickets field (about 8,000 characters each)",
        "Put your policies in Resources; a question with no known answer is marked [answer needed]",
      ],
      vi: [
        "Dán ticket hoặc đoạn chat vào việc và vào ô Ticket (mỗi nơi khoảng 8.000 ký tự)",
        "Đưa chính sách vào Tài nguyên; câu hỏi chưa có câu trả lời được đánh dấu [cần câu trả lời]",
      ],
    },
    inputs: [
      {
        key: "tickets",
        label: t("Tickets", "Ticket"),
        type: "long",
        placeholder: t("Paste customer questions and the replies given", "Dán câu hỏi của khách và câu trả lời đã gửi"),
      },
      { key: "product", label: t("Product or topic", "Sản phẩm hoặc chủ đề") },
    ],
    guardrails: { maxMinutes: 25, ask: "never" },
    output: { doc: true },
    steps: [
      {
        key: "groups",
        kind: "ai",
        role: t("A support analyst: counts what customers ask, in their words.", "Chuyên viên phân tích hỗ trợ: đếm điều khách hỏi, theo lời của họ."),
        title: t("Group the questions", "Gom nhóm câu hỏi"),
        prompt: t(
          "Read the customer messages below about {{input.product}}. Group them by what the customer wants to know. For each group, most frequent first: the question in the customer's words, how many messages ask it, one short quote, and the answer already given in a reply if there is one (quote it). Do not answer anything yourself yet.\n\nTickets:\n{{input.tickets}}\n\n{{task}}",
          "Đọc các tin nhắn của khách dưới đây về {{input.product}}. Gom theo điều khách muốn biết. Với mỗi nhóm, nhiều nhất trước: câu hỏi theo lời của khách, bao nhiêu tin hỏi điều đó, một trích dẫn ngắn, và câu trả lời đã gửi nếu có (trích lại). Chưa tự trả lời gì.\n\nTicket:\n{{input.tickets}}\n\n{{task}}",
        ),
      },
      {
        key: "faq",
        kind: "ai",
        maxOutput: 4000,
        role: t("A help-centre writer: short answers a customer can act on.", "Người viết trung tâm trợ giúp: câu trả lời ngắn, khách làm theo được."),
        title: t("Write the FAQ", "Viết FAQ"),
        prompt: t(
          'Write the FAQ in Markdown from the groups below: the ten most asked questions at most, grouped under two to four topic headings. Each entry: the question as a customer would ask it (### heading), then an answer under 80 words that starts with the answer itself and gives steps as a numbered list. Take each answer only from the reference material or from a reply quoted in the groups; when neither has it, write "[answer needed]" and keep the question. End with "## Asked but not covered": the remaining groups with their counts.\n\nGroups:\n{{steps.groups}}',
          'Viết FAQ bằng Markdown từ các nhóm dưới đây: tối đa mười câu được hỏi nhiều nhất, xếp dưới hai đến bốn đề mục chủ đề. Mỗi mục: câu hỏi theo cách khách sẽ hỏi (đề mục ###), rồi câu trả lời dưới 80 từ, mở đầu bằng chính câu trả lời và trình bày các bước bằng danh sách đánh số. Chỉ lấy câu trả lời từ tài liệu tham chiếu hoặc từ câu trả lời đã trích trong các nhóm; khi cả hai đều không có thì ghi "[cần câu trả lời]" và giữ câu hỏi. Kết thúc bằng "## Có hỏi nhưng chưa đưa vào": các nhóm còn lại kèm số lần.\n\nCác nhóm:\n{{steps.groups}}',
        ),
      },
      {
        key: "check",
        kind: "check",
        title: t("Answers are usable", "Câu trả lời dùng được"),
        criteria: t(
          "Every question is written the way a customer would ask it\nEvery answer starts with the answer, not with background\nSteps are numbered lists\nNo answer promises something with words like always or guaranteed\nQuestions without a known answer are marked [answer needed], not answered vaguely",
          "Mỗi câu hỏi được viết theo cách khách sẽ hỏi\nMỗi câu trả lời mở đầu bằng chính câu trả lời, không phải bối cảnh\nCác bước là danh sách đánh số\nKhông câu trả lời nào hứa bằng những từ như luôn luôn hay đảm bảo\nCâu hỏi chưa có câu trả lời được đánh dấu [cần câu trả lời], không trả lời chung chung",
        ),
      },
      approval("approve", APPROVE),
    ],
  },

  // ── People & HR ──────────────────────────────────────────────────────────────────────────────────
  {
    key: "job-post",
    category: "hr",
    name: t("Job post and interview kit: role → post → fairness check → approve", "Tin tuyển dụng và bộ phỏng vấn: vị trí → tin đăng → soát công bằng → duyệt"),
    description: t(
      "From a hiring manager's brief, the AI writes the role scorecard, then the job post and an interview kit that tests each must-have. A check removes biased or unlawful wording before the owner approves. Saved as a page.",
      "Từ mô tả của người quản lý tuyển dụng, AI viết bảng tiêu chí vị trí, rồi tin tuyển dụng và bộ câu hỏi phỏng vấn kiểm tra từng yêu cầu bắt buộc. Bước kiểm tra loại bỏ từ ngữ thiên vị hoặc trái luật trước khi người phụ trách duyệt. Lưu thành một trang.",
    ),
    uses: {
      en: ["Put what the person will do and why you are hiring in the task", "Fill in the company intro and benefits in Resources once"],
      vi: ["Ghi người này sẽ làm gì và vì sao cần tuyển vào việc", "Điền giới thiệu công ty và phúc lợi trong Tài nguyên một lần"],
    },
    inputs: [
      { key: "title", label: t("Job title", "Chức danh"), required: true },
      {
        key: "level",
        label: t("Level", "Cấp bậc"),
        type: "choice",
        options: { en: ["Intern", "Junior", "Mid-level", "Senior", "Lead"], vi: ["Thực tập", "Junior", "Middle", "Senior", "Trưởng nhóm"] },
        default: t("Mid-level", "Middle"),
      },
      { key: "location", label: t("Location and working mode", "Địa điểm và hình thức làm việc"), placeholder: t("e.g. Hanoi, hybrid", "vd. Hà Nội, hybrid") },
      { key: "salary", label: t("Salary range", "Khoảng lương"), placeholder: t("leave empty to say “competitive”", "để trống nếu ghi “thoả thuận”") },
    ],
    notes: t(
      "## About the company (three sentences)\n[…]\n\n## Benefits\n- […]\n\n## How we hire\n- Steps: [e.g. screening call, work sample, team interview]\n- Apply at: [address or link]",
      "## Về công ty (ba câu)\n[…]\n\n## Phúc lợi\n- […]\n\n## Quy trình tuyển\n- Các vòng: [vd. gọi sơ loại, bài làm mẫu, phỏng vấn với nhóm]\n- Ứng tuyển tại: [địa chỉ hoặc link]",
    ),
    guardrails: { maxMinutes: 25 },
    output: { doc: true },
    steps: [
      {
        key: "scorecard",
        kind: "ai",
        role: t("A recruiter: defines the job by its outcomes, not by a wish list.", "Chuyên viên tuyển dụng: định nghĩa công việc bằng kết quả, không phải danh sách mong muốn."),
        title: t("Role scorecard", "Bảng tiêu chí vị trí"),
        prompt: t(
          `From the brief in the task below, write the scorecard for {{input.title}} ({{input.level}}): ## Mission (one sentence: why the job exists), ## Outcomes in the first year (three to five, measurable), ## Must-haves (six at most; each one something you can test in an interview), ## Nice-to-haves, ## Not required (what people assume but the job does not need). ${ONLY.en} If the brief does not say what the person will be responsible for, ask.\n\n{{task}}`,
          `Từ mô tả trong việc dưới đây, viết bảng tiêu chí cho vị trí {{input.title}} ({{input.level}}): ## Sứ mệnh (một câu: vì sao có vị trí này), ## Kết quả trong năm đầu (ba đến năm, đo được), ## Bắt buộc (tối đa sáu; mỗi cái kiểm tra được trong phỏng vấn), ## Ưu tiên, ## Không yêu cầu (điều người ta hay mặc định nhưng công việc không cần). ${ONLY.vi} Nếu mô tả không nói người này chịu trách nhiệm việc gì thì hỏi.\n\n{{task}}`,
        ),
      },
      {
        key: "post",
        kind: "ai",
        ask: false,
        maxOutput: 4000,
        title: t("Job post and interview kit", "Tin tuyển dụng và bộ phỏng vấn"),
        prompt: t(
          'Write two parts in Markdown from the scorecard below.\n\n# Job post\nFor {{input.title}}, {{input.location}}. Sections: what you will do (the outcomes, addressed to "you"), what you bring (the must-haves only, then nice-to-haves marked as such), what we offer (salary: {{input.salary}}, or "competitive" when empty; benefits from the reference), about us and how to apply (from the reference). Under 400 words. Describe the work, not a kind of person: no age, gender, marital status, appearance, origin or "young and dynamic" wording.\n\n# Interview kit\nFor each must-have: one question about past behaviour, what a strong answer contains, and a warning sign. Then one short work-sample task with how to score it.\n\nScorecard:\n{{steps.scorecard}}',
          'Viết hai phần bằng Markdown từ bảng tiêu chí dưới đây.\n\n# Tin tuyển dụng\nCho vị trí {{input.title}}, {{input.location}}. Các mục: bạn sẽ làm gì (các kết quả, xưng hô "bạn"), bạn cần có gì (chỉ các yêu cầu bắt buộc, sau đó là ưu tiên và ghi rõ là ưu tiên), chúng tôi mang lại gì (lương: {{input.salary}}, hoặc "thoả thuận" khi để trống; phúc lợi theo tài liệu tham chiếu), về chúng tôi và cách ứng tuyển (theo tài liệu tham chiếu). Dưới 400 từ. Mô tả công việc, không mô tả kiểu người: không nhắc tuổi, giới tính, tình trạng hôn nhân, ngoại hình, quê quán hay kiểu "trẻ trung năng động".\n\n# Bộ phỏng vấn\nVới mỗi yêu cầu bắt buộc: một câu hỏi về hành vi trong quá khứ, câu trả lời tốt gồm những gì, và một dấu hiệu cần lưu ý. Sau đó là một bài làm mẫu ngắn kèm cách chấm.\n\nBảng tiêu chí:\n{{steps.scorecard}}',
        ),
      },
      {
        key: "fairness",
        kind: "check",
        title: t("Fair and lawful wording", "Từ ngữ công bằng và đúng luật"),
        criteria: t(
          "No requirement or preference about age, gender, marital or family status, appearance, health, religion, origin or hometown\nNo wording that implies an age or gender (young, energetic, salesman, recent graduate only)\nAt most six must-haves, each something an interview can test\nThe post says the salary or says it is competitive, and says how to apply\nEvery interview question asks about something the candidate did, not about their private life",
          "Không có yêu cầu hay ưu tiên nào về tuổi, giới tính, tình trạng hôn nhân hoặc gia đình, ngoại hình, sức khoẻ, tôn giáo, quê quán\nKhông có từ ngữ ngầm chỉ tuổi hoặc giới tính (trẻ trung, năng động, nam/nữ, chỉ nhận mới tốt nghiệp)\nTối đa sáu yêu cầu bắt buộc, mỗi cái kiểm tra được trong phỏng vấn\nTin đăng nêu mức lương hoặc ghi thoả thuận, và nói cách ứng tuyển\nMọi câu hỏi phỏng vấn hỏi về điều ứng viên đã làm, không hỏi đời tư",
        ),
      },
      approval("approve", APPROVE, "owner"),
    ],
  },
  {
    key: "onboarding-plan",
    category: "hr",
    name: t("Onboarding plan: 30-60-90 → check → approve → subtasks", "Kế hoạch hội nhập: 30-60-90 → kiểm tra → duyệt → việc con"),
    description: t(
      "For a new hire, the AI writes a 30-60-90 day plan with goals for each stage and a dated checklist for the first weeks. After the manager approves, every checklist line becomes a subtask on this task.",
      "Với nhân viên mới, AI viết kế hoạch 30-60-90 ngày gồm mục tiêu từng giai đoạn và checklist có ngày cho những tuần đầu. Sau khi quản lý duyệt, mỗi dòng checklist trở thành một việc con của việc này.",
    ),
    uses: {
      en: ["Put what the role does and who the person works with in the task", "List what every new hire must do (accounts, training, paperwork) in Resources once"],
      vi: ["Ghi vị trí này làm gì và làm việc với ai vào việc", "Liệt kê những việc mọi nhân viên mới phải làm (tài khoản, đào tạo, giấy tờ) trong Tài nguyên một lần"],
    },
    inputs: [
      { key: "role", label: t("Role", "Vị trí"), required: true },
      { key: "start", label: t("Start date", "Ngày bắt đầu"), type: "date", required: true },
      { key: "manager", label: t("Manager", "Quản lý trực tiếp") },
      { key: "buddy", label: t("Buddy", "Người kèm cặp") },
    ],
    notes: t(
      "## Every new hire\n- Day 1: [accounts, equipment, building access]\n- Week 1: [mandatory training, policies to read, people to meet]\n- Paperwork: [contract, tax, bank details]\n\n## Probation\n- Length: [e.g. 60 days]\n- Reviews: [when, with whom]",
      "## Mọi nhân viên mới\n- Ngày đầu: [tài khoản, thiết bị, thẻ ra vào]\n- Tuần đầu: [đào tạo bắt buộc, quy định cần đọc, những người cần gặp]\n- Giấy tờ: [hợp đồng, thuế, tài khoản ngân hàng]\n\n## Thử việc\n- Thời gian: [vd. 60 ngày]\n- Đánh giá: [khi nào, với ai]",
    ),
    guardrails: { maxMinutes: 20 },
    output: { subtasks: true },
    steps: [
      {
        key: "plan",
        kind: "ai",
        maxOutput: 4000,
        role: t("A people partner who has onboarded this kind of role before.", "Chuyên viên nhân sự từng hội nhập vị trí kiểu này."),
        title: t("30-60-90 plan", "Kế hoạch 30-60-90"),
        prompt: t(
          `Write the onboarding plan in Markdown for a new {{input.role}} starting on {{input.start}}. Manager: {{input.manager}}. Buddy: {{input.buddy}}. Sections: ## First 30 days: learn (goals, what good looks like on day 30), ## Days 31–60: contribute, ## Days 61–90: own, ## Check-ins (dates counted from the start date, with whom, what is discussed), then ## Checklist as the only checkboxes in the document, in date order, at most 20 lines: "- [ ] <what> · <who does it: new hire, manager, buddy, HR or IT> · <date>". Include everything under "Every new hire" in the reference material. ${ONLY.en} If the task does not say what the role is responsible for, ask.\n\n{{task}}`,
          `Viết kế hoạch hội nhập bằng Markdown cho {{input.role}} mới, bắt đầu ngày {{input.start}}. Quản lý: {{input.manager}}. Người kèm cặp: {{input.buddy}}. Các mục: ## 30 ngày đầu: học (mục tiêu, thế nào là tốt ở ngày 30), ## Ngày 31–60: đóng góp, ## Ngày 61–90: làm chủ, ## Các buổi trao đổi (ngày tính từ ngày bắt đầu, với ai, nói về gì), rồi ## Checklist là những ô đánh dấu duy nhất trong tài liệu, theo thứ tự ngày, tối đa 20 dòng: "- [ ] <việc gì> · <ai làm: nhân viên mới, quản lý, người kèm cặp, nhân sự hoặc IT> · <ngày>". Đưa vào mọi việc trong mục "Mọi nhân viên mới" của tài liệu tham chiếu. ${ONLY.vi} Nếu việc không nói vị trí này chịu trách nhiệm gì thì hỏi.\n\n{{task}}`,
        ),
      },
      {
        key: "check",
        kind: "check",
        model: "fast",
        title: t("Concrete and dated", "Cụ thể và có ngày"),
        criteria: t(
          "Each of the three stages has goals a manager could judge as met or not met\nEvery checklist line names who does it and a date\nThe checklist has at most 20 lines and nothing else in the document is a checkbox\nThere is a check-in in each of the three stages\nThe first day has a clear schedule: who the person meets and what they get",
          "Mỗi giai đoạn trong ba giai đoạn có mục tiêu mà quản lý đánh giá được là đạt hay chưa\nMỗi dòng checklist nêu ai làm và ngày\nChecklist tối đa 20 dòng và không dòng nào khác trong tài liệu có ô đánh dấu\nMỗi giai đoạn có một buổi trao đổi\nNgày đầu tiên có lịch rõ ràng: gặp ai và nhận gì",
        ),
      },
      approval("approve", t("Manager approves", "Quản lý duyệt"), "owner"),
    ],
  },

  // ── Finance ──────────────────────────────────────────────────────────────────────────────────────
  {
    key: "data-report",
    category: "finance",
    // AI steps write the analysis with the runner's agent in the folder; the commands run it inside the container,
    // where pandas is installed and the files cannot reach anything but the run's own folders.
    environment: {
      kind: "sandbox",
      host: "company",
      isolation: "container",
      image: "python:3.12-slim",
      network: "on",
      memoryMb: 2048,
      setup: "pip install --quiet --no-cache-dir pandas matplotlib openpyxl",
    },
    name: t("Data report in a sandbox: inspect → analyse → run → report → approve", "Báo cáo số liệu trong sandbox: xem dữ liệu → phân tích → chạy → báo cáo → duyệt"),
    description: t(
      "Attach spreadsheets to the task and ask a question. In an isolated container, the AI writes a small analysis script, the sandbox runs it (errors go back to the AI to fix), and the AI reports only the numbers the script printed. Charts, tables and the script are attached to the task.",
      "Đính kèm bảng tính vào việc và đặt câu hỏi. Trong một container cách ly, AI viết một script phân tích nhỏ, sandbox chạy nó (lỗi được trả về cho AI sửa), và AI chỉ báo cáo những con số script in ra. Biểu đồ, bảng và script được đính kèm vào việc.",
    ),
    uses: {
      en: [
        "Attach the CSV or Excel files to the task",
        "Needs a company computer with Docker",
        "Every number in the report comes from the script's output, and the script is attached so anyone can rerun it",
      ],
      vi: [
        "Đính kèm file CSV hoặc Excel vào việc",
        "Cần một máy của công ty có Docker",
        "Mọi con số trong báo cáo lấy từ kết quả chạy script, và script được đính kèm để ai cũng chạy lại được",
      ],
    },
    inputs: [
      {
        key: "question",
        label: t("What do you want to know", "Bạn muốn biết điều gì"),
        type: "long",
        required: true,
        placeholder: t(
          "e.g. revenue by month and by product line, and the three biggest changes against last quarter",
          "vd. doanh thu theo tháng và theo dòng sản phẩm, và ba thay đổi lớn nhất so với quý trước",
        ),
      },
      { key: "period", label: t("Period", "Kỳ"), placeholder: t("e.g. Q3 2026", "vd. Quý 3/2026") },
    ],
    taskFiles: true,
    guardrails: { maxMinutes: 45, stepMinutes: 15, ask: "never" },
    output: { files: true },
    steps: [
      {
        key: "inspect",
        kind: "command",
        title: t("Look at the files", "Xem các file"),
        command:
          "python - <<'PY'\nimport glob\nimport pandas as pd\nfiles = sorted(glob.glob('../assets/*'))\nprint(len(files), 'file(s) in ../assets')\nfor f in files:\n    print('==', f)\n    try:\n        df = pd.read_excel(f) if f.lower().endswith(('.xlsx', '.xls')) else pd.read_csv(f, sep=None, engine='python')\n        print('rows, columns:', df.shape)\n        print(df.dtypes.to_string())\n        print(df.head(8).to_string())\n    except Exception as e:\n        print('not a table:', e)\nPY",
      },
      {
        key: "analyse",
        kind: "ai",
        model: "sonnet",
        timeoutMin: 15,
        role: t(
          "A data analyst: careful with types, dates and missing values; shows the work.",
          "Chuyên viên phân tích dữ liệu: cẩn thận với kiểu dữ liệu, ngày tháng và giá trị thiếu; trình bày rõ cách tính.",
        ),
        title: t("Write the analysis", "Viết phân tích"),
        prompt: t(
          'Write analysis.py in this folder; do not run it (it runs in the next step, in a container with pandas, matplotlib and openpyxl). It answers this question: {{input.question}} (period: {{input.period}}).\nThe script must: read the data files from ../assets (their names, columns and first rows are below); clean what needs cleaning and print what it dropped or assumed; print every result as a clearly labelled table or line under a "## " heading; save each table as CSV and each chart as PNG in ../out (matplotlib with the Agg backend); never read anything outside ../assets and never use the network. Then reply with a three-line summary of what the script computes.\n\nFiles:\n{{steps.inspect}}\n\n{{task}}',
          'Viết analysis.py trong thư mục này; không chạy nó (nó sẽ được chạy ở bước sau, trong container có pandas, matplotlib và openpyxl). Script trả lời câu hỏi này: {{input.question}} (kỳ: {{input.period}}).\nScript phải: đọc các file dữ liệu từ ../assets (tên file, cột và các dòng đầu ở bên dưới); làm sạch những gì cần và in ra đã bỏ gì, giả định gì; in mỗi kết quả thành bảng hoặc dòng có nhãn rõ ràng dưới một đề mục "## "; lưu mỗi bảng thành CSV và mỗi biểu đồ thành PNG trong ../out (matplotlib với backend Agg); không đọc gì ngoài ../assets và không dùng mạng. Sau đó trả lời bằng ba dòng tóm tắt script tính những gì.\n\nCác file:\n{{steps.inspect}}\n\n{{task}}',
        ),
      },
      {
        key: "run",
        kind: "check",
        attempts: 3,
        onFail: "stop",
        title: t("The analysis runs", "Phân tích chạy được"),
        command: "python analysis.py > ../out/results.txt 2>&1 || { tail -n 40 ../out/results.txt; exit 1; }",
      },
      { key: "results", kind: "command", title: t("Collect the results", "Lấy kết quả"), command: "cp analysis.py ../out/ && cat ../out/results.txt" },
      {
        key: "report",
        kind: "ai",
        model: "sonnet",
        role: t("A finance analyst writing for a manager who has five minutes.", "Chuyên viên tài chính viết cho người quản lý chỉ có năm phút."),
        title: t("Write the report", "Viết báo cáo"),
        prompt: t(
          "Write the report in Markdown from the script's output below, answering: {{input.question}} (period: {{input.period}}). Sections: ## Answer (three sentences at most), ## Key numbers (a table), ## What stands out (three to five points, each with its number), ## Data notes (what was dropped or assumed, as the script printed), ## Files (the charts and tables saved, by file name). Every number must appear in the output below exactly; do not compute new numbers, do not explain causes the data does not show. Do not change any file.\n\nScript output:\n{{previous}}",
          "Viết báo cáo bằng Markdown từ kết quả chạy script dưới đây, trả lời: {{input.question}} (kỳ: {{input.period}}). Các mục: ## Trả lời (tối đa ba câu), ## Số liệu chính (một bảng), ## Điểm đáng chú ý (ba đến năm điểm, mỗi điểm kèm con số), ## Ghi chú dữ liệu (đã bỏ gì, giả định gì, đúng như script in ra), ## File (các biểu đồ và bảng đã lưu, theo tên file). Mọi con số phải xuất hiện đúng y trong kết quả bên dưới; không tự tính số mới, không giải thích nguyên nhân mà dữ liệu không cho thấy. Không sửa file nào.\n\nKết quả chạy script:\n{{previous}}",
        ),
      },
      {
        key: "check",
        kind: "check",
        attempts: 1,
        onFail: "continue",
        title: t("Report is sound", "Báo cáo chắc chắn"),
        criteria: t(
          "Starts with a direct answer of at most three sentences\nHas a table of key numbers with units or currency\nEvery point under What stands out carries a number\nStates no cause or forecast as fact\nHas a section on what was dropped or assumed in the data",
          "Mở đầu bằng câu trả lời trực tiếp, tối đa ba câu\nCó bảng số liệu chính kèm đơn vị hoặc loại tiền\nMỗi điểm đáng chú ý đều có con số\nKhông khẳng định nguyên nhân hay dự báo như sự thật\nCó mục nêu dữ liệu đã bỏ gì hoặc giả định gì",
        ),
      },
      approval("approve", APPROVE),
    ],
  },
  {
    key: "budget-variance",
    category: "finance",
    name: t("Budget variance: table → recheck → commentary → check → approve", "Chênh lệch ngân sách: bảng → soát lại → nhận xét → kiểm tra → duyệt"),
    description: t(
      "Paste budget and actual figures. The AI builds the variance table, a second pass recomputes every line, then it writes the commentary: which lines are over the threshold, the reason when the task gives one, and what the owner must explain.",
      "Dán số ngân sách và số thực tế. AI lập bảng chênh lệch, lượt thứ hai tính lại từng dòng, rồi viết nhận xét: dòng nào vượt ngưỡng, lý do khi việc có nêu, và điều người phụ trách cần giải trình.",
    ),
    uses: {
      en: [
        "Paste the budget and actual figures per line into the Figures field or the task",
        "For large spreadsheets use “Data report in a sandbox” instead: it computes with code",
      ],
      vi: ["Dán số ngân sách và thực tế theo từng dòng vào ô Số liệu hoặc vào việc", "Với bảng tính lớn, hãy dùng “Báo cáo số liệu trong sandbox”: nó tính bằng code"],
    },
    inputs: [
      { key: "period", label: t("Period", "Kỳ"), required: true, placeholder: t("e.g. October 2026", "vd. Tháng 10/2026") },
      {
        key: "figures",
        label: t("Figures", "Số liệu"),
        type: "long",
        placeholder: t("Line, budget, actual (one line each)", "Khoản mục, ngân sách, thực tế (mỗi dòng một khoản)"),
      },
      { key: "threshold", label: t("Flag variances above (%)", "Đánh dấu chênh lệch trên (%)"), type: "number", default: t("10", "10") },
    ],
    guardrails: { maxMinutes: 20 },
    steps: [
      {
        key: "table",
        kind: "ai",
        model: "fast",
        role: t("A management accountant: exact, never rounds away a difference.", "Kế toán quản trị: chính xác, không làm tròn mất chênh lệch."),
        title: t("Variance table", "Bảng chênh lệch"),
        prompt: t(
          `Build the variance table for {{input.period}} from the figures below and in the task: a Markdown table with line, budget, actual, variance (actual − budget), variance % (variance ÷ budget), and "Over" for a line whose variance is above {{input.threshold}}% in either direction. Keep the lines in the order given, then a total line. Copy every budget and actual figure exactly; if a figure is missing or unreadable, write [missing] and leave the line out of the total. If no figures are given at all, ask for them.\n\nFigures:\n{{input.figures}}\n\n{{task}}`,
          `Lập bảng chênh lệch cho {{input.period}} từ số liệu dưới đây và trong việc: một bảng Markdown gồm khoản mục, ngân sách, thực tế, chênh lệch (thực tế − ngân sách), chênh lệch % (chênh lệch ÷ ngân sách), và ghi "Vượt" cho dòng có chênh lệch trên {{input.threshold}}% theo cả hai chiều. Giữ thứ tự các dòng như đã cho, sau đó là dòng tổng. Chép đúng y từng số ngân sách và thực tế; nếu thiếu số hoặc không đọc được thì ghi [thiếu] và không tính dòng đó vào tổng. Nếu hoàn toàn không có số liệu thì hỏi.\n\nSố liệu:\n{{input.figures}}\n\n{{task}}`,
        ),
      },
      {
        key: "recheck",
        kind: "ai",
        ask: false,
        resources: false,
        role: t("An auditor recomputing someone else's table, line by line.", "Kiểm toán viên tính lại bảng của người khác, từng dòng một."),
        title: t("Recompute every line", "Tính lại từng dòng"),
        prompt: t(
          "Recompute the table below line by line: variance = actual − budget, variance % = variance ÷ budget × 100 to one decimal, the totals are the sums of the lines, and the Over mark is right for a threshold of {{input.threshold}}%. Correct every wrong cell. Return only the corrected table, complete, with nothing before or after it.\n\n{{steps.table}}",
          "Tính lại bảng dưới đây từng dòng một: chênh lệch = thực tế − ngân sách, chênh lệch % = chênh lệch ÷ ngân sách × 100 lấy một chữ số thập phân, dòng tổng bằng tổng các dòng, và dấu Vượt đúng với ngưỡng {{input.threshold}}%. Sửa mọi ô sai. Chỉ trả về toàn bộ bảng đã sửa, không thêm gì trước hoặc sau.\n\n{{steps.table}}",
        ),
      },
      {
        key: "commentary",
        kind: "ai",
        ask: false,
        role: t(
          "A finance business partner: says what the numbers mean and what is not yet known.",
          "Đối tác tài chính của khối kinh doanh: nói con số có nghĩa gì và điều gì chưa biết.",
        ),
        title: t("Commentary", "Nhận xét"),
        prompt: t(
          'Write the variance report for {{input.period}} in Markdown: ## Summary (total budget, total actual, total variance, in two sentences), ## Variance table (the table below, unchanged), ## Lines over {{input.threshold}}% (for each: the variance, then the reason only if the task or its context states one, with its source; otherwise write "[explanation needed from the budget owner]"), ## Questions for budget owners (one per unexplained line), ## Watch next period. Compute no new numbers; state no cause the sources do not give.\n\nTable:\n{{steps.recheck}}\n\n{{task}}',
          'Viết báo cáo chênh lệch cho {{input.period}} bằng Markdown: ## Tóm tắt (tổng ngân sách, tổng thực tế, tổng chênh lệch, trong hai câu), ## Bảng chênh lệch (bảng dưới đây, giữ nguyên), ## Các dòng vượt {{input.threshold}}% (với mỗi dòng: mức chênh lệch, rồi lý do chỉ khi việc hoặc ngữ cảnh có nêu, kèm nguồn; nếu không thì ghi "[cần người phụ trách ngân sách giải trình]"), ## Câu hỏi cho người phụ trách ngân sách (mỗi dòng chưa có lý do một câu), ## Cần theo dõi kỳ sau. Không tính số mới; không nêu nguyên nhân mà nguồn không nói.\n\nBảng:\n{{steps.recheck}}\n\n{{task}}',
        ),
      },
      {
        key: "check",
        kind: "check",
        title: t("Numbers and reasons hold", "Số và lý do đứng vững"),
        criteria: t(
          "In every table line, variance equals actual minus budget\nThe total line equals the sum of the lines above it\nEvery line marked Over appears in the section on lines over the threshold\nEvery reason given names its source, or the line is marked as needing an explanation\nNo forecast or cause is stated as fact",
          "Ở mỗi dòng của bảng, chênh lệch bằng thực tế trừ ngân sách\nDòng tổng bằng tổng các dòng phía trên\nMỗi dòng ghi Vượt đều xuất hiện trong mục các dòng vượt ngưỡng\nMỗi lý do đều nêu nguồn, hoặc dòng đó được đánh dấu là cần giải trình\nKhông khẳng định dự báo hay nguyên nhân như sự thật",
        ),
      },
      approval("approve", APPROVE, "owner"),
    ],
  },

  // ── Legal ────────────────────────────────────────────────────────────────────────────────────────
  {
    key: "contract-review",
    category: "legal",
    name: t("Contract review: clauses → risks → redlines → check → approve", "Rà soát hợp đồng: điều khoản → rủi ro → đề xuất sửa → kiểm tra → duyệt"),
    description: t(
      "The AI maps what each clause says, compares it with your company's standard positions, and writes a review memo with the risks and suggested wording. It prepares the review; a person responsible for legal matters decides.",
      "AI lập bảng từng điều khoản nói gì, so với các lập trường chuẩn của công ty, và viết bản rà soát gồm rủi ro và câu chữ đề xuất. AI chuẩn bị bản rà soát; người chịu trách nhiệm pháp lý mới là người quyết định.",
    ),
    uses: {
      en: [
        "Paste the contract text into the Contract field (about 8,000 characters; review long contracts section by section)",
        "Write your standard positions in Resources once: liability, payment, termination, confidentiality",
        "This is a first pass for a person to decide on, not legal advice",
      ],
      vi: [
        "Dán nội dung hợp đồng vào ô Hợp đồng (khoảng 8.000 ký tự; hợp đồng dài thì rà từng phần)",
        "Ghi các lập trường chuẩn của công ty trong Tài nguyên một lần: trách nhiệm, thanh toán, chấm dứt, bảo mật",
        "Đây là lượt rà đầu để người có trách nhiệm quyết định, không phải tư vấn pháp lý",
      ],
    },
    inputs: [
      { key: "contract", label: t("Contract text", "Hợp đồng"), type: "long", required: true, placeholder: t("Paste the clauses to review", "Dán các điều khoản cần rà soát") },
      {
        key: "side",
        label: t("We are the", "Chúng ta là bên"),
        type: "choice",
        options: { en: ["Customer", "Supplier", "Employer", "Partner"], vi: ["Mua", "Bán", "Sử dụng lao động", "Đối tác"] },
        required: true,
      },
      { key: "counterparty", label: t("Other party", "Bên kia") },
      { key: "law", label: t("Governing law", "Luật áp dụng"), placeholder: t("e.g. Vietnam", "vd. Việt Nam") },
    ],
    notes: t(
      "## Our standard positions\n- Liability: [e.g. capped at the fees of the last 12 months; never unlimited]\n- Payment: [e.g. 30 days from invoice]\n- Termination: [e.g. either side, 30 days' notice]\n- Confidentiality: [e.g. mutual, 3 years]\n- IP: [who owns what is made]\n- Governing law and disputes: [what we accept]\n\n## We never sign\n- [e.g. automatic renewal over 12 months, exclusivity, penalties above …]",
      "## Lập trường chuẩn của công ty\n- Trách nhiệm: [vd. giới hạn bằng phí 12 tháng gần nhất; không bao giờ vô hạn]\n- Thanh toán: [vd. 30 ngày kể từ hoá đơn]\n- Chấm dứt: [vd. mỗi bên, báo trước 30 ngày]\n- Bảo mật: [vd. hai chiều, 3 năm]\n- Sở hữu trí tuệ: [ai sở hữu sản phẩm tạo ra]\n- Luật áp dụng và giải quyết tranh chấp: [điều ta chấp nhận]\n\n## Không bao giờ ký\n- [vd. tự động gia hạn trên 12 tháng, độc quyền, phạt vượt …]",
    ),
    guardrails: { maxMinutes: 30, ask: "never" },
    output: { doc: true },
    steps: [
      {
        key: "clauses",
        kind: "ai",
        model: "fast",
        resources: false,
        role: t("A paralegal: records what the text says, quotes it, interprets nothing.", "Trợ lý pháp lý: ghi lại điều văn bản nói, trích nguyên văn, không diễn giải."),
        title: t("Clause map", "Bảng điều khoản"),
        prompt: t(
          'Map the contract below. A Markdown table, one row per clause in the order of the text: clause number or heading, topic (parties, scope, price and payment, term and renewal, termination, liability, warranties, confidentiality, IP, data, disputes, other), what it says in one plain sentence, and the key words quoted exactly. Then "## Not found": the usual topics from that list the text does not cover. Record only what the text says.\n\nContract:\n{{input.contract}}\n\n{{task}}',
          'Lập bảng cho hợp đồng dưới đây. Một bảng Markdown, mỗi điều khoản một dòng theo thứ tự văn bản: số hoặc tên điều khoản, chủ đề (các bên, phạm vi, giá và thanh toán, thời hạn và gia hạn, chấm dứt, trách nhiệm, bảo đảm, bảo mật, sở hữu trí tuệ, dữ liệu, tranh chấp, khác), điều khoản nói gì trong một câu dễ hiểu, và các chữ then chốt trích nguyên văn. Sau đó "## Không thấy": những chủ đề thường có trong danh sách trên mà văn bản không đề cập. Chỉ ghi điều văn bản nói.\n\nHợp đồng:\n{{input.contract}}\n\n{{task}}',
        ),
      },
      {
        key: "risks",
        kind: "ai",
        role: t(
          "A commercial lawyer acting for our side: practical, says what matters and what does not.",
          "Luật sư thương mại đứng về phía chúng ta: thực tế, nói điều gì quan trọng và điều gì không.",
        ),
        title: t("Risks", "Rủi ro"),
        prompt: t(
          'We are the {{input.side}}; the other party is {{input.counterparty}}; governing law: {{input.law}}. Compare each clause in the map below with our standard positions in the reference material. List the risks, highest first; for each: the clause, the words at issue (quoted), the level (high, medium or low), why it matters to us in one sentence, and how it differs from our position (or "No standard position" when the reference has none). Then "## Missing protections": clauses we would expect for our side that are not there. Do not state what the law says unless the contract text itself says it; mark anything that needs a lawyer\'s reading of the law "(check the law)".\n\nClause map:\n{{steps.clauses}}',
          'Chúng ta là bên {{input.side}}; bên kia là {{input.counterparty}}; luật áp dụng: {{input.law}}. So từng điều khoản trong bảng dưới đây với lập trường chuẩn của công ty trong tài liệu tham chiếu. Liệt kê rủi ro, cao nhất trước; với mỗi rủi ro: điều khoản, câu chữ có vấn đề (trích nguyên văn), mức độ (cao, trung bình hoặc thấp), vì sao quan trọng với chúng ta trong một câu, và khác lập trường của ta thế nào (hoặc "Chưa có lập trường chuẩn" khi tài liệu tham chiếu không có). Sau đó "## Thiếu bảo vệ": những điều khoản lẽ ra phải có cho phía ta mà không thấy. Không khẳng định pháp luật quy định gì trừ khi chính văn bản hợp đồng nói; điều gì cần luật sư đối chiếu với luật thì ghi "(cần đối chiếu luật)".\n\nBảng điều khoản:\n{{steps.clauses}}',
        ),
      },
      {
        key: "memo",
        kind: "ai",
        maxOutput: 4000,
        role: t("A commercial lawyer writing for a manager who must decide whether to sign.", "Luật sư thương mại viết cho người quản lý phải quyết định ký hay không."),
        title: t("Review memo with redlines", "Bản rà soát kèm đề xuất sửa"),
        prompt: t(
          'Write the review memo in Markdown. First line, exactly: "Prepared by AI as a first pass. It is not legal advice; a person responsible for legal matters decides." Then: ## Bottom line (sign as is, sign after changes, or do not sign yet, and why in two sentences), ## Top risks (five at most, each with the clause and the quoted words), ## Suggested redlines (for every high and medium risk: the clause, "Current:" the quoted words, "Proposed:" replacement wording in the contract\'s own language and style, "Why:" one sentence), ## Missing protections (with proposed wording), ## Questions for {{input.counterparty}}, ## Check the law (the points marked for a lawyer). Change no quoted text; add no risk that is not in the list below.\n\nRisks:\n{{steps.risks}}\n\nClause map:\n{{steps.clauses}}',
          'Viết bản rà soát bằng Markdown. Dòng đầu tiên, đúng nguyên văn: "Do AI chuẩn bị làm lượt rà đầu. Đây không phải tư vấn pháp lý; người chịu trách nhiệm pháp lý là người quyết định." Sau đó: ## Kết luận (ký như hiện tại, ký sau khi sửa, hoặc chưa ký, và vì sao trong hai câu), ## Rủi ro chính (tối đa năm, mỗi cái kèm điều khoản và câu chữ trích nguyên văn), ## Đề xuất sửa (với mỗi rủi ro cao và trung bình: điều khoản, "Hiện tại:" câu chữ trích nguyên văn, "Đề xuất:" câu chữ thay thế theo đúng ngôn ngữ và văn phong của hợp đồng, "Vì sao:" một câu), ## Thiếu bảo vệ (kèm câu chữ đề xuất), ## Câu hỏi cho {{input.counterparty}}, ## Cần đối chiếu luật (những điểm đã đánh dấu cho luật sư). Không đổi câu chữ đã trích; không thêm rủi ro nào ngoài danh sách dưới đây.\n\nRủi ro:\n{{steps.risks}}\n\nBảng điều khoản:\n{{steps.clauses}}',
        ),
      },
      {
        key: "check",
        kind: "check",
        title: t("Memo is careful", "Bản rà soát cẩn trọng"),
        criteria: t(
          "The first line says it was prepared by AI and is not legal advice\nEvery risk names a clause and quotes its words\nEvery high or medium risk has a redline with current and proposed wording\nThe bottom line is one of: sign as is, sign after changes, do not sign yet\nNo sentence states what a law or regulation requires as a fact, outside the section for points to check",
          "Dòng đầu tiên nói bản này do AI chuẩn bị và không phải tư vấn pháp lý\nMỗi rủi ro nêu điều khoản và trích câu chữ của nó\nMỗi rủi ro cao hoặc trung bình có đề xuất sửa gồm câu chữ hiện tại và đề xuất\nKết luận là một trong: ký như hiện tại, ký sau khi sửa, chưa ký\nKhông câu nào khẳng định luật hay quy định yêu cầu điều gì như sự thật, ngoài mục các điểm cần đối chiếu",
        ),
      },
      approval("approve", t("Legal owner decides", "Người phụ trách pháp lý quyết định"), "owner"),
    ],
  },

  // ── Research ─────────────────────────────────────────────────────────────────────────────────────
  {
    key: "research-brief",
    category: "research",
    name: t("Research brief: plan → findings → fact-check → brief → approve", "Bản nghiên cứu: kế hoạch → phát hiện → soát dữ kiện → bản tóm lược → duyệt"),
    description: t(
      "For one question, the AI plans what to find out, gathers findings from the workspace and your connected tools with a source for each, a second pass drops what the sources do not support, and it writes a brief that answers first. Saved as a page.",
      "Với một câu hỏi, AI lập kế hoạch cần tìm gì, gom phát hiện từ workspace và các công cụ đã kết nối kèm nguồn cho từng cái, lượt thứ hai loại những gì nguồn không chứng minh, rồi viết bản tóm lược trả lời ngay từ đầu. Lưu thành một trang.",
    ),
    uses: {
      en: [
        "Paste the material you already have into the task or attach documents in Resources",
        "With web search connected in Admin › AI connections, the AI looks there too; without it, it works from what you give it",
        "A finding without a source is dropped, not kept as a guess",
      ],
      vi: [
        "Dán tài liệu bạn đã có vào việc hoặc đính kèm trong Tài nguyên",
        "Nếu đã kết nối tìm kiếm web trong Admin › Kết nối AI, AI sẽ tra thêm ở đó; nếu không, nó làm từ những gì bạn đưa",
        "Phát hiện không có nguồn sẽ bị loại, không giữ lại như phỏng đoán",
      ],
    },
    inputs: [
      { key: "question", label: t("The question", "Câu hỏi"), type: "long", required: true },
      {
        key: "decision",
        label: t("The decision it serves", "Phục vụ quyết định nào"),
        placeholder: t("e.g. whether to enter the Thai market in 2027", "vd. có vào thị trường Thái Lan năm 2027 không"),
      },
      {
        key: "depth",
        label: t("Depth", "Độ sâu"),
        type: "choice",
        options: { en: ["Quick scan", "Standard", "Deep"], vi: ["Xem nhanh", "Tiêu chuẩn", "Chuyên sâu"] },
        default: t("Standard", "Tiêu chuẩn"),
      },
    ],
    guardrails: { maxMinutes: 40, stepMinutes: 15 },
    output: { doc: true },
    steps: [
      {
        key: "plan",
        kind: "ai",
        model: "fast",
        role: t("A research lead: breaks a question into ones that can be answered.", "Trưởng nhóm nghiên cứu: chia một câu hỏi thành những câu trả lời được."),
        title: t("Research plan", "Kế hoạch nghiên cứu"),
        prompt: t(
          "Plan the research for this question: {{input.question}}\nIt serves this decision: {{input.decision}}. Depth: {{input.depth}}.\nWrite: ## Sub-questions (three to six, each answerable with evidence), ## What would change the decision (the two or three findings that matter most), ## Where to look (the task and its context, the reference material, the tools you have), ## Out of scope. If the question is too broad to answer or it is unclear what decision it serves, ask.\n\n{{task}}",
          "Lập kế hoạch nghiên cứu cho câu hỏi này: {{input.question}}\nPhục vụ quyết định này: {{input.decision}}. Độ sâu: {{input.depth}}.\nViết: ## Câu hỏi con (ba đến sáu, mỗi câu trả lời được bằng bằng chứng), ## Điều gì sẽ làm thay đổi quyết định (hai hoặc ba phát hiện quan trọng nhất), ## Tìm ở đâu (việc và ngữ cảnh, tài liệu tham chiếu, các công cụ bạn có), ## Ngoài phạm vi. Nếu câu hỏi quá rộng để trả lời hoặc chưa rõ phục vụ quyết định nào thì hỏi.\n\n{{task}}",
        ),
      },
      {
        key: "findings",
        kind: "ai",
        ask: false,
        maxOutput: 4000,
        timeoutMin: 15,
        role: t("A researcher: reports what the sources say, with the source, and how sure.", "Nhà nghiên cứu: báo cáo điều nguồn nói, kèm nguồn, và mức chắc chắn."),
        title: t("Findings", "Phát hiện"),
        prompt: t(
          'Answer the sub-questions in the plan below from the task, its context, the reference material and the tools you have. Under each sub-question, list findings: one fact per line, then its source in brackets (document title, task code, tool, or link) with a short quote or figure from that source, and a confidence (high: stated by the source; medium: follows from it; low: one weak source). Never write a finding from what you only believe; where you found nothing, write "No evidence found". End with "## Conflicts": findings that disagree.\n\nPlan:\n{{steps.plan}}\n\n{{task}}',
          'Trả lời các câu hỏi con trong kế hoạch dưới đây từ việc, ngữ cảnh của nó, tài liệu tham chiếu và các công cụ bạn có. Dưới mỗi câu hỏi con, liệt kê phát hiện: mỗi dòng một dữ kiện, rồi nguồn trong ngoặc vuông (tên tài liệu, mã việc, công cụ, hoặc link) kèm một trích dẫn ngắn hoặc con số từ nguồn đó, và mức tin cậy (cao: nguồn nói rõ; trung bình: suy ra từ nguồn; thấp: chỉ một nguồn yếu). Không viết phát hiện từ điều bạn chỉ tin là đúng; chỗ nào không tìm thấy gì thì ghi "Không tìm thấy bằng chứng". Kết thúc bằng "## Mâu thuẫn": các phát hiện trái nhau.\n\nKế hoạch:\n{{steps.plan}}\n\n{{task}}',
        ),
      },
      {
        key: "verify",
        kind: "ai",
        ask: false,
        maxOutput: 4000,
        role: t("A sceptical reviewer who did not do this research.", "Người phản biện hoài nghi, không phải người làm nghiên cứu này."),
        title: t("Fact-check", "Soát dữ kiện"),
        prompt: t(
          'Check each finding below against the source it cites, using the task, its context, the reference material and your tools. Remove a finding whose source you cannot find or whose quote does not support it; lower the confidence of one that goes further than its source; keep the rest unchanged. Return only the corrected findings in the same structure, then "## Removed" with one line per removed finding and why.\n\nFindings:\n{{steps.findings}}\n\n{{task}}',
          'Đối chiếu từng phát hiện dưới đây với nguồn nó dẫn, dùng việc, ngữ cảnh của nó, tài liệu tham chiếu và các công cụ của bạn. Bỏ phát hiện không tìm thấy nguồn hoặc trích dẫn không chứng minh được nó; hạ mức tin cậy của phát hiện nói quá so với nguồn; giữ nguyên phần còn lại. Chỉ trả về các phát hiện đã sửa theo đúng cấu trúc cũ, rồi "## Đã bỏ" với mỗi phát hiện bị bỏ một dòng kèm lý do.\n\nPhát hiện:\n{{steps.findings}}\n\n{{task}}',
        ),
      },
      {
        key: "brief",
        kind: "ai",
        ask: false,
        resources: false,
        maxOutput: 4000,
        role: t(
          "An analyst writing for a decision maker: the answer first, the evidence after.",
          "Chuyên viên phân tích viết cho người ra quyết định: trả lời trước, bằng chứng sau.",
        ),
        title: t("Brief", "Bản tóm lược"),
        prompt: t(
          'Write the research brief in Markdown from the checked findings below, for this question: {{input.question}} (decision: {{input.decision}}). Sections: ## Answer (three sentences at most, with how sure and why), ## Evidence (per sub-question, the findings that carry the answer, each with its source in brackets), ## What we do not know (and how to find out), ## Options (two or three, each with what the evidence says for and against), ## Recommendation (one, or "Not enough evidence to recommend" with what is missing), ## Sources (a list). Use only the findings below; a low-confidence finding is named as such; leave the "Removed" list out.\n\nChecked findings:\n{{steps.verify}}',
          'Viết bản tóm lược nghiên cứu bằng Markdown từ các phát hiện đã soát dưới đây, cho câu hỏi này: {{input.question}} (quyết định: {{input.decision}}). Các mục: ## Trả lời (tối đa ba câu, kèm mức chắc chắn và vì sao), ## Bằng chứng (theo từng câu hỏi con, các phát hiện làm nên câu trả lời, mỗi cái kèm nguồn trong ngoặc vuông), ## Điều chưa biết (và cách tìm ra), ## Phương án (hai hoặc ba, mỗi cái kèm bằng chứng ủng hộ và phản đối), ## Khuyến nghị (một, hoặc "Chưa đủ bằng chứng để khuyến nghị" kèm điều còn thiếu), ## Nguồn (một danh sách). Chỉ dùng các phát hiện dưới đây; phát hiện có mức tin cậy thấp phải nói rõ là thấp; không đưa danh sách "Đã bỏ" vào.\n\nPhát hiện đã soát:\n{{steps.verify}}',
        ),
      },
      {
        key: "check",
        kind: "check",
        title: t("Answer first, sourced", "Trả lời trước, có nguồn"),
        criteria: t(
          "Opens with a direct answer of at most three sentences that says how sure it is\nEvery finding under Evidence has a source in brackets\nHas a section on what is not known\nGives exactly one recommendation, or says there is not enough evidence\nEnds with a list of sources",
          "Mở đầu bằng câu trả lời trực tiếp, tối đa ba câu, có nói mức chắc chắn\nMỗi phát hiện trong mục Bằng chứng có nguồn trong ngoặc vuông\nCó mục nêu điều chưa biết\nĐưa đúng một khuyến nghị, hoặc nói rõ chưa đủ bằng chứng\nKết thúc bằng danh sách nguồn",
        ),
      },
      approval("approve", APPROVE),
    ],
  },
];

export interface ResolvedTemplate {
  key: string;
  category: Category;
  runner: Runner;
  name: string;
  description: string;
  uses: string[];
  steps: WorkflowStep[];
  config: WorkflowConfig;
}

/** The templates in the viewer's language. Chinese and Spanish read the English text. */
export const templatesFor = (lang: L | "zh" | "es"): ResolvedTemplate[] => {
  const l: L = lang === "vi" ? "vi" : "en";
  return TEMPLATES.map((x) => {
    const environment: Environment = x.environment ?? { kind: "assistant" };
    const config = normalizeConfig({
      inputs: (x.inputs ?? []).map((f) => ({
        key: f.key,
        label: f.label[l],
        type: f.type ?? "text",
        ...(f.options ? { options: f.options[l] } : {}),
        ...(f.required ? { required: true } : {}),
        ...(f.placeholder ? { placeholder: f.placeholder[l] } : {}),
        ...(f.default ? { default: f.default[l] } : {}),
      })),
      environment,
      resources: { notes: x.notes?.[l] ?? "", taskContext: true, taskFiles: x.taskFiles === true },
      guardrails: x.guardrails ?? {},
      output: x.output ?? {},
    });
    return {
      key: x.key,
      category: x.category,
      runner: runnerOf(config.environment),
      name: x.name[l],
      description: x.description[l],
      uses: x.uses[l],
      config,
      // As a save would store them (model.ts normalizeSteps): defaults written out, each kind with its own fields.
      steps: normalizeSteps(
        x.steps.map(({ title, prompt, role, criteria, ...rest }) => ({
          ...rest,
          title: title[l],
          ...(prompt ? { prompt: prompt[l] } : {}),
          ...(role ? { role: role[l] } : {}),
          ...(criteria ? { criteria: criteria[l] } : {}),
        })),
        config.environment,
      ),
    };
  });
};
