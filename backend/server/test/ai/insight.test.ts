import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import { classifyTopic, detectSensitive, maskForReader, redact, redactWithCounts, sourceFromHost, SOURCES, titleFrom } from "../../src/modules/ai/insight.js";

describe("classifyTopic", () => {
  it("reads Vietnamese and English prompts", () => {
    expect(classifyTopic("Sửa giúp mình lỗi TypeScript trong hàm này")).toBe("code");
    expect(classifyTopic("Dịch đoạn này sang tiếng Anh giúp tôi")).toBe("translation");
    expect(classifyTopic("Viết công thức Excel tính doanh thu theo tháng")).toBe("analysis");
    expect(classifyTopic("Soạn email báo giá cho khách hàng Nhật Minh")).toBe("sales");
    expect(classifyTopic("Viết JD tuyển dụng lập trình viên backend")).toBe("code");
    expect(classifyTopic("Write a JD for a recruiter role")).toBe("hr");
    expect(classifyTopic("Lập kế hoạch ra mắt sản phẩm quý 4")).toBe("planning");
    expect(classifyTopic("Soạn thông báo nghỉ Tết cho công ty")).toBe("writing");
    expect(classifyTopic("Blockchain là gì?")).toBe("research");
    expect(classifyTopic("xin chào")).toBe("other");
  });
});

describe("detectSensitive", () => {
  it("flags ID numbers, cards (Luhn), secrets, many contacts and bank accounts", () => {
    expect(detectSensitive("CCCD của khách: 079203001234")).toContain("personal_id");
    expect(detectSensitive("thẻ 4111 1111 1111 1111 hết hạn 12/28")).toContain("card");
    expect(detectSensitive("số 4111 1111 1111 1112")).not.toContain("card");
    expect(detectSensitive("dùng key sk-proj-abcdefghijklmnopqrstu để gọi")).toContain("secret");
    expect(detectSensitive("password: Hunter2024!")).toContain("secret");
    // An empty password, or a stand-in for one, is not a secret; one on the next line is not this one's value.
    for (const empty of [
      'password: ""',
      "password=''",
      "password:\nhost: db",
      "password: \nusername: admin",
      "password: (empty)",
      "mật khẩu: để trống",
      "password: ***",
      "password: <your password>",
      "password: [SECRET]",
      "password: null",
      "DB_PASSWORD=\nDB_USER=root",
      '{"password": "", "user": "a"}',
    ])
      expect(detectSensitive(empty), empty).not.toContain("secret");
    // Written as code or config, it still is.
    for (const set of ["DB_PASSWORD=Hunter2024", '{"password": "Hunter2024"}', "password = 'Hunter2024'", "mật khẩu: abc123"])
      expect(detectSensitive(set), set).toContain("secret");
    expect(detectSensitive("a@x.vn, b@y.vn, 0912345678")).toContain("contacts");
    expect(detectSensitive("STK 0123456789 Vietcombank")).toContain("bank_account");
    expect(detectSensitive("Viết email chúc mừng sinh nhật")).toEqual([]);
  });

  it("knows ID numbers, bank details, phones and tokens from outside Vietnam", () => {
    expect(detectSensitive("SSN 123-45-6789")).toEqual(["personal_id"]);
    expect(detectSensitive("social security number: 123 45 6789")).toEqual(["personal_id"]);
    expect(detectSensitive("passport number C1234567")).toEqual(["personal_id"]);
    expect(detectSensitive("NRIC S1234567A")).toEqual(["personal_id"]);
    expect(detectSensitive("NI number AB123456C")).toEqual(["personal_id"]);
    expect(detectSensitive("national id number 1234567890")).toEqual(["personal_id"]);
    expect(detectSensitive("IBAN GB82 WEST 1234 5698 7654 32")).toEqual(["bank_account"]);
    expect(detectSensitive("DE89370400440532013000")).toEqual(["bank_account"]);
    expect(detectSensitive("GB82 WEST 1234 5698 7654 33")).toEqual([]);
    expect(detectSensitive("routing number 021000021, account number 123456789012")).toEqual(["bank_account"]);
    expect(detectSensitive("SWIFT/BIC: BFTVVNVX")).toEqual(["bank_account"]);
    expect(detectSensitive("SWIFT TRANSFER DONE")).toEqual([]);
    expect(detectSensitive("call +1 555 123 4567, +44 20 7946 0958 or +84 912 345 678")).toEqual(["contacts"]);
    expect(detectSensitive("+84912345678 and 0912345678")).toEqual([]);
    expect(detectSensitive("github_pat_11ABCDEFG0123456789abcdefghij")).toEqual(["secret"]);
    expect(detectSensitive("glpat-abcdefghijklmnopqrst")).toEqual(["secret"]);
    expect(detectSensitive("sk_live_abcdefghijklmnop")).toEqual(["secret"]);
    expect(detectSensitive("xapp-1-A0123456789-abc")).toEqual(["secret"]);
    expect(detectSensitive("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c")).toEqual(["secret"]);
    expect(detectSensitive("-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----")).toEqual(["secret"]);
    // Plain long numbers without context are not IDs: order numbers, dates, timestamps.
    expect(detectSensitive("order 123456789012345 shipped 20261026, ts 1730000000")).toEqual([]);
    expect(detectSensitive("ssn is not needed here")).toEqual([]);
  });
});

describe("titleFrom / sourceFromHost", () => {
  it("keeps the first line short and maps hosts to tools", () => {
    expect(titleFrom("Viết email\nchi tiết thêm")).toBe("Viết email");
    expect(titleFrom("a ".repeat(60)).length).toBeLessThanOrEqual(81);
    expect(sourceFromHost("chatgpt.com")).toBe("chatgpt");
    expect(sourceFromHost("claude.ai")).toBe("claude");
    expect(sourceFromHost("gemini.google.com")).toBe("gemini");
    expect(sourceFromHost("www.perplexity.ai")).toBe("perplexity");
    expect(sourceFromHost("chat.deepseek.com")).toBe("deepseek");
    expect(sourceFromHost("grok.com")).toBe("grok");
    expect(sourceFromHost("copilot.com")).toBe("copilot");
    expect(sourceFromHost("m365.cloud.microsoft")).toBe("copilot");
    expect(sourceFromHost("www.meta.ai")).toBe("meta");
    expect(sourceFromHost("poe.com")).toBe("poe");
    expect(sourceFromHost("chat.qwen.ai")).toBe("qwen");
    expect(sourceFromHost("www.kimi.com")).toBe("kimi");
    expect(sourceFromHost("www.doubao.com")).toBe("doubao");
    expect(sourceFromHost("you.com")).toBe("you");
    expect(sourceFromHost("huggingface.co")).toBe("huggingchat");
    expect(sourceFromHost("chat.z.ai")).toBe("zai");
    expect(sourceFromHost("duck.ai")).toBe("duckai");
    expect(sourceFromHost("example.com")).toBe("other");
  });

  it("names every host the browser extension reads (frontend/browser-extension/sites.js)", () => {
    const { WORKSPACE_AI_SITES } = createRequire(import.meta.url)("../../../../frontend/browser-extension/sites.js") as { WORKSPACE_AI_SITES: { id: string; hosts: string[] }[] };
    expect(WORKSPACE_AI_SITES.length).toBeGreaterThanOrEqual(10);
    for (const site of WORKSPACE_AI_SITES) {
      expect(SOURCES).toContain(site.id);
      for (const host of site.hosts) expect(`${host}: ${sourceFromHost(host)}`).toBe(`${host}: ${site.id}`);
    }
  });
});

describe("redact", () => {
  it("masks what a manager must not read in a title", () => {
    expect(titleFrom("Sửa lỗi kết nối DB, password: Hunter2024!")).toBe("Sửa lỗi kết nối DB, password: [SECRET]");
    expect(redact("key sk-proj-abcdefghijklmnopqrstu ok")).toBe("key [SECRET] ok");
    expect(redact("gửi cho lan@nhatminh.vn")).toBe("gửi cho [EMAIL]");
    expect(redact("CCCD 079203001234")).toBe("CCCD [CCCD]");
    expect(redact("thẻ 4111 1111 1111 1111")).toBe("thẻ [CARD]");
    expect(redact("Viết email chúc mừng sinh nhật")).toBe("Viết email chúc mừng sinh nhật");
    expect(maskForReader("mã đơn 123456789012345")).not.toMatch(/\d{6}/);
  });

  it("replaces each kind with its placeholder and counts it", () => {
    const r = redactWithCounts("Khách Sao Mai, CCCD 079203001234, thẻ 4111 1111 1111 1111, STK 0123456789, gọi 0912345678 hoặc lan@nhatminh.vn", ["sao mai"]);
    expect(r.text).toBe("Khách [KEYWORD], CCCD [CCCD], thẻ [CARD], STK [STK], gọi [PHONE] hoặc [EMAIL]");
    expect(r.counts).toEqual({ keyword: 1, personal_id: 1, card: 1, bank_account: 1, contacts: 2 });
    expect(redactWithCounts("số 4111 1111 1111 1112 không phải thẻ").counts).toEqual({});
  });

  it("uses [ID], [IBAN] and [ACCOUNT] for the international forms and keeps [CCCD] and [STK] for the Vietnamese ones", () => {
    expect(redact("SSN 123-45-6789, passport number C1234567, NRIC S1234567A")).toBe("SSN [ID], passport number [ID], NRIC [ID]");
    expect(redact("passport 123456789")).toBe("passport [CCCD]");
    expect(redact("IBAN GB82 WEST 1234 5698 7654 32 or DE89370400440532013000")).toBe("IBAN [IBAN] or [IBAN]");
    expect(redact("GB82 WEST 1234 5698 7654 33")).toBe("GB82 WEST 1234 5698 7654 33");
    expect(redact("routing number 021000021, account number 123456789012, STK 0123456789")).toBe("routing number [ACCOUNT], account number [ACCOUNT], STK [STK]");
    expect(redact("Swift code BFTVVNVXXXX")).toBe("Swift code [ACCOUNT]");
    expect(redact("call +1 555 123 4567 or +84 912 345 678")).toBe("call [PHONE] or [PHONE]");
    expect(redact("token github_pat_11ABCDEFG0123456789abcdefghij, sk_live_abcdefghijklmnop")).toBe("token [SECRET], [SECRET]");
    const r = redactWithCounts("SSN 123-45-6789, IBAN DE89370400440532013000, +1 555 123 4567, glpat-abcdefghijklmnopqrst");
    expect(r.counts).toEqual({ personal_id: 1, bank_account: 1, contacts: 1, secret: 1 });
  });

  it("matches company keywords as whole words, case-insensitive, longest first", () => {
    expect(detectSensitive("Báo giá cho SAO MAI", ["Sao Mai"])).toEqual(["keyword"]);
    expect(detectSensitive("saomai", ["Sao Mai"])).toEqual([]);
    expect(redact("Dự án Sao Mai 2 và Sao Mai", ["Sao Mai", "Sao Mai 2"])).toBe("Dự án [KEYWORD] và [KEYWORD]");
    expect(redact("giá (c++) ok", ["c++"])).toBe("giá ([KEYWORD]) ok");
  });
});

describe("national IDs and phones from China, Spain, Mexico and Brazil", () => {
  const valid = ["身份证 11010519491231002X", "DNI 12345678Z", "NIE X-1234567-L", "CURP GODE561231HDFRRN09", "RFC GODE561231GR8", "CPF 529.982.247-25", "CPF 52998224725"];
  it("flags and redacts valid ones", () => {
    for (const s of valid) {
      expect(detectSensitive(s), s).toContain("personal_id");
      expect(redactWithCounts(s).text, s).toContain("[ID]");
    }
  });
  it("leaves numbers that fail the check alone", () => {
    for (const s of ["身份证 110105194912310021", "DNI 12345678A", "CPF 529.982.247-26", "order 20261109 shipped", "call 12345678901"]) {
      expect(detectSensitive(s), s).not.toContain("personal_id");
      expect(redactWithCounts(s).text, s).not.toContain("[ID]");
    }
  });
  it("counts Chinese mobile numbers as contacts and redacts them", () => {
    expect(detectSensitive("13812345678, 13987654321, 15011112222")).toContain("contacts");
    expect(redactWithCounts("手机 13812345678").text).toBe("手机 [PHONE]");
    expect(redactWithCounts("+86 138 1234 5678").text).toBe("[PHONE]");
  });
});

describe("secrets, contacts and ids written as config, code or a form", () => {
  // Left empty, or filled with a stand-in, nothing is sensitive; a value on the next line belongs to the next field.
  const clean = [
    // empty / placeholder secrets
    "SECRET_KEY=\nDEBUG=true",
    'secret_key: ""',
    "api_key: <your api key>",
    "API_KEY=your-api-key-here",
    "client_secret: ${CLIENT_SECRET}",
    "token: {{token}}",
    "AWS_SECRET_ACCESS_KEY=\nAWS_REGION=ap-southeast-1",
    "SMTP_PASSWORD=\nSMTP_USER=",
    "OPENAI_API_KEY=sk-...",
    "Authorization: Bearer <token>",
    "Authorization: Bearer $TOKEN",
    "postgres://user:password@localhost:5432/db",
    "postgres://postgres@localhost/db",
    "mongodb://<user>:<password>@host/db",
    "-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----",
    "-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----",
    "JWT_SECRET=changeme",
    "password: ${DB_PASSWORD}",
    "pwd: /home/user",
    // emails / phones placeholders
    "email: \nphone: \naddress: ",
    "SĐT: 0900000000, 0123456789, 0999999999",
    // ids / bank empty
    "CCCD: \nHọ tên: Lan",
    "STK: \nNgân hàng: VCB\nSố tiền: 1500000000",
    "Số CCCD: ____________",
    "passport: \nexpiry 2030123456",
    "account number: \namount 12345678901",
    "id number:\n Order 123456789",
    // normal text
    "The secret: be kind to people",
    "Key: the main point is speed",
    "Token: we use tokens for billing, 1500000 tokens per month",
    "Phiên bản 2026.11.16, build 1234567890123",
    "Viết email chúc mừng sinh nhật",
  ];
  // Real ones, in the shapes people paste: .env, JSON, YAML, headers, URLs, provider keys.
  const hot = [
    "SECRET_KEY=django-insecure-8f3k2l9x0q7w",
    "secret_key: 'a8F3kL9xQ2'",
    "client_secret=GOCSPX-abcdefghijklmnopqrstuvwx",
    "api_key: 9f8e7d6c5b4a3f2e1d0c",
    "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    "SMTP_PASSWORD=Mail2024pass",
    "Authorization: Bearer abcdef1234567890abcdef",
    "postgres://app:S3cr3tPw@db.internal:5432/prod",
    "https://user:hunter22@git.company.vn/repo.git",
    "SG" + ".abcdefghijklmnopqrstuv.abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG",
    "hf_abcdefghijklmnopqrstuvwxyzABCDEF",
    "npm_abcdefghijklmnopqrstuvwxyz0123456789",
    "https://hooks.slack.com/services/T000/B000/XXXXXXXXXXXXXXXXXXXXXXXX",
    "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
    "bot token 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw",
    "dop" + "_v1_abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789",
    "shpat" + "_abcdef0123456789abcdef0123456789",
    "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA7\n-----END RSA PRIVATE KEY-----",
    "token: ghp_abcdefghijklmnopqrstuvwxyz0123456789",
    "a@acme.vn, b@acme.vn, c@acme.vn",
    "CCCD: 079203001234",
    "STK 0123456789 Vietcombank",
  ];
  it("an empty field or a stand-in is not sensitive", () => {
    for (const t of clean) expect(detectSensitive(t), t).toEqual([]);
  });
  it("a real key, secret, token or password is", () => {
    for (const t of hot) expect(detectSensitive(t).length, t).toBeGreaterThan(0);
  });
  it("only the value is masked; the name of the field stays", () => {
    expect(redact("SECRET_KEY=django-insecure-8f3k2l9x0q7w\nDEBUG=true")).toBe("SECRET_KEY=[SECRET]\nDEBUG=true");
    expect(redact('{"api_key": "9f8e7d6c5b4a3f2e1d0c", "user": "a"}')).toBe('{"api_key": "[SECRET]", "user": "a"}');
    expect(redact("Authorization: Bearer abcdef1234567890abcdef")).toBe("Authorization: Bearer [SECRET]");
    expect(redact("postgres://app:S3cr3tPw@db.internal:5432/prod")).toBe("postgres://app:[SECRET]@db.internal:5432/prod");
    expect(redact("SECRET_KEY=\nemail: a@acme.vn")).toBe("SECRET_KEY=\nemail: [EMAIL]");
  });
});
