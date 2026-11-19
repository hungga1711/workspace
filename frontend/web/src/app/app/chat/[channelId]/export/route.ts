import { config } from "@/lib/config";
import { gw, GatewayError } from "@/lib/gateway";
import { getT } from "@/lib/i18n/server";

interface Page {
  channel: { id: string; kind: string; name: string; displayName: string | null; topic: string };
  messages: (Record<string, unknown> & { authorId: string; attachments: { fileId: string; name: string; size: number; contentType: string }[] })[];
  nextAfter: number | null;
}

/**
 * Admin export of one channel as JSON (Chat › channel details › "Export"): the chat module answers in pages, this route
 * streams them into one file so a channel with 100k messages never sits in memory. Author ids are joined with their
 * names once; attachments become links to the signed-in download endpoint.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ channelId: string }> }) {
  const tx = await getT();
  const { channelId } = await params;
  let first: Page;
  try {
    first = await gw<Page>(`/api/chat/channels/${channelId}/export?limit=500`);
  } catch (e) {
    if (e instanceof GatewayError && (e.status === 403 || e.status === 404)) return new Response(tx("chat.details.exportDenied"), { status: e.status });
    throw e;
  }
  const members = await gw<{ members: { userId: string; displayName: string; email: string }[] }>("/api/identity/members").catch(() => ({ members: [] }));
  const people = Object.fromEntries(members.members.map((m) => [m.userId, { name: m.displayName, email: m.email }]));
  const origin = config.appUrl.replace(/\/$/, "");
  const line = (m: Page["messages"][number]) =>
    JSON.stringify({
      ...m,
      author: people[m.authorId] ?? null,
      attachments: m.attachments.map((a) => ({ ...a, url: `${origin}/api/proxy/chat/files/${encodeURIComponent(a.fileId)}/download` })),
    });
  const enc = new TextEncoder();
  let page: Page | null = first;
  let started = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!page) {
        controller.enqueue(enc.encode("\n]}\n"));
        controller.close();
        return;
      }
      const head = started
        ? ""
        : `{"channel":${JSON.stringify(page.channel)},"exportedAt":${JSON.stringify(new Date().toISOString())},"people":${JSON.stringify(people)},"messages":[\n`;
      const body = page.messages.map((m, i) => (started || i ? ",\n" : "") + line(m)).join("");
      started = true;
      controller.enqueue(enc.encode(head + body));
      page = page.nextAfter === null ? null : await gw<Page>(`/api/chat/channels/${channelId}/export?limit=500&after=${page.nextAfter}`);
    },
  });
  const name = (first.channel.displayName ?? first.channel.name ?? channelId).replace(/[^\p{L}\p{N}_-]+/gu, "-").slice(0, 60);
  return new Response(stream, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="chat-${name}-${new Date().toISOString().slice(0, 10)}.json"`,
      "cache-control": "no-store",
    },
  });
}
