import type { Metadata } from "next";
import { gw } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";
import { TaskOnlyChat } from "@/components/workflows/TaskOnlyChatLazy";
import { AssistantView, type AssistantModel, type ConversationRow } from "@/components/ai/AssistantView";
import { aiStatus } from "@/lib/ai";
import { freshSession } from "@/lib/session";
import { progressAccess } from "@/lib/viewer";
import type { WelcomeServer, WelcomeTask, WelcomeWorkflow } from "@/components/ai/AskWelcome";
import type { PendingCard, Source, ToolChip } from "@/components/ai/mention-types";
import type { AskRef } from "@/components/ai/AskExtras";
import { readBlocks } from "@/components/ai/answer/types";
import { monogramOf } from "@/lib/mcp-gallery";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("aiw.chat.title") };
}

/** AI › Hỏi đáp: the company's own AI chat, which can look things up across the workspace as the asker. ?c= opens a conversation; ?q= fills the composer (and with send=1 sends it, about the task in ?task=). */
export default async function AssistantPage({ searchParams }: { searchParams: Promise<{ c?: string; q?: string; send?: string; task?: string }> }) {
  const { c, q, send, task } = await searchParams;
  const ai = await aiStatus();
  // Without a connected AI, Hỏi đáp still drafts tasks from requests (by rules); questions need a model.
  // `off`: a model is connected but the workspace switched AI off (Admin › AI).
  if (!ai.assistant) return <TaskOnlyChat admin={await isAdmin()} off={ai.configured} />;
  const [session, models, list, open, mine, flows, tools, access] = await Promise.all([
    freshSession(),
    gw<{ models: AssistantModel[] }>("/api/ai/assistant/models").catch(() => ({ models: [] as AssistantModel[] })),
    gw<{ conversations: ConversationRow[]; policy: { detail: "topic" | "summary" } }>("/api/ai/assistant/conversations").catch(() => ({
      conversations: [] as ConversationRow[],
      policy: { detail: "summary" as const },
    })),
    c && /^[0-9A-HJKMNP-TV-Z]{26}$/.test(c)
      ? gw<{
          messages: {
            id: string;
            role: "user" | "assistant";
            content: string;
            at: string;
            toolCalls?: ToolChip[] | null;
            sources?: Source[] | null;
            blocks?: unknown;
            files?: { id: string; name: string; contentType: string; size: number; kind: "image" | "file" }[];
            refs?: AskRef[];
            /** A confirm card still waiting for the person's answer. */
            confirm?: PendingCard;
          }[];
        }>(`/api/ai/assistant/conversations/${c}`).catch(() => null)
      : Promise.resolve(null),
    // The empty screen's extras: a failed read only leaves them out.
    gw<{ open: WelcomeTask[] }>("/api/work/me/summary").catch(() => ({ open: [] as WelcomeTask[] })),
    gw<{ workflows: WelcomeWorkflow[] }>("/api/work/workflows").catch(() => ({ workflows: [] as WelcomeWorkflow[] })),
    // Outside tools (MCP servers) this person's AI can use; a failed read only leaves the row out.
    gw<{ servers: { id: string; name: string; preset: string | null; perUser: boolean; connected: boolean }[] }>("/api/ai/mcp/mine").catch(() => ({ servers: [] })),
    // A manager or admin is offered questions about their people; a failed read offers the personal ones.
    c ? Promise.resolve("self" as const) : progressAccess().catch(() => "self" as const),
  ]);
  // Only the built-in model (no hosted one): its answers are basic lookups, and the page says so, with who can fix it.
  const builtInOnly = !models.models.some((m) => m.vendor !== "local");
  const admin = builtInOnly ? await isAdmin() : false;
  const servers: WelcomeServer[] = tools.servers.slice(0, 8).map((x) => ({ id: x.id, name: x.name, perUser: x.perUser, connected: x.connected, ...monogramOf(x.name, x.preset) }));
  return (
    <div className="bg-surface flex min-h-0 flex-1 flex-col">
      <AssistantView
        models={models.models}
        conversations={list.conversations}
        current={open ? c! : null}
        initial={(open?.messages ?? []).map(({ toolCalls, sources, blocks, files, confirm, ...m }) => ({
          ...m,
          ...(confirm ? { confirm } : {}),
          ...(toolCalls?.length ? { tools: toolCalls } : {}),
          ...(sources?.length ? { sources } : {}),
          ...(readBlocks(blocks).length ? { blocks: readBlocks(blocks) } : {}),
          ...(files?.length ? { files: files.map((f) => ({ ...f, key: f.id })) } : {}),
        }))}
        policy={list.policy.detail}
        noAi={builtInOnly ? { admin } : undefined}
        prefill={!open && q ? q.slice(0, 4000) : undefined}
        autoSend={!open && send === "1"}
        myTasks={(mine.open ?? []).slice(0, 3).map(({ id, code, title, dueAt }) => ({ id, code, title, dueAt }))}
        workflows={(flows.workflows ?? []).slice(0, 4).map(({ id, name, category, runner }) => ({ id, name, category, runner }))}
        servers={servers}
        name={session?.givenName || undefined}
        lead={access === "team"}
        taskId={!open && task && /^[0-9A-Za-z_-]{10,40}$/.test(task) ? task : undefined}
      />
    </div>
  );
}

/** Owners and admins see where to connect an AI. */
async function isAdmin() {
  const session = await freshSession();
  const { members } = await gw<{ members: { userId: string; isOwner?: boolean; roles?: string[] }[] }>("/api/identity/members").catch(() => ({ members: [] }));
  const me = members.find((m) => m.userId === session?.userId);
  return !!me && !!(me.isOwner || me.roles?.some((r) => r === "Owner" || r === "Admin"));
}
