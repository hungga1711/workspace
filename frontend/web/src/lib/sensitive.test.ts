import { describe, expect, it } from "vitest";
import { detectSensitive, redactWithCounts } from "./sensitive";

// The same cases as backend/server/test/ai/insight.test.ts: this copy must give the same answers as the server.
describe("detectSensitive (web copy of the server rules)", () => {
  it("flags Vietnamese and international forms", () => {
    expect(detectSensitive("CCCD của khách: 079203001234")).toEqual(["personal_id"]);
    expect(detectSensitive("thẻ 4111 1111 1111 1111 hết hạn 12/28")).toEqual(["card"]);
    expect(detectSensitive("số 4111 1111 1111 1112")).toEqual([]);
    expect(detectSensitive("password: Hunter2024!")).toEqual(["secret"]);
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
    expect(detectSensitive("a@x.vn, b@y.vn, 0912345678")).toEqual(["contacts"]);
    expect(detectSensitive("STK 0123456789 Vietcombank")).toEqual(["bank_account"]);
    expect(detectSensitive("SSN 123-45-6789")).toEqual(["personal_id"]);
    expect(detectSensitive("passport number C1234567")).toEqual(["personal_id"]);
    expect(detectSensitive("NRIC S1234567A and NI number AB123456C")).toEqual(["personal_id"]);
    expect(detectSensitive("IBAN GB82 WEST 1234 5698 7654 32")).toEqual(["bank_account"]);
    expect(detectSensitive("GB82 WEST 1234 5698 7654 33")).toEqual([]);
    expect(detectSensitive("routing number 021000021")).toEqual(["bank_account"]);
    expect(detectSensitive("SWIFT/BIC: BFTVVNVX")).toEqual(["bank_account"]);
    expect(detectSensitive("SWIFT TRANSFER DONE")).toEqual([]);
    expect(detectSensitive("call +1 555 123 4567, +44 20 7946 0958 or +84 912 345 678")).toEqual(["contacts"]);
    expect(detectSensitive("github_pat_11ABCDEFG0123456789abcdefghij")).toEqual(["secret"]);
    expect(detectSensitive("eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c")).toEqual(["secret"]);
    expect(detectSensitive("Báo giá cho SAO MAI", ["Sao Mai"])).toEqual(["keyword"]);
    expect(detectSensitive("order 123456789012345 shipped 20261026")).toEqual([]);
    expect(detectSensitive("Viết email chúc mừng sinh nhật")).toEqual([]);
  });

  it("redacts with the server's placeholders and counts", () => {
    const r = redactWithCounts("Khách Sao Mai, CCCD 079203001234, thẻ 4111 1111 1111 1111, STK 0123456789, gọi 0912345678 hoặc lan@nhatminh.vn", ["sao mai"]);
    expect(r.text).toBe("Khách [KEYWORD], CCCD [CCCD], thẻ [CARD], STK [STK], gọi [PHONE] hoặc [EMAIL]");
    expect(r.counts).toEqual({ keyword: 1, personal_id: 1, card: 1, bank_account: 1, contacts: 2 });
    expect(redactWithCounts("SSN 123-45-6789, IBAN DE89370400440532013000, account number 123456789012, +1 555 123 4567, glpat-abcdefghijklmnopqrst")).toEqual({
      text: "SSN [ID], IBAN [IBAN], account number [ACCOUNT], [PHONE], [SECRET]",
      counts: { personal_id: 1, bank_account: 2, contacts: 1, secret: 1 },
    });
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
  const redact = (t: string) => redactWithCounts(t).text;
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
