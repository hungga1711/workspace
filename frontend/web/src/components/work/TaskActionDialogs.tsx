"use client";

// The dialogs behind the task "…" menu, split out so the task page only downloads them when one opens.
import { useState } from "react";
import { useT } from "@/lib/i18n/client";
import { api } from "@/lib/client";
import { btn, btnPrimary, cx, input } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Picker } from "@/components/ui/Picker";
import { Checkbox } from "@/components/ui/Checkbox";
import { ProjectBadge } from "@/components/ui/ProjectBadge";
import type { Project, Task } from "./types";

function Footer({ onClose, busy, disabled, label, form }: { onClose: () => void; busy: boolean; disabled?: boolean; label: string; form: string }) {
  const tx = useT();
  return (
    <>
      <button type="button" className={btn} onClick={onClose}>
        {tx("common.cancel")}
      </button>
      <button type="submit" form={form} className={btnPrimary} disabled={busy || disabled}>
        {label}
      </button>
    </>
  );
}

export function MoveDialog({
  task,
  projects,
  busy,
  onClose,
  onMove,
}: {
  task: Task;
  projects: Project[];
  busy: boolean;
  onClose: () => void;
  onMove: (projectId: string | null) => void;
}) {
  const tx = useT();
  const [to, setTo] = useState(task.projectId ?? "");
  return (
    <Modal
      title={tx("taskActions.moveTitle", { code: task.code })}
      onClose={onClose}
      footer={<Footer form="ta-move" onClose={onClose} busy={busy} disabled={(to || null) === task.projectId} label={tx("taskActions.moveConfirm")} />}
    >
      <form
        id="ta-move"
        className="flex flex-col gap-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          onMove(to || null);
        }}
      >
        <Picker
          variant="field"
          label={tx("taskActions.moveTo")}
          value={to}
          onChange={setTo}
          options={[
            { value: "", label: tx("work.newtaskdrawer.viec_ca_nhan") },
            ...projects.map((p) => ({ value: p.id, label: p.name, icon: <ProjectBadge id={p.id} name={p.name} size="sm" /> })),
          ]}
        />
        <p className="text-ink-2 m-0 text-xs">{tx("taskActions.moveHint")}</p>
      </form>
    </Modal>
  );
}

export function DuplicateDialog({
  task,
  hasSubtasks,
  busy,
  onClose,
  onDuplicate,
}: {
  task: Task;
  hasSubtasks: boolean;
  busy: boolean;
  onClose: () => void;
  onDuplicate: (title: string, withSubtasks: boolean) => void;
}) {
  const tx = useT();
  const [title, setTitle] = useState(tx("taskActions.copyTitle", { title: task.title }).slice(0, 300));
  const [withSubs, setWithSubs] = useState(true);
  return (
    <Modal
      title={tx("taskActions.duplicateTitle", { code: task.code })}
      onClose={onClose}
      footer={<Footer form="ta-dup" onClose={onClose} busy={busy} disabled={!title.trim()} label={tx("taskActions.duplicateConfirm")} />}
    >
      <form
        id="ta-dup"
        className="flex flex-col gap-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (title.trim()) onDuplicate(title.trim(), hasSubtasks && withSubs);
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-ink-2 text-xs">{tx("taskActions.newTitle")}</span>
          <input className={input} value={title} maxLength={300} autoFocus onChange={(e) => setTitle(e.target.value)} />
        </label>
        {hasSubtasks ? <Checkbox label={tx("taskActions.withSubtasks")} checked={withSubs} onChange={(e) => setWithSubs(e.target.checked)} /> : null}
      </form>
    </Modal>
  );
}

export function TemplateDialog({
  task,
  project,
  busy,
  onClose,
  onSave,
}: {
  task: Task;
  project: Project | null;
  busy: boolean;
  onClose: () => void;
  onSave: (name: string, forProject: boolean) => void;
}) {
  const tx = useT();
  const [name, setName] = useState(task.title.slice(0, 120));
  const [scope, setScope] = useState(project ? "project" : "all");
  return (
    <Modal
      title={tx("taskActions.templateTitle")}
      onClose={onClose}
      footer={<Footer form="ta-tpl" onClose={onClose} busy={busy} disabled={!name.trim()} label={tx("taskActions.templateConfirm")} />}
    >
      <form
        id="ta-tpl"
        className="flex flex-col gap-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          if (name.trim()) onSave(name.trim(), scope === "project");
        }}
      >
        <label className="flex flex-col gap-1.5">
          <span className="text-ink-2 text-xs">{tx("taskActions.templateName")}</span>
          <input className={input} value={name} maxLength={120} autoFocus onChange={(e) => setName(e.target.value)} />
        </label>
        {project ? (
          <Picker
            variant="field"
            label={tx("taskActions.templateScope")}
            value={scope}
            onChange={setScope}
            options={[
              { value: "project", label: tx("taskActions.scopeProject", { project: project.name }) },
              { value: "all", label: tx("taskActions.scopeAll") },
            ]}
          />
        ) : null}
        <p className="text-ink-2 m-0 text-xs">{tx("taskActions.templateHint")}</p>
      </form>
    </Modal>
  );
}

export function SubtaskDialog({ task, busy, onClose, onPick }: { task: Task; busy: boolean; onClose: () => void; onPick: (parentId: string) => void }) {
  const tx = useT();
  const [parent, setParent] = useState("");
  const [options, setOptions] = useState<{ value: string; label: string }[] | null>(null);
  const load = () => {
    if (options || !task.projectId) return;
    void api<{ columns: { tasks: { id: string; code: string; title: string }[] }[] }>(`work/projects/${task.projectId}/board`)
      .then((b) =>
        setOptions(
          b.columns
            .flatMap((c) => c.tasks)
            .filter((x) => x.id !== task.id)
            .map((x) => ({ value: x.id, label: `${x.code} · ${x.title}` })),
        ),
      )
      .catch(() => setOptions([]));
  };
  return (
    <Modal
      title={tx("taskActions.subtaskTitle", { code: task.code })}
      onClose={onClose}
      footer={<Footer form="ta-sub" onClose={onClose} busy={busy} disabled={!parent} label={tx("taskActions.subtaskConfirm")} />}
    >
      <form
        id="ta-sub"
        className={cx("flex flex-col gap-3 text-sm")}
        onSubmit={(e) => {
          e.preventDefault();
          if (parent) onPick(parent);
        }}
      >
        <Picker
          variant="field"
          label={tx("taskActions.parent")}
          value={parent}
          onChange={setParent}
          onOpen={load}
          placeholder={tx("taskActions.pickParent")}
          options={options ?? []}
        />
        <p className="text-ink-2 m-0 text-xs">{tx("taskActions.subtaskHint")}</p>
      </form>
    </Modal>
  );
}
