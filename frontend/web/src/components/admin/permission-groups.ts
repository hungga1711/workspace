import type { MessageKey, T } from "@/lib/i18n/core";

/**
 * Permissions grouped the way a company thinks about them (people, work, docs, chat, AI, company), each with a plain
 * name and one line on what it allows (i18n `admin.perms.*`). Shared by the roles screen and its summary.
 */
export const PERM_AREAS: { key: "people" | "work" | "docs" | "chat" | "ai" | "company"; perms: string[] }[] = [
  {
    key: "people",
    perms: [
      "member.read",
      "member.invite",
      "member.manage",
      "employee.profile.read",
      "employee.profile.edit",
      "employee.salary.read",
      "attendance.read",
      "attendance.record",
      "leave.request",
      "leave.approve",
    ],
  },
  {
    key: "work",
    perms: [
      "project.read",
      "project.create",
      "project.edit",
      "project.delete",
      "task.read",
      "task.create",
      "task.edit",
      "task.assign",
      "task.delete",
      "approval.decide",
      "calendar.read",
      "calendar.edit",
    ],
  },
  { key: "docs", perms: ["document.read", "document.create", "document.edit", "document.share", "file.read", "file.upload"] },
  { key: "chat", perms: ["channel.read", "channel.create", "channel.manage", "message.read", "message.post", "message.delete_any", "announcement.publish", "notification.create"] },
  { key: "ai", perms: ["ai.use", "agent.invoke", "ai.prompt.manage", "ai.agent.manage", "ai.policy.manage"] },
  { key: "company", perms: ["home.read", "workspace.read", "workspace.configure", "role.manage", "audit.read"] },
];

/** Permissions a role summary calls out when missing: the ones that decide what is private. */
export const SENSITIVE = [
  "employee.salary.read",
  "audit.read",
  "workspace.configure",
  "member.manage",
  "role.manage",
  "ai.policy.manage",
  "message.delete_any",
  "attendance.read",
  "leave.approve",
];

const id = (perm: string) => perm.replace(/\./g, "_");
export const permLabel = (tx: T, perm: string) => {
  const key = `admin.perms.${id(perm)}.label` as MessageKey;
  const v = tx(key);
  return v === key ? perm : v;
};
export const permDesc = (tx: T, perm: string) => {
  const key = `admin.perms.${id(perm)}.desc` as MessageKey;
  const v = tx(key);
  return v === key ? "" : v;
};

type Grants = Record<string, string>;
const W = (...p: string[]): Grants => Object.fromEntries(p.map((x) => [x, "WORKSPACE"]));
const S = (scope: string, ...p: string[]): Grants => Object.fromEntries(p.map((x) => [x, scope]));

/**
 * Starting points for new roles, on top of the Employee basics everyone holds. Intern and Contractor add nothing that
 * matters: they exist so these people can be told apart in Progress and reports.
 */
export const ROLE_TEMPLATES: { key: "accountant" | "hr" | "lead" | "intern" | "contractor"; grants: Grants }[] = [
  { key: "accountant", grants: W("approval.decide", "employee.salary.read", "attendance.read", "project.read", "task.read") },
  {
    key: "hr",
    grants: W(
      "member.invite",
      "member.manage",
      "employee.profile.read",
      "employee.profile.edit",
      "employee.salary.read",
      "attendance.read",
      "leave.approve",
      "announcement.publish",
    ),
  },
  {
    key: "lead",
    grants: {
      ...S("TEAM", "task.edit", "task.assign", "task.delete", "project.edit", "approval.decide", "leave.approve", "attendance.read", "calendar.read"),
      ...S("DEPARTMENT", "ai.prompt.manage"),
    },
  },
  { key: "intern", grants: S("SELF", "home.read") },
  { key: "contractor", grants: S("SELF", "home.read") },
];
