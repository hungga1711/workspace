import { describe, expect, it } from "vitest";
import { parseCsv } from "@/lib/csv";
import { mapPriority, mapStatus, parseDue, planImport, planTrelloJson } from "./importTasks";

const people = [
  { userId: "u-lan", displayName: "Nguyễn Lan", email: "lan@congty.vn" },
  { userId: "u-huy", displayName: "Trần Huy", email: "huy@congty.vn" },
];

describe("CSV", () => {
  it("handles quotes, commas and newlines inside cells, CRLF and a BOM", () => {
    expect(parseCsv('﻿a,b\r\n"x, y","say ""hi""\nthere"\r\n')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
    ]);
  });
  it("reads semicolon-separated files (Excel in Vietnamese locale)", () => {
    expect(parseCsv("Tiêu đề;Hạn\nA;01/02/2027")).toEqual([
      ["Tiêu đề", "Hạn"],
      ["A", "01/02/2027"],
    ]);
  });
});

describe("planning an import", () => {
  it("reads a Jira export", () => {
    const csv =
      "Issue key,Issue Type,Summary,Status,Priority,Assignee,Due Date,Labels\nWEB-1,Task,Trang giá,Done,High,lan@congty.vn,15/Oct/26 10:00 AM,web\nWEB-2,Bug,Lỗi đăng nhập,In Progress,Highest,Someone Else,,";
    const p = planImport(csv, people);
    expect(p.system).toBe("jira");
    expect(p.tasks[0]).toMatchObject({ title: "Trang giá", status: "done", priority: "high", assigneeId: "u-lan", key: "WEB-1", labels: ["web"] });
    expect(p.tasks[0]!.dueAt).toBe("2026-10-15T10:00:00.000Z");
    expect(p.tasks[1]).toMatchObject({ status: "in_progress", priority: "urgent", assigneeId: null });
    expect(p.unknownPeople).toEqual(["Someone Else"]);
  });

  it("reads Trello's JSON export: lists become statuses, archived cards are done, members match by name", () => {
    const json = JSON.stringify({
      lists: [
        { id: "l1", name: "To Do" },
        { id: "l2", name: "Doing" },
      ],
      members: [{ id: "m1", fullName: "Trần Huy", username: "huy" }],
      cards: [
        { name: "Thiết kế logo", desc: "Logo mới", idList: "l2", idMembers: ["m1"], due: "2026-11-01T03:00:00.000Z", labels: [{ name: "design" }], idShort: 12 },
        { name: "Việc cũ", idList: "l1", closed: true, idMembers: ["nobody"] },
        { name: "   ", idList: "l1" },
      ],
    });
    const p = planTrelloJson(json, people)!;
    expect(p.system).toBe("trello");
    expect(p.tasks).toHaveLength(2);
    expect(p.tasks[0]).toMatchObject({ title: "Thiết kế logo", status: "in_progress", assigneeId: "u-huy", labels: ["design"], key: "#12" });
    expect(p.tasks[1]).toMatchObject({ status: "done", assigneeId: null });
    expect(p.skipped).toBe(1);
    expect(planTrelloJson('{"foo":1}', people)).toBeNull();
    expect(planTrelloJson("not json", people)).toBeNull();
  });

  it("reads a Trello export and a Vietnamese spreadsheet", () => {
    const trello = planImport("Card ID,Card Name,List Name,Members,Due Date\nc1,Thiết kế logo,Doing,Trần Huy,2026-11-01T03:00:00.000Z", people);
    expect(trello.system).toBe("trello");
    expect(trello.tasks[0]).toMatchObject({ title: "Thiết kế logo", status: "in_progress", assigneeId: "u-huy" });
    const vn = planImport("Tiêu đề,Trạng thái,Người làm,Hạn chót\nGửi báo giá,Xong,nguyen lan,20/11/2026\n,,,\n", people);
    expect(vn.system).toBe("csv");
    expect(vn.tasks).toHaveLength(1);
    expect(vn.tasks[0]).toMatchObject({ status: "done", assigneeId: "u-lan" });
    expect(vn.tasks[0]!.dueAt?.slice(0, 10)).toBe("2026-11-20");
  });

  it("maps statuses, priorities and dates conservatively", () => {
    expect(mapStatus("To Do")).toBe("todo");
    expect(mapStatus("Code Review")).toBe("review");
    expect(mapStatus("Đang làm")).toBe("in_progress");
    expect(mapPriority("Lowest")).toBe("low");
    expect(mapPriority("")).toBe("medium");
    expect(parseDue("not a date")).toBeNull();
  });
});
