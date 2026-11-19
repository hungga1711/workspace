import type { Metadata } from "next";
import Link from "next/link";
import { getT } from "@/lib/i18n/server";
import { MIN_COMPARE_SAMPLE } from "@/lib/metrics";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getT();
  return { title: t("aiHub.how.title") };
}

/** AI › Áp dụng AI › How this is calculated: the sources, the attribution rules and the limits behind every figure. */
export default async function HowCalculatedPage() {
  const t = await getT();
  const sections: { title: string; items: string[] }[] = [
    { title: t("aiHub.how.sourcesTitle"), items: [t("aiHub.how.company"), t("aiHub.how.extension"), t("aiHub.how.local")] },
    { title: t("aiHub.how.tasksTitle"), items: [t("aiHub.how.inApp"), t("aiHub.how.linked"), t("aiHub.how.code"), t("aiHub.how.onlyBefore"), t("aiHub.how.notRecorded")] },
    { title: t("aiHub.how.compareTitle"), items: [t("aiHub.how.days"), t("aiHub.how.onTime"), t("aiHub.how.sample", { min: MIN_COMPARE_SAMPLE })] },
    { title: t("aiHub.how.signalTitle"), items: [t("aiHub.how.choice"), t("aiHub.how.time")] },
    { title: t("aiHub.how.privacyTitle"), items: [t("aiHub.how.privacy")] },
  ];
  return (
    <article className="flex max-w-2xl flex-col gap-7 py-2" data-testid="ai-how">
      <header className="flex flex-col gap-2">
        <Link href="/app/ai/adoption" className="text-ink-2 hover:text-ink w-fit text-xs no-underline">
          ← {t("aiHub.how.back")}
        </Link>
        <h2 className="text-ink m-0 text-balance text-2xl font-semibold tracking-[-0.02em]">{t("aiHub.how.title")}</h2>
        <p className="text-ink-2 m-0 text-sm">{t("aiHub.how.lead")}</p>
      </header>
      {sections.map((s) => (
        <section key={s.title} className="flex flex-col gap-2">
          <h3 className="text-ink m-0 text-base font-semibold">{s.title}</h3>
          <ul className="text-ink m-0 flex list-disc flex-col gap-1.5 pl-5 text-sm leading-relaxed">
            {s.items.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </section>
      ))}
    </article>
  );
}
