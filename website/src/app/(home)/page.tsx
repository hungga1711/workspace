import { ArrowRight, Check } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";
import { CopyCommand } from "@/components/home/copy-command";
import { FeatureToggles } from "@/components/home/feature-toggles";
import { HubDiagram } from "@/components/home/hub-diagram";
import { Reveal } from "@/components/home/motion";
import { ArrowLink, Button, Container, GitHubIcon, SectionHead, Title } from "@/components/home/primitives";
import { TourPlayer } from "@/components/home/tour-player";
import { WorkflowRun } from "@/components/home/workflow-run";
import { WorkflowTemplates } from "@/components/home/workflow-templates";
import { repoFile, SITE } from "@/lib/site";

// What search engines and AI search read about the product; nothing here that the page does not also say.
const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "Workspace",
  applicationCategory: "BusinessApplication",
  operatingSystem: "Linux (Docker)",
  url: SITE.url,
  softwareVersion: SITE.version,
  license: "https://opensource.org/licenses/MIT",
  codeRepository: SITE.repo,
  isAccessibleForFree: true,
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  description:
    "A self-hosted workspace (tasks, chat, docs, requests, time) connected to the AI agents your team already uses: assign a task to an agent with a workflow that stops for a person's approval, and measure how AI is used and whether tasks done with it finish sooner. Open source, works without AI.",
  video: {
    "@type": "VideoObject",
    name: "Workspace in 65 seconds",
    description: "Assign a task to an AI agent with a workflow that stops where you decide; see how AI is used and whether it helps; the workspace underneath.",
    thumbnailUrl: `${SITE.url}/media/tour-poster.jpg`,
    contentUrl: `${SITE.url}/media/tour.mp4`,
    duration: "PT65S",
    uploadDate: "2026-11-19",
  },
};

// Six sections, one job each: what it is, how it fits, the agent workflow, the measurement, the workspace, running it.
export default function HomePage() {
  return (
    <>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }} />
      <Hero />
      <Overview />
      <Workflows />
      <Measure />
      <WorkApp />
      <SelfHosting />
    </>
  );
}

/** Index for a staggered child: the CSS reads --i to compute its delay. */
const nth = (i: number) => ({ "--i": i }) as CSSProperties;

/** The second half of a section title, in the quieter grey: two tones instead of a gradient. */
const Quiet = ({ children }: { children: ReactNode }) => <span className="text-ink-4">{children}</span>;

/* ── hero ──────────────────────────────────────────────────────────── */

// The page's one gradient, on the one line that names the product.
const ACCENT = "bg-gradient-to-r from-[#52a8ff] to-[#a78bfa] bg-clip-text text-transparent";

function Hero() {
  return (
    <section className="relative">
      <Container className="pt-14 pb-12 text-center sm:pt-20">
        <a
          href={repoFile("CHANGELOG.md")}
          target="_blank"
          rel="noreferrer"
          className="hero-in group inline-flex items-center gap-3 font-mono text-[12px] text-ink-3 transition-colors hover:text-ink"
          style={{ animationDelay: "0ms" }}
        >
          <span className="text-ink">v{SITE.version}</span>
          <span aria-hidden className="h-3 w-px bg-hair-strong" />
          <span>Open source, MIT licensed, runs on your server</span>
          <span aria-hidden className="transition-transform group-hover:translate-x-0.5">→</span>
        </a>
        <Title as="h1" className="mx-auto mt-6 max-w-[20ch] !text-[2.5rem] sm:!text-[4rem]">
          {/* No entrance animation on the headline and the lead: they are what the first paint is measured by. */}
          Your team&apos;s workspace, <span className={ACCENT}>connected to its AI agents.</span>
        </Title>
        <p className="mx-auto mt-6 max-w-[38rem] text-[17px] leading-relaxed text-ink-2">
          Tasks, chat and docs for the whole company. Hand work to AI agents, approve every decision, and see whether AI
          actually helps.
        </p>
        <div className="hero-in mt-7 flex flex-wrap justify-center gap-2.5" style={{ animationDelay: "120ms" }}>
          <Button href="/docs/quick-start">
            Get started <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
          </Button>
          <Button href={SITE.repo} variant="secondary">
            <GitHubIcon /> GitHub
          </Button>
        </div>
      </Container>

      <div className="relative mx-auto w-full max-w-[1120px] px-5 pb-20 sm:px-8 sm:pb-28">
        <div aria-hidden className="pointer-events-none absolute inset-x-[10%] top-[8%] bottom-[20%] -z-10">
          <div className="glow-drift absolute top-[-6%] left-[18%] h-[60%] w-[64%] rounded-full bg-[#5b5bf6] opacity-[0.16] blur-[120px]" />
        </div>
        <TourPlayer />
      </div>
    </section>
  );
}

/* ── how it fits together ──────────────────────────────────────────── */

function Overview() {
  return (
    <section id="overview" className="scroll-mt-16 border-t border-hair">
      <Container className="py-20 sm:py-24">
        <Reveal>
          <SectionHead
            center
            title={
              <>
                Everything points to one workspace. <Quiet>The workspace points to your AI.</Quiet>
              </>
            }
          />
        </Reveal>
        <Reveal delay={80} className="mt-14">
          <HubDiagram />
        </Reveal>
      </Container>
    </section>
  );
}

/* ── the highlight: assign a workflow to an AI agent ───────────────── */

function Workflows() {
  const how: [string, string][] = [
    ["Pick a task", "Any task on the board, in any team."],
    ["Assign a workflow", "Steps your team built, or one of 22 templates."],
    ["Approve or send back", "The agent stops wherever a person decides."],
  ];
  return (
    <section id="workflows" className="scroll-mt-16 border-y border-hair bg-[#050505]">
      <Container className="py-20 sm:py-24">
        <Reveal>
          <SectionHead
            title={
              <>
                Assign the task to an AI agent. <Quiet>It stops where you decide.</Quiet>
              </>
            }
            lead="Every step shows what went in, what came out and which model ran it."
            action={<ArrowLink href="/docs/advanced/workflows">How a run works</ArrowLink>}
          />
        </Reveal>

        <div className="mt-12 grid gap-10 lg:grid-cols-[1fr_1.15fr] lg:items-start lg:gap-16">
          <Reveal stagger as="ol" step={90} className="space-y-6 lg:sticky lg:top-24 lg:pt-6">
            {how.map(([t, d], i) => (
              <li key={t} style={nth(i)} className="flex gap-4">
                <span className="w-6 shrink-0 pt-0.5 font-mono text-xs text-ink-4">{String(i + 1).padStart(2, "0")}</span>
                <div>
                  <h3 className="text-lg font-medium tracking-[-0.02em] text-ink">{t}</h3>
                  <p className="mt-1 text-[15px] text-ink-3">{d}</p>
                </div>
              </li>
            ))}
          </Reveal>
          <Reveal delay={120}>
            <WorkflowRun />
          </Reveal>
        </div>

        <Reveal delay={60} className="mt-12">
          <WorkflowTemplates />
        </Reveal>
      </Container>
    </section>
  );
}

/* ── measure: how AI is used, and whether it works ─────────────────── */

const MEASURES: [string, string][] = [
  ["What for", "Topics by person and department, across every AI your team uses."],
  ["How much", "Tokens and cost per tool, model and person."],
  ["Does it help", "Tasks with AI against tasks without: on time and days to done."],
  ["With what data", "Secrets, IDs and client names caught before a prompt leaves."],
];
const PROMISES = ["Off until each person opts in", "Everyone sees what is kept about them", "No screenshots, keystrokes or idle timers"];

function Measure() {
  return (
    <section id="measure" className="scroll-mt-16">
      <Container className="py-20 sm:py-24">
        <Reveal>
          <SectionHead
            title={
              <>
                See how AI is used, <Quiet>and whether it works.</Quiet>
              </>
            }
            lead="On real tasks, not a survey. Measured, never monitored."
            action={<ArrowLink href="/docs/ai-insights">How AI Insights works</ArrowLink>}
          />
        </Reveal>

        <div className="mt-12 grid gap-10 lg:grid-cols-[1fr_1.1fr] lg:items-center lg:gap-16">
          <Reveal stagger as="dl" step={70} className="border-t border-hair">
            {MEASURES.map(([t, d], i) => (
              <div key={t} style={nth(i)} className="grid gap-1 border-b border-hair py-4 sm:grid-cols-[9rem_1fr] sm:gap-6">
                <dt className="text-[15px] font-medium text-ink">{t}</dt>
                <dd className="text-[15px] text-ink-3">{d}</dd>
              </div>
            ))}
          </Reveal>
          <Reveal delay={100}>
            <SafetyNet />
          </Reveal>
        </div>

        <Reveal delay={80}>
          <ul className="mt-10 flex flex-wrap gap-x-8 gap-y-3 text-sm text-ink-2">
            {PROMISES.map((p) => (
              <li key={p} className="flex items-center gap-2">
                <Check className="size-4 text-ok" /> {p}
              </li>
            ))}
            <li>
              <ArrowLink href="/docs/ai-insights/extension">What the extension sends</ArrowLink>
            </li>
          </ul>
        </Reveal>
      </Container>
    </section>
  );
}

/** The safety net, as the extension shows it: the prompt as typed, and what actually leaves the browser. */
function SafetyNet() {
  const tag = (t: string) => <span className="rounded bg-[#5b5bf6]/25 px-1 text-[#a5b4fc]">[{t}]</span>;
  return (
    <div className="overflow-hidden rounded-xl bg-[#0a0a0a] shadow-[0_0_0_1px_#242424,0_30px_60px_-30px_rgba(0,0,0,0.9)]">
      <div className="flex items-center justify-between border-b border-white/10 px-5 py-3">
        <span className="text-sm font-medium text-white">An outside AI chat</span>
        <span className="rounded-full bg-white/[0.06] px-2.5 py-0.5 text-xs text-white/55">workspace extension · on</span>
      </div>
      <div className="space-y-4 px-5 py-5 font-mono text-[13px] leading-relaxed">
        <div>
          <p className="mb-1.5 font-sans text-[11px] tracking-[0.06em] text-white/40 uppercase">Typed</p>
          <p className="text-white/50 line-through decoration-white/25">
            Debug the payment webhook. API key: sk_live_5Hx9f2…, customer jane.doe@acme.com, card 4111 1111 1111 1111
          </p>
        </div>
        <div>
          <p className="mb-1.5 font-sans text-[11px] tracking-[0.06em] text-white/40 uppercase">Sent</p>
          <p className="text-white/90">
            Debug the payment webhook. API key: {tag("SECRET")}, customer {tag("EMAIL")}, card {tag("CARD")}
          </p>
        </div>
      </div>
      <div className="border-t border-white/10 px-5 py-3 text-xs text-white/55">Secrets never leave the company. 3 parts replaced, nothing stored.</div>
    </div>
  );
}

/* ── the workspace underneath ──────────────────────────────────────── */

const MODULES = [
  "Tasks and projects",
  "Progress and goals",
  "Chat and calls",
  "Docs",
  "Whiteboards",
  "Calendar and meetings",
  "Requests and approvals",
  "Attendance and leave",
  "Admin and audit log",
  "Search across everything",
];

function WorkApp() {
  return (
    <section id="workplace" className="scroll-mt-16 border-t border-hair">
      <Container className="py-20 sm:py-24">
        <div className="grid gap-12 lg:grid-cols-[1fr_1fr] lg:items-start lg:gap-16 [&>*]:min-w-0">
          <Reveal>
            <Title>
              Where the work lives. <Quiet>Free, with or without AI.</Quiet>
            </Title>
            <ul className="mt-10 grid grid-cols-1 border-t border-hair sm:grid-cols-2 sm:gap-x-8">
              {MODULES.map((m) => (
                <li key={m} className="border-b border-hair py-3 text-[15px] text-ink-2">
                  {m}
                </li>
              ))}
            </ul>
            <p className="mt-5 text-sm text-ink-4">English · Tiếng Việt · 中文 · Español</p>
          </Reveal>
          <Reveal delay={100}>
            <p className="mb-4 text-[15px] text-ink">
              Don&apos;t need it? Turn it off. <Quiet>Even AI.</Quiet>
            </p>
            <FeatureToggles />
          </Reveal>
        </div>
      </Container>
    </section>
  );
}

/* ── run it ────────────────────────────────────────────────────────── */

function SelfHosting() {
  return (
    <section id="self-hosting" className="scroll-mt-16 border-t border-hair bg-[#050505]">
      <Container className="grid gap-12 py-20 sm:py-24 lg:grid-cols-2 lg:items-center lg:gap-16 [&>*]:min-w-0">
        <Reveal>
          <Title>
            On your server in five minutes. <Quiet>Yours to keep.</Quiet>
          </Title>
          <p className="mt-4 max-w-[40ch] text-base text-ink-3">Three containers, 2 GB of RAM, MIT licensed. Nothing is sent to us.</p>
          <div className="mt-8 max-w-[34rem]">
            <CopyCommand command={SITE.install} />
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-2.5">
            <Button href="/docs/quick-start">
              Get started <ArrowRight className="size-4 transition-transform group-hover:translate-x-0.5" />
            </Button>
            <Button href={SITE.repo} variant="secondary">
              <GitHubIcon /> Star on GitHub
            </Button>
            <span className="ml-2">
              <ArrowLink href="/docs/advanced">Contributor guide</ArrowLink>
            </span>
          </div>
        </Reveal>
        <Reveal delay={100}>
          <Terminal />
        </Reveal>
      </Container>
    </section>
  );
}

function Line({ i, children, dim }: { i: number; children: ReactNode; dim?: boolean }) {
  return (
    <div style={nth(i)} className={dim ? "text-white/40" : "text-white/90"}>
      {children}
    </div>
  );
}
/** Output appears line by line once the terminal scrolls into view, like a real session. */
function Terminal() {
  const prompt = <span className="text-[#52a8ff] select-none">$ </span>;
  const ok = <span className="text-[#45d483]">✓</span>;
  return (
    <div className="overflow-hidden rounded-xl bg-[#0a0a0a] shadow-[0_0_0_1px_#242424,0_40px_80px_-30px_rgba(0,0,0,0.95)]">
      <div className="flex items-center gap-2 border-b border-white/10 px-4 py-3">
        <span className="size-3 rounded-full bg-[#ff5f57]" />
        <span className="size-3 rounded-full bg-[#febc2e]" />
        <span className="size-3 rounded-full bg-[#28c840]" />
        <span className="ml-3 font-mono text-xs text-white/45">root@work.example.com</span>
      </div>
      <Reveal stagger step={130} className="overflow-x-auto px-5 py-5 font-mono text-[12.5px] leading-[1.85] whitespace-pre">
        <Line i={0}>{prompt}curl -fsSL …/infra/production/install.sh | sh</Line>
        <Line i={1} dim>Domain: work.example.com</Line>
        <Line i={2} dim>E-mail for HTTPS: it@example.com</Line>
        <Line i={3} dim>Generating secrets … done</Line>
        <Line i={4} dim>Starting postgres, app, caddy …</Line>
        <Line i={5}>
          {ok} Open <span className="text-[#52a8ff]">https://work.example.com/setup</span>
        </Line>
        <Line i={6}> </Line>
        <Line i={7}>{prompt}docker compose ps</Line>
        <Line i={8} dim>{"SERVICE   IMAGE                         STATUS"}</Line>
        <Line i={9}>
          {"postgres  postgres:16.4-alpine          "}
          <span className="text-[#45d483]">healthy</span>
        </Line>
        <Line i={10}>
          {"app       "}
          {SITE.image.padEnd(30)}
          <span className="text-[#45d483]">healthy</span>
        </Line>
        <Line i={11}>{"caddy     caddy:2.8.4-alpine            running"}</Line>
        <Line i={12}>
          {prompt}
          <span className="caret" />
        </Line>
      </Reveal>
    </div>
  );
}
