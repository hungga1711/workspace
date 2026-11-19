"use client";

import { SCOPE_LABEL } from "./scope-labels";
import { useT } from "@/lib/i18n/client";
import { roleLabel } from "./roleLabel";
import { Picker } from "@/components/ui/Picker";
import { Menu } from "@/components/ui/Menu";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { api } from "@/lib/client";
import { btn, btnPrimary, btnSm, cx, input } from "@/lib/ui";
import { PERM_AREAS, ROLE_TEMPLATES, SENSITIVE, permDesc, permLabel } from "./permission-groups";
import { Modal } from "@/components/ui/Modal";
import { Field } from "@/components/ui/bits";
import { AdminHeader } from "./AdminNav";
import { MoreIcon, PencilIcon, PlusIcon, TrashIcon } from "@/components/app/icons";
import { useConfirm } from "@/components/ui/Confirm";

interface Role {
  id: string;
  name: string;
  system: boolean;
  grants: { permission: string; scope: string }[];
}
type Catalog = { permissions: string[]; scopes: string[] };
const SCOPE = SCOPE_LABEL;
/** Owner and Admin hold every permission; the API refuses to edit them (a workspace must not lock itself out). */
const locked = (r: Role) => r.system && (r.name === "Owner" || r.name === "Admin");

/** Roles & permissions: RBAC + permission + scope; custom roles without code changes. */
export function RolesAdmin({ roles, catalog }: { roles: Role[]; catalog: Catalog }) {
  const tx = useT();
  const { confirm, dialog } = useConfirm();
  const router = useRouter();
  const [modal, setModal] = useState<{ role?: Role } | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  // A role's grants in plain words, by area: "See tasks (Their team)".
  const groups = (r: Role) => {
    const by = new Map(r.grants.map((g) => [g.permission, g.scope]));
    return PERM_AREAS.map(
      (a) =>
        [
          tx(`admin.permAreas.${a.key}`),
          a.perms.filter((p) => by.has(p)).map((p) => tx("admin.roleSummary.scoped", { perm: permLabel(tx, p), scope: SCOPE(tx)[by.get(p)!] ?? by.get(p)! })),
        ] as const,
    ).filter(([, list]) => list.length);
  };
  const remove = async (r: Role) => {
    if (!(await confirm({ title: tx("admin.rolesadmin.xoa_vai_tro_hoi", { p0: roleLabel(r.name, tx) }), danger: true }))) return;
    try {
      await api(`identity/roles/${r.id}?force=1`, { method: "DELETE" });
      router.refresh();
    } catch {
      setMsg(tx("admin.rolesadmin.chua_xoa_duoc"));
    }
  };
  return (
    <>
      {dialog}
      <>
        <AdminHeader
          title={tx("admin.rolesadmin.vai_tro_quyen")}
          sub={tx("admin.rolesadmin.moi_vai_tro_la")}
          actions={
            <button type="button" className={btnPrimary} onClick={() => setModal({})}>
              <PlusIcon className="size-4" />
              {tx("admin.rolesadmin.tao_vai_tro")}
            </button>
          }
        />
        {msg ? (
          <p className="text-block mb-3 text-sm" role="alert">
            {msg}
          </p>
        ) : null}
        <ul className="m-0 grid list-none gap-3 p-0">
          {roles.map((r) => (
            <li key={r.id} className="bg-surface shadow-card rounded-xl">
              <div className="flex items-center gap-2 pr-2">
                <button
                  type="button"
                  className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left"
                  aria-expanded={open === r.id}
                  onClick={() => setOpen(open === r.id ? null : r.id)}
                >
                  <span className="min-w-0 flex-1 truncate font-semibold">
                    {roleLabel(r.name, tx)}
                    {r.system ? <span className="text-ink-2 ml-2 text-xs font-normal">{tx("admin.rolesadmin.mac_dinh")}</span> : null}
                  </span>
                  <span className="text-ink-2 text-sm">{tx("admin.rolesadmin.quyen", { p0: r.grants.length })}</span>
                  <span className="text-ink-2">{open === r.id ? "▾" : "▸"}</span>
                </button>
                {locked(r) ? null : (
                  <Menu
                    label={tx("admin.rolesadmin.thao_tac")}
                    trigger={
                      <span className={cx(btn, "size-8 min-h-0 px-0")}>
                        <MoreIcon className="size-4" />
                      </span>
                    }
                    items={[
                      { label: tx("admin.rolesadmin.sua_vai_tro"), icon: <PencilIcon />, onSelect: () => setModal({ role: r }) },
                      ...(r.system ? [] : [{ label: tx("admin.rolesadmin.xoa"), icon: <TrashIcon />, danger: true, onSelect: () => void remove(r) }]),
                    ]}
                  />
                )}
              </div>
              {open === r.id ? (
                <div className="border-hairline grid gap-2 border-t px-4 py-3 text-sm sm:grid-cols-2">
                  {locked(r) ? <p className="text-ink-2 m-0 sm:col-span-2">{tx("admin.rolesadmin.khong_sua_mac_dinh")}</p> : null}
                  {groups(r).map(([area, list]) => (
                    <div key={area}>
                      <p className="m-0 font-medium">{area}</p>
                      <p className="text-ink-2 m-0">{list.join(" · ")}</p>
                    </div>
                  ))}
                </div>
              ) : null}
            </li>
          ))}
        </ul>
        {modal ? <RoleModal catalog={catalog} role={modal.role} onClose={() => setModal(null)} /> : null}
      </>
    </>
  );
}

/**
 * Create, or edit an existing role (default roles keep their name; their permissions can change). Permissions are
 * grouped by area in plain words with one line each; a new role can start from a template; the side panel sums up
 * what the role can and cannot do, so nobody has to read permission codes.
 */
function RoleModal({ catalog, role, onClose }: { catalog: Catalog; role: Role | undefined; onClose: () => void }) {
  const tx = useT();
  const router = useRouter();
  const [name, setName] = useState(role?.name ?? "");
  const [grants, setGrants] = useState<Record<string, string>>(() => Object.fromEntries((role?.grants ?? []).map((g) => [g.permission, g.scope])));
  // Problems show only after a save attempt: an empty form is not an error yet.
  const [tried, setTried] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const known = new Set(catalog.permissions);
  const areas = PERM_AREAS.map((a) => ({ ...a, perms: a.perms.filter((p) => known.has(p)) })).filter((a) => a.perms.length);
  // Anything the server lists that the areas do not, so nothing is left unreachable.
  const placed = new Set(areas.flatMap((a) => a.perms));
  const rest = catalog.permissions.filter((p) => !placed.has(p));
  const scopes = catalog.scopes.filter((x) => x !== "PLATFORM");
  const list = Object.entries(grants)
    .filter(([, x]) => x)
    .map(([permission, scope]) => ({ permission, scope }));
  const missingName = !role?.system && !name.trim();
  const save = async () => {
    setTried(true);
    if (missingName || !list.length) return;
    try {
      if (role) await api(`identity/roles/${role.id}`, { method: "PUT", body: { ...(role.system ? {} : { name }), grants: list } });
      else await api("identity/roles", { method: "POST", body: { name, grants: list } });
      onClose();
      router.refresh();
    } catch (e) {
      const st = (e as { status?: number }).status;
      setError(st === 409 ? tx("admin.rolesadmin.da_co_vai_tro") : role ? tx("admin.rolesadmin.chua_luu_duoc") : tx("admin.rolesadmin.chua_tao_duoc_vai"));
    }
  };
  const row = (p: string) => (
    <div key={p} className="grid grid-cols-[minmax(0,1fr)_9.5rem] items-center gap-3 py-2 max-sm:grid-cols-1 max-sm:gap-1.5">
      <span className="min-w-0">
        <span className="block text-sm font-medium">{permLabel(tx, p)}</span>
        {permDesc(tx, p) ? <span className="text-ink-2 block text-xs">{permDesc(tx, p)}</span> : null}
      </span>
      <Picker
        variant="field"
        className="h-8 min-h-0"
        label={tx("admin.rolesadmin.pham_vi_cho", { p0: permLabel(tx, p) })}
        value={grants[p] ?? ""}
        onChange={(v) => setGrants((g) => ({ ...g, [p]: v }))}
        options={[{ value: "", label: "—" }, ...scopes.map((x) => ({ value: x, label: SCOPE(tx)[x] ?? x }))]}
      />
    </div>
  );
  const can = list.map((g) => tx("admin.roleSummary.scoped", { perm: permLabel(tx, g.permission), scope: SCOPE(tx)[g.scope] ?? g.scope }));
  const cannot = SENSITIVE.filter((p) => known.has(p) && !grants[p]).map((p) => permLabel(tx, p));
  return (
    <Modal
      title={role ? tx("admin.rolesadmin.sua_vai_tro") : tx("admin.rolesadmin.tao_vai_tro")}
      wide
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btn} onClick={onClose}>
            {tx("admin.rolesadmin.huy")}
          </button>
          <button type="button" className={btnPrimary} onClick={() => void save()}>
            {role ? tx("admin.rolesadmin.luu") : tx("admin.rolesadmin.tao_vai_tro")}
          </button>
        </>
      }
    >
      <div className="grid gap-4">
        <Field
          label={tx("admin.rolesadmin.ten_vai_tro")}
          error={tried && missingName ? tx("admin.rolesadmin.can_ten_va_it") : error}
          hint={role?.system ? tx("admin.rolesadmin.ten_co_dinh") : undefined}
        >
          <input
            className={input}
            value={role?.system ? roleLabel(role.name, tx) : name}
            onChange={(e) => setName(e.target.value)}
            placeholder={tx("admin.roleTemplates.lead")}
            autoFocus={!role}
            disabled={role?.system}
          />
        </Field>
        {role ? null : (
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">{tx("admin.roleTemplates.title")}</span>
            <div className="flex flex-wrap gap-1.5">
              {ROLE_TEMPLATES.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  className={cx(btn, btnSm)}
                  onClick={() => {
                    setGrants(t.grants);
                    if (!name.trim()) setName(tx(`admin.roleTemplates.${t.key}`));
                  }}
                >
                  {tx(`admin.roleTemplates.${t.key}`)}
                </button>
              ))}
            </div>
            <span className="text-ink-2 text-xs">{tx("admin.roleTemplates.note")}</span>
          </div>
        )}
        <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_15rem]">
          <div className="grid gap-4">
            <p className="text-ink-2 m-0 text-sm">{tx("admin.rolesadmin.chon_pham_vi")}</p>
            {areas.map((a) => (
              <fieldset key={a.key} className="border-hairline m-0 rounded-lg border px-3 pb-1 pt-0">
                <legend className="px-1 text-sm font-semibold">{tx(`admin.permAreas.${a.key}`)}</legend>
                <div className="divide-divider-soft grid divide-y">{a.perms.map(row)}</div>
              </fieldset>
            ))}
            {rest.length ? (
              <fieldset className="border-hairline m-0 rounded-lg border px-3 pb-1 pt-0">
                <legend className="px-1 text-sm font-semibold">…</legend>
                <div className="divide-divider-soft grid divide-y">{rest.map(row)}</div>
              </fieldset>
            ) : null}
          </div>
          {/* What the role adds up to, in words, beside the list (under it on narrow screens). */}
          <aside className="bg-hover/50 grid content-start gap-3 rounded-lg p-3 text-sm lg:sticky lg:top-0" aria-live="polite">
            <div className="grid gap-1">
              <span className="font-semibold">{tx("admin.roleSummary.can")}</span>
              {can.length ? (
                <ul className="text-ink-soft m-0 grid list-none gap-0.5 p-0 text-xs">
                  {can.map((c) => (
                    <li key={c}>✓ {c}</li>
                  ))}
                </ul>
              ) : (
                <span className={cx("text-xs", tried ? "text-block" : "text-ink-2")}>{tx("admin.roleSummary.nothing")}</span>
              )}
            </div>
            {cannot.length ? (
              <div className="grid gap-1">
                <span className="font-semibold">{tx("admin.roleSummary.cannot")}</span>
                <ul className="text-ink-2 m-0 grid list-none gap-0.5 p-0 text-xs">
                  {cannot.map((c) => (
                    <li key={c}>– {c}</li>
                  ))}
                </ul>
              </div>
            ) : null}
          </aside>
        </div>
      </div>
    </Modal>
  );
}
