import { describe, expect, it } from "vitest";
import { docRefs, mentionsCode, minShared, taskTerms } from "./related.js";

describe("related: task words", () => {
  it("folds accents and drops function words, numbers and repeats", () => {
    expect(taskTerms("Sửa lỗi đăng nhập trên iOS 17", ["mobile"])).toEqual(["loi", "dang", "nhap", "ios", "mobile"]);
    expect(taskTerms("Fix the login page for the login flow")).toEqual(["login", "page", "flow"]);
    expect(taskTerms("")).toEqual([]);
  });

  it("asks a long title to share more words", () => {
    expect(minShared(1)).toBe(1);
    expect(minShared(3)).toBe(2);
    expect(minShared(8)).toBe(4);
  });
});

describe("related: references", () => {
  it("finds document links and codes in text", () => {
    const r = docRefs("See TL-012 and /app/work/docs/01ARZ3NDEKTSV4RRFFQ69G5FAV, not utf-8 or xTL-9.");
    expect(r.ids).toEqual(["01ARZ3NDEKTSV4RRFFQ69G5FAV"]);
    expect(r.codes).toEqual(["TL-012"]);
  });

  it("matches a task code as a word only", () => {
    expect(mentionsCode("WEB-42 is broken", "WEB-42")).toBe(true);
    expect(mentionsCode("about web-42?", "WEB-42")).toBe(true);
    expect(mentionsCode("WEB-420 is another", "WEB-42")).toBe(false);
    expect(mentionsCode("XWEB-42", "WEB-42")).toBe(false);
    expect(mentionsCode("WEB-42-3", "WEB-42")).toBe(false);
  });
});
