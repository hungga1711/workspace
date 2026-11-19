import { z } from "zod";
import { defineEvent, id, ids } from "./define.js";

const member = z.object({ userId: id, email: z.string(), displayName: z.string() });

export const identityEvents = {
  "identity.member.joined.v1": defineEvent({
    aggregateType: "identity.member",
    summary: "A person is now an active member (the owner at setup, or an invitee's first sign-in)",
    intent: "projection",
    payload: member.extend({ owner: z.boolean().optional() }),
  }),
  "identity.member.invited.v1": defineEvent({
    aggregateType: "identity.member",
    summary: "An invitation was sent; profile and channel membership can exist before the first sign-in",
    intent: "projection",
    payload: member,
  }),
  "identity.member.renamed.v1": defineEvent({
    aggregateType: "identity.member",
    summary: "A member changed their full name; projections that copy names (employee profile, people search) follow",
    intent: "projection",
    payload: member,
  }),
  "identity.member.enabled.v1": defineEvent({
    aggregateType: "identity.member",
    summary: "A disabled member was re-activated",
    intent: "projection",
    payload: z.object({ userId: id }),
  }),
  "identity.member.disabled.v1": defineEvent({
    aggregateType: "identity.member",
    summary: "A member was offboarded: sessions end, profile becomes inactive",
    intent: "projection",
    payload: z.object({ userId: id }),
  }),
  "identity.team.deleted.v1": defineEvent({
    aggregateType: "identity.team",
    summary: "A team was deleted; projects and tasks that carried it lose their team (TEAM-scope grants no longer apply)",
    intent: "projection",
    payload: z.object({ teamId: id, name: z.string() }),
  }),
  "identity.member.roles_changed.v1": defineEvent({
    aggregateType: "identity.member",
    summary: "A member's roles changed (audit trail; grants apply on the next request without it)",
    intent: "audit",
    payload: z.object({ userId: id, roleIds: ids }),
  }),
};
