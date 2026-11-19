"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { useT } from "@/lib/i18n/client";
import { btn, btnPrimary, cx, input, textarea } from "@/lib/ui";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { DateField } from "@/components/ui/DateField";
import { Picker } from "@/components/ui/Picker";
import { FormField } from "./FormField";
import { AssigneeSelect } from "./TaskFields";
import { PeoplePicker } from "@/components/chat/NewConversation";
import type { ProjectDetail } from "./ProjectHeader";

/** "Sửa dự án": name, description, due date, owner and team (the team is what TEAM-scope grants, i.e. the Manager role, apply to). */
export function EditProject({
  p,
  onClose,
  onSaved,
  canManageTeams = false,
}: {
  p: ProjectDetail;
  onClose: () => void;
  onSaved: () => void;
  /** May make a new team here (member.manage): "Dự án mới" says the team can be changed later, so it must be possible. */
  canManageTeams?: boolean;
}) {
  const tx = useT();
  const [name, setName] = useState(p.name);
  const [description, setDescription] = useState(p.description);
  const [due, setDue] = useState(p.dueAt ? p.dueAt.slice(0, 10) : "");
  const [owner, setOwner] = useState<string | null>(p.ownerId);
  // "" no team, "new" a new team of `people`, else an existing team's id (same choices as "Dự án mới").
  const [team, setTeam] = useState<string>(p.teamId ?? "");
  const [people, setPeople] = useState<string[]>([]);
  const [teams, setTeams] = useState<{ id: string; name: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void api<{ teams: { id: string; name: string }[] }>("identity/teams")
      .then((r) => live && setTeams(r.teams))
      .catch(() => live && setTeams([]));
    return () => {
      live = false;
    };
  }, []);
  const save = async () => {
    setBusy(true);
    try {
      let teamId: string | null = team && team !== "new" ? team : null;
      if (team === "new") {
        const members = [...new Set([...(owner ? [owner] : []), ...people])];
        teamId = (await api<{ id: string }>("identity/teams", { method: "POST", body: { name: name.trim().slice(0, 80), memberIds: members } })).id;
      }
      await api(`work/projects/${p.id}`, {
        method: "PATCH",
        body: {
          expectedVersion: p.version,
          name,
          description,
          dueAt: due ? new Date(`${due}T17:00:00`).toISOString() : null,
          teamId,
          ...(owner ? { ownerId: owner } : {}),
        },
      });
      onSaved();
    } catch (e) {
      setBusy(false);
      const s = (e as { status?: number }).status;
      setError(s === 409 ? tx("work.projectheader.du_an_vua_duoc") : s === 403 ? tx("work.projectheader.ban_khong_co_quyen") : tx("work.projectheader.chua_luu_duoc"));
    }
  };
  return (
    <Modal
      title={tx("work.projectheader.sua_du_an")}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("work.projectheader.huy")}
          </button>
          <button type="button" className={btnPrimary} disabled={!name.trim() || busy} onClick={() => void save()}>
            {tx("work.projectheader.luu")}
          </button>
        </>
      }
    >
      <div className="grid grid-cols-1 gap-4">
        {error ? (
          <p className="text-block text-sm" role="alert">
            {error}
          </p>
        ) : null}
        <Field label={tx("work.projectheader.ten_du_an")}>
          <input className={input} value={name} onChange={(e) => setName(e.target.value)} maxLength={200} />
        </Field>
        <Field label={tx("work.projectheader.mo_ta")}>
          <textarea className={cx(textarea, "min-h-24")} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={5000} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <FormField label={tx("work.projectheader.han_hoan_thanh")}>
            <DateField label={tx("work.projectheader.han_hoan_thanh")} value={due} onChange={setDue} />
          </FormField>
          <FormField label={tx("work.projectheader.nguoi_phu_trach")}>
            <AssigneeSelect id="project-owner" value={owner} onChange={setOwner} />
          </FormField>
        </div>
        {teams && (teams.length || canManageTeams) ? (
          <Field label={tx("work.projectheader.team")}>
            <Picker
              variant="field"
              label={tx("work.projectheader.team")}
              value={team}
              onChange={setTeam}
              options={[
                { value: "", label: tx("work.projectheader.khong_team") },
                ...(canManageTeams ? [{ value: "new", label: tx("work.projectlist.newTeam") }] : []),
                ...teams.map((t) => ({ value: t.id, label: t.name })),
              ]}
            />
          </Field>
        ) : null}
        {team === "new" ? (
          <Field label={tx("work.projectlist.teamPeople")} hint={tx("work.projectlist.teamPeopleHint")}>
            <PeoplePicker selected={people} onChange={setPeople} exclude={owner ? [owner] : []} />
          </Field>
        ) : null}
      </div>
    </Modal>
  );
}
