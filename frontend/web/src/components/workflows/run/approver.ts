"use client";

import { useT } from "@/lib/i18n/client";
import { useDirectory } from "@/lib/people";
import type { WorkflowStep } from "../types";

type Step = Pick<WorkflowStep, "approver" | "approverId"> | undefined;

/** Who an approval step waits for, as a sentence ("Waiting for the assignee to approve."). */
export function useApproverWait() {
  const t = useT();
  const dir = useDirectory();
  return (step: Step, startedBy?: string) => {
    const a = step?.approver ?? "editors";
    if (a === "person") return t("workflows.run.waitsFor.person", { name: dir.name(step?.approverId ?? "") });
    if (a === "starter") return t("workflows.run.waitsFor.starter", { name: startedBy ? dir.name(startedBy) : "" });
    return t(`workflows.run.waitsFor.${a}`);
  };
}

/** Who approves, as a short label for a fact row ("The assignee", a person's name). */
export function useApproverLabel() {
  const t = useT();
  const dir = useDirectory();
  return (step: Step) => {
    const a = step?.approver ?? "editors";
    return a === "person" ? dir.name(step?.approverId ?? "") : t(`workflows.run.approver.${a}`);
  };
}
