import { Arrow, Canvas, Chip, Group, Node, Note } from "./parts";

// The six architecture diagrams used by the docs. Each is grounded in docs/architecture/system-design.md of the
// repository; when the two disagree, that document is right.

export function SystemContext() {
  return (
    <Canvas w={920} h={400} title="System context: who uses Workspace and what it talks to">
      <Node x={20} y={46} w={230} title="Staff in the browser" sub="the web app, installable as a PWA" />
      <Node x={20} y={156} w={230} title="Browser extension" sub="on AI chat sites, after the person opts in" />
      <Node x={20} y={266} w={230} title="Integrations and AI assistants" sub="REST API, MCP server, webhooks" />

      <Node
        x={345}
        y={118}
        w={230}
        title="Workspace"
        sub="one server, one company"
        lines={["chat · tasks · docs · meetings", "approvals · people · AI Insights"]}
        accent
      />

      <Group x={655} y={14} w={250} h={280} label="Optional, chosen by the company" dashed />
      <Node x={670} y={48} w={220} title="AI provider" sub="your key, any API, self-hosted," lines={["or a person's own computer"]} dashed />
      <Node x={670} y={128} w={220} title="SMTP" sub="invitations, resets, digests" dashed />
      <Node x={670} y={208} w={220} title="Object storage (S3)" sub="default: the server's disk" dashed />

      <Arrow points={[[250, 74], [345, 150]]} label="HTTPS" />
      <Arrow points={[[250, 184], [345, 184]]} label="with consent" at={0.42} accent />
      <Arrow points={[[250, 294], [345, 218]]} label="Bearer wos_…" />

      <Arrow points={[[575, 150], [670, 76]]} dashed />
      <Arrow points={[[575, 170], [670, 156]]} dashed />
      <Arrow points={[[575, 200], [670, 236]]} dashed />

      <Note x={20} y={385}>Nothing is sent to the project&apos;s authors or to any third party.</Note>
    </Canvas>
  );
}

export function Containers() {
  return (
    <Canvas w={920} h={470} title="Containers: Caddy, the app container with web and server, and Postgres">
      <Node x={20} y={210} w={130} title="Browser" sub="staff, PWA" />

      <Group x={180} y={20} w={720} h={430} label="Your server · docker compose" />
      <Node x={200} y={210} w={140} title="Caddy" sub=":80 · :443 · TLS" />

      <Group x={430} y={56} w={240} h={270} label="app container · one image" />
      <Node x={450} y={92} w={200} title="web" sub="Next.js BFF · :3000" lines={["sessions in Postgres"]} />
      <Node x={450} y={206} w={200} title="server" sub="Node 22 · :4000" lines={["gateway + 8 modules", "one process"]} accent />

      <Node x={710} y={118} w={170} title="PostgreSQL 16" sub="one database" lines={["a schema and a login", "role per module"]} />
      <Node x={710} y={246} w={170} title="S3 (SeaweedFS)" sub="signed URLs · profile s3" lines={["default: the server's disk"]} dashed />
      <Node x={710} y={336} w={170} title="LiveKit" sub="profile meet · video" dashed />

      <Arrow points={[[150, 238], [200, 238]]} />
      <Arrow points={[[340, 228], [450, 130]]} label="pages" at={0.5} />
      <Arrow points={[[340, 248], [450, 248]]} label="ws · files · mcp" at={0.5} />
      <Arrow points={[[550, 165], [550, 206]]} label="in memory" />
      <Arrow points={[[650, 236], [710, 170]]} />
      <Arrow points={[[650, 110], [710, 138]]} dashed />
      <Arrow points={[[650, 262], [710, 274]]} dashed />
      <Arrow points={[[85, 266], [85, 364], [710, 364]]} label="WebRTC media, straight to LiveKit" dashed at={0.6} />

      <Note x={200} y={292}>Also straight to :4000:</Note>
      <Note x={200} y={308}>wos_ API keys, OAuth,</Note>
      <Note x={200} y={324}>hooks, the runner,</Note>
      <Note x={200} y={340}>/api/ai/local*, /api/docs</Note>
    </Canvas>
  );
}

export function ContainersData() {
  const schemas = ["identity", "platform", "chat", "work", "home", "employee", "ai", "search", "web"];
  return (
    <Canvas w={920} h={430} title="Data and messaging: transactional outbox, in-process delivery, one schema per module">
      <Node x={20} y={40} w={170} title="Module handler" sub="one transaction" />
      <Node x={230} y={40} w={180} title="Rows + outbox row" sub="COMMIT, then NOTIFY" accent />
      <Node x={450} y={40} w={150} title="Outbox relay" sub="claims, SKIP LOCKED" />
      <Node x={640} y={40} w={120} title="Event bus" sub="in process" />
      <Node x={800} y={40} w={100} title="Consumers" sub="per group" />
      <Node x={794} y={150} w={110} title="dead_events" sub="after 5 tries" dashed />

      <Arrow points={[[190, 68], [230, 68]]} />
      <Arrow points={[[410, 68], [450, 68]]} />
      <Arrow points={[[600, 68], [640, 68]]} />
      <Arrow points={[[760, 68], [800, 68]]} />
      <Arrow points={[[850, 96], [850, 150]]} label="fails" />
      <Arrow points={[[794, 178], [700, 178], [700, 96]]} label="dlq replay" dashed at={0.5} />


      <Group x={20} y={210} w={880} h={200} label="PostgreSQL · one database · schema and login role workspace_<module> per module" />
      {schemas.map((s, i) => (
        <Chip key={s} x={34 + i * 96} w={88} y={250} title={s} />
      ))}
      <Note x={34} y={314}>A module&apos;s role can use only its own schema; cross-module data goes through APIs or events.</Note>
      <Note x={34} y={332}>search is a rebuildable projection (reindex); the outbox is the replay copy, kept 3 days.</Note>
      <Note x={34} y={350}>No workspace column anywhere: one installation is one company (ADR-0023).</Note>
      <Note x={34} y={376}>12 consumer groups: home projector, search indexer, platform webhooks and audit, employee, chat, work, ai.</Note>
      <Note x={34} y={394}>At least once, idempotent through processed_events; no ordering across topics.</Note>

      <Arrow points={[[320, 96], [320, 210]]} label="as the module's role" at={0.22} />
      <Arrow points={[[900, 82], [912, 82], [912, 236], [900, 236]]} dashed />
    </Canvas>
  );
}

export function RequestPath() {
  return (
    <Canvas w={920} h={330} title="Request path from the browser to the database">
      <Node x={20} y={96} w={150} title="Browser" sub="httpOnly session id" lines={["no tokens in JS"]} />
      <Node x={210} y={96} w={150} title="web · BFF" sub=":3000" lines={["tokens kept in Postgres"]} />
      <Node x={400} y={96} w={170} title="gateway" sub=":4000" lines={["verify token or wos_ key", "rate limit · sign principal"]} accent />
      <Node x={610} y={96} w={150} title="module" sub="in memory" lines={["verify principal", "authorize(p, perm, res)"]} />
      <Node x={800} y={96} w={100} title="PostgreSQL" sub="own schema" />

      <Arrow points={[[170, 124], [210, 124]]} label="sid" />
      <Arrow points={[[360, 124], [400, 124]]} label="JWT" />
      <Arrow points={[[570, 124], [610, 124]]} label="60 s" />
      <Arrow points={[[760, 124], [800, 124]]} label="SQL" />

      <Node x={400} y={250} w={170} title="Integrations · MCP" sub="Bearer wos_… API key" dashed />
      <Arrow points={[[485, 250], [485, 196]]} />

      <Note x={20} y={222}>Internal token: HS256, 60 s, with principal and session.</Note>
      <Note x={20} y={240}>Scopes: SELF &lt; TEAM &lt; DEPARTMENT &lt; WORKSPACE.</Note>
      <Note x={20} y={258}>An agent never exceeds the person who asked.</Note>
      <Note x={610} y={222}>Personal key: its creator&apos;s</Note>
      <Note x={610} y={240}>permissions, narrowed.</Note>
      <Note x={610} y={258}>Workspace key: a service.</Note>
      <Note x={610} y={276}>Rate limit: 600 a minute per key.</Note>
    </Canvas>
  );
}

export function AiGateway() {
  return (
    <Canvas w={920} h={420} title="AI gateway: routing, circuit breaker, metering and fallback">
      <Node x={20} y={150} w={170} title="Caller" sub="names a feature and a tier" lines={["ask · smart", "brief · fast"]} />

      <Group x={230} y={30} w={400} h={340} label="AI gateway · ai module" />
      <Node x={250} y={66} w={360} title="Route" sub="feature override → default connection → tier default" />
      <Node x={250} y={160} w={360} title="Circuit breaker" sub="skips a route after 429 or a timeout, 30 to 60 s" />
      <Node x={250} y={254} w={360} title="Metering and budgets" sub="ai_usage per person, feature, model" lines={["monthly limits → 429 ai_budget_exceeded"]} />

      <Node x={700} y={66} w={200} title="Provider" sub="vendor API, OpenAI-compatible," lines={["self-hosted (Ollama) or a", "person's connected computer"]} accent />
      <Node x={700} y={184} w={200} title="Encrypted keys" sub="AES-256-GCM, ai_connections" />
      <Node x={700} y={276} w={200} title="local:local-extractive" sub="fallback, always available" dashed />

      <Arrow points={[[190, 178], [250, 100]]} label="feature + tier" at={0.5} />
      <Arrow points={[[430, 122], [430, 160]]} />
      <Arrow points={[[430, 216], [430, 254]]} label="every call" />
      <Arrow points={[[610, 94], [700, 94]]} label="model" accent />
      <Arrow points={[[610, 188], [655, 188], [655, 304], [700, 304]]} label="on failure" dashed at={0.5} />
      <Arrow points={[[800, 154], [800, 184]]} dashed />

      <Note x={20} y={392}>Timeouts: 45 s for a vendor or an API, 120 s self-hosted, 110 s on a person&apos;s connected computer.</Note>
      <Note x={20} y={410}>Not configured → 503 ai_not_configured and the UI hides AI. Tool-using agents run as agent ∩ asker; model output never grants access.</Note>
    </Canvas>
  );
}

export function AiOversight() {
  return (
    <Canvas w={920} h={500} title="AI Insights: intake from the browser extension and imports, storage, and who sees what">
      <Group x={20} y={30} w={360} h={150} label="In the browser" />
      <Node x={40} y={66} w={140} title="16 AI chat sites" sub="prompt on send" />
      <Node x={210} y={66} w={150} title="Extension" sub="safety net first:" lines={["warn · redact · block"]} accent />
      <Arrow points={[[180, 94], [210, 94]]} />

      <Node x={440} y={66} w={160} title="gateway" sub="/api/ai-monitor/events" lines={["Bearer aim_… · rate limit"]} />
      <Node x={640} y={66} w={260} title="ai module" sub="code → person" lines={["topic · sensitive-data flags", "ai_conversations · hourly retention"]} />
      <Arrow points={[[360, 94], [440, 94]]} label="batches" accent />
      <Arrow points={[[600, 94], [640, 94]]} />

      <Node x={440} y={186} w={160} title="Vendor exports" sub="CSV or JSON import" lines={["prompts dropped"]} dashed />
      <Arrow points={[[600, 214], [680, 214], [680, 154]]} />

      <Node x={20} y={280} w={360} h={120} title="Company policy" sub="set once by an admin, every change notifies everyone" lines={["detail: topic · summary", "answers kept: off · retention 7 to 730 days", "safety mode and the company's keywords"]} dashed />

      <Node x={430} y={280} w={180} title="Me › AI" sub="the person" lines={["sees what managers see", "export · ask to erase"]} />
      <Node x={430} y={380} w={180} title="AI › Usage" sub="managers: reporting line" lines={["topic · counts · flags", "never a prompt"]} />
      <Node x={660} y={330} w={240} title="work module" sub="ai.usage.recorded.v1" lines={["tasks with AI help vs without:", "on time, days to done"]} />

      <Arrow points={[[740, 154], [740, 250], [630, 250], [630, 310], [610, 310]]} />
      <Arrow points={[[630, 310], [630, 410], [610, 410]]} />
      <Arrow points={[[840, 154], [840, 330]]} label="when linked to a task" at={0.5} />
      <Arrow points={[[380, 340], [430, 340]]} dashed />

      <Note x={20} y={488}>Redacted or blocked text never leaves the browser. Nobody but the person reads their prompts (ADR-0027).</Note>
    </Canvas>
  );
}

export const DIAGRAMS = {
  "system-context": SystemContext,
  containers: Containers,
  "containers-data": ContainersData,
  "request-path": RequestPath,
  "ai-gateway": AiGateway,
  "ai-oversight": AiOversight,
} as const;
