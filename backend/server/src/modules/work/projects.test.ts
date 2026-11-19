import { describe, expect, it } from "vitest";
import { columnStatusFor } from "./projects.js";

describe("columnStatusFor", () => {
  it("reads the status from the column's name in Vietnamese or English", () => {
    expect(columnStatusFor("Cần làm", 0, 4)).toBe("todo");
    expect(columnStatusFor("Backlog", 0, 4)).toBe("todo");
    expect(columnStatusFor("Đang làm", 1, 4)).toBe("in_progress");
    expect(columnStatusFor("Doing", 1, 4)).toBe("in_progress");
    expect(columnStatusFor("Chờ khách duyệt", 2, 4)).toBe("review");
    expect(columnStatusFor("QA", 2, 4)).toBe("review");
    expect(columnStatusFor("Xong", 3, 4)).toBe("done");
    expect(columnStatusFor("Released", 3, 4)).toBe("done");
  });

  it("falls back to the column's place: first to do, last done, in between in progress", () => {
    expect(columnStatusFor("Ý tưởng", 0, 3)).toBe("todo");
    expect(columnStatusFor("Thiết kế", 1, 3)).toBe("in_progress");
    expect(columnStatusFor("Lưu trữ", 2, 3)).toBe("done");
  });
});
