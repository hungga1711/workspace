import { describe, expect, it } from "vitest";
import { checkBulk, parseBulk } from "./bulk";

describe("parseBulk", () => {
  it("reads comma, semicolon and tab separated lines, skipping a header and blank lines", () => {
    expect(parseBulk('Email,Họ tên,Vai trò\r\nlan@x.vn, Nguyễn Thị Lan\n\nminh@x.vn;Trần Minh;Manager\nha@x.vn\t"Vũ Hà"\tAdmin')).toEqual([
      { email: "lan@x.vn", displayName: "Nguyễn Thị Lan" },
      { email: "minh@x.vn", displayName: "Trần Minh", roleName: "Manager" },
      { email: "ha@x.vn", displayName: "Vũ Hà", roleName: "Admin" },
    ]);
  });
  it("keeps incomplete rows so the server can report them", () => {
    expect(parseBulk("chi-co-email@x.vn")).toEqual([{ email: "chi-co-email@x.vn", displayName: "" }]);
  });
});

describe("parseBulk with department and manager", () => {
  it("reads the optional fourth and fifth columns", () => {
    expect(parseBulk("ana@x.com,Ana Ruiz,Employee,Sales,boss@x.com")).toEqual([
      { email: "ana@x.com", displayName: "Ana Ruiz", roleName: "Employee", department: "Sales", manager: "boss@x.com" },
    ]);
  });
});

describe("checkBulk", () => {
  const ctx = {
    roles: ["Employee", "Manager"],
    departments: [{ id: "d1", name: "Sales" }],
    people: [{ userId: "u1", email: "boss@x.com", displayName: "Bo Boss" }],
  };
  it("resolves department and manager case-insensitively, by email or name", () => {
    const [a, b] = checkBulk(
      [
        { email: "ana@x.com", displayName: "Ana", department: "sales", manager: "BOSS@x.com" },
        { email: "bo@x.com", displayName: "Bo", manager: "bo boss" },
      ],
      ctx,
    );
    expect(a).toMatchObject({ errors: [], departmentId: "d1", managerId: "u1" });
    expect(b).toMatchObject({ errors: [], managerId: "u1" });
  });
  it("flags every problem on the row before sending", () => {
    const [r1, r2, r3] = checkBulk(
      [
        { email: "not-an-email", displayName: "", roleName: "Boss", department: "Legal", manager: "ghost@x.com" },
        { email: "boss@x.com", displayName: "Again" },
        { email: "new@x.com", displayName: "New" },
      ],
      ctx,
    );
    expect(r1!.errors).toEqual(["invalid_email", "missing_name", "unknown_role", "unknown_department", "unknown_manager"]);
    expect(r2!.errors).toEqual(["already_member"]);
    expect(r3!.errors).toEqual([]);
  });
  it("accepts a manager who is invited in the same file, and catches duplicate rows", () => {
    const rows = checkBulk(
      [
        { email: "lead@x.com", displayName: "Lead" },
        { email: "dev@x.com", displayName: "Dev", manager: "lead@x.com" },
        { email: "dev@x.com", displayName: "Dev 2" },
      ],
      ctx,
    );
    expect(rows.map((r) => r.errors)).toEqual([[], [], ["duplicate_row"]]);
  });
});
