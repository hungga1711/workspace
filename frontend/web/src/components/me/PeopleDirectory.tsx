"use client";

import { useT } from "@/lib/i18n/client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { api } from "@/lib/client";
import { Avatar, useDirectory } from "@/lib/people";
import { btn, btnSm, cx, searchPill } from "@/lib/ui";
import { PageHeader } from "@/components/ui/PageHeader";
import { card } from "@/components/ui/Bento";
import { SpotArea } from "@/components/ui/SpotArea";
import { Intro } from "@/components/ai-hub/Intro";
import { Picker } from "@/components/ui/Picker";
import { EmptyState } from "@/components/ui/EmptyState";
import { ChatIcon, SearchIcon } from "@/components/app/icons";
import type { Employee } from "@/app/app/me/people/page";
import { CallButtons } from "@/components/call/CallButtons";
import { PersonTrigger } from "@/components/chat/PersonTrigger";

export function PeopleDirectory({
  employees: initial,
  nextCursor: initialCursor = null,
  focus,
  canInvite = false,
  departments = [],
  dept: initialDept = "",
}: {
  employees: Employee[];
  nextCursor?: string | null;
  focus?: string;
  canInvite?: boolean;
  /** Every department's name, not just those on the loaded page, so none is missing from the filter. */
  departments?: string[];
  /** The ?dept= filter: the page then holds everyone in that department (a department is small). */
  dept?: string;
}) {
  const tx = useT();
  const dir = useDirectory();
  const router = useRouter();
  const [q, setQ] = useState("");
  const dept = initialDept;
  const [employees, setEmployees] = useState(initial);
  const [cursor, setCursor] = useState(initialCursor);
  const [loading, setLoading] = useState(false);
  // The name search runs on the server (the browser only ever holds a page), debounced; the department filter
  // narrows what is loaded.
  useEffect(() => {
    const needle = q.trim();
    // Inside a department the whole department is already here: the name filter below narrows it.
    if (!needle || dept) {
      setEmployees(initial);
      setCursor(initialCursor);
      return;
    }
    // Only the latest search's answer lands: a slow earlier one must not replace newer (or cleared) results.
    let live = true;
    const t = setTimeout(() => {
      setLoading(true);
      api<{ employees: Employee[]; nextCursor: string | null }>(`employee/employees?limit=60&q=${encodeURIComponent(needle)}`)
        .then((r) => {
          if (!live) return;
          setEmployees(r.employees);
          setCursor(r.nextCursor);
        })
        .catch(() => undefined)
        .finally(() => setLoading(false));
    }, 250);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [q, dept, initial, initialCursor]);
  const more = async () => {
    if (!cursor || loading) return;
    setLoading(true);
    try {
      const r = await api<{ employees: Employee[]; nextCursor: string | null }>(
        `employee/employees?limit=60&after=${encodeURIComponent(cursor)}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`,
      );
      setEmployees((x) => [...x, ...r.employees.filter((e) => !x.some((y) => y.userId === e.userId))]);
      setCursor(r.nextCursor);
    } finally {
      setLoading(false);
    }
  };
  const depts = departments.length ? departments : ([...new Set(employees.map((e) => e.department).filter(Boolean))].sort() as string[]);
  const needle = q.trim().toLowerCase();
  const list = employees.filter(
    (e) => (!dept || e.department === dept) && (!dept || !needle || [e.displayName, e.title, e.department].some((v) => v?.toLowerCase().includes(needle))),
  );
  // The department lives in the URL (reload, back, a shared link keep it); the server then sends that department.
  const setDept = (v: string) => router.replace(v ? `/app/me/people?dept=${encodeURIComponent(v)}` : "/app/me/people", { scroll: false });
  const message = async (userId: string) => {
    const r = await api<{ id: string }>("chat/dms", { method: "POST", body: { userId } });
    router.push(`/app/chat/${r.id}`);
  };
  return (
    <>
      <PageHeader title={tx("me.peopledirectory.danh_ba_cong_ty")} />
      <Intro className="mb-5 max-md:mb-4" title={tx("me.meview.nguoi", { p0: dept ? list.length : cursor ? dir.total || employees.length : employees.length })} />
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className={cx(searchPill, "min-h-9 min-w-0 flex-1 max-sm:basis-full sm:max-w-72")}>
          <SearchIcon className="pointer-events-none size-4 shrink-0" />
          <input
            className="text-ink placeholder:text-ink-2 min-h-9 min-w-0 flex-1 bg-transparent outline-none"
            placeholder={tx("me.peopledirectory.tim_theo_ten_hoac")}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            aria-label={tx("me.peopledirectory.tim_nguoi")}
          />
        </label>
        {depts.length ? (
          <Picker
            variant="button"
            label={tx("me.peopledirectory.phong_ban")}
            value={dept}
            onChange={setDept}
            options={[{ value: "", label: tx("me.peopledirectory.moi_phong_ban") }, ...depts.map((d) => ({ value: d, label: d }))]}
          />
        ) : null}
      </div>
      <SpotArea className="@container">
        {/* Columns by the list's own width: three cards beside the sidebar at 1280px left a job title ~120px. */}
        <ul className="@2xl:grid-cols-2 @5xl:grid-cols-3 m-0 grid list-none grid-cols-[minmax(0,1fr)] gap-3 p-0 max-sm:gap-2">
          {list.map((e) => (
            <li
              key={e.userId}
              ref={e.userId === focus ? (el) => el?.scrollIntoView({ block: "center" }) : undefined}
              className={cx(card, "group flex min-w-0 items-start gap-3 rounded-xl px-3.5 py-3.5", e.userId === focus && "ring-ink-2 ring-2")}
            >
              {/* Avatar and name open the profile card (title, status, message), as everywhere else in the app. */}
              <PersonTrigger userId={e.userId} className="shrink-0">
                <Avatar id={e.userId} name={e.displayName} size="lg" />
              </PersonTrigger>
              <span className="min-w-0 flex-1">
                <PersonTrigger userId={e.userId} className="block max-w-full truncate rounded-md font-medium hover:underline">
                  {/* The account's name, not the employee profile's copy, so the directory says what chat says. */}
                  {dir.byId.get(e.userId)?.displayName ?? e.displayName}
                  {e.userId === dir.me ? <span className="text-ink-2 font-normal">{tx("me.peopledirectory.ban")}</span> : null}
                </PersonTrigger>
                <span className="text-ink-2 line-clamp-2 text-sm">{[e.title, e.department].filter(Boolean).join(" · ") || tx("me.peopledirectory.chua_co_chuc_danh")}</span>
                {e.managerId ? <span className="text-ink-2 block truncate text-xs">{tx("me.peopledirectory.quan_ly", { p0: dir.name(e.managerId) })}</span> : null}
                {/* A manager may open a direct report's progress page (the server decides; anyone else would get a 404). */}
                {e.managerId && e.managerId === dir.me ? (
                  <Link href={`/app/work/people/${e.userId}`} className="text-ink block w-fit text-xs font-medium">
                    {tx("me.peopledirectory.xem_tien_do")}
                  </Link>
                ) : null}
              </span>
              {e.userId !== dir.me ? (
                <span className="-my-1 flex shrink-0 items-center">
                  <button
                    type="button"
                    className="text-ink-2 hover:bg-hover hover:text-ink grid size-8 place-items-center rounded-md"
                    onClick={() => void message(e.userId)}
                    aria-label={tx("me.peopledirectory.nhan_tin_cho", { p0: e.displayName })}
                    title={tx("me.peopledirectory.nhan_tin_cho", { p0: e.displayName })}
                  >
                    <ChatIcon className="size-4" />
                  </button>
                  <CallButtons userId={e.userId} />
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </SpotArea>
      {list.length === 0 && !loading ? <EmptyState compact title={tx("me.peopledirectory.khong_tim_thay", { p0: q || dept })} /> : null}
      {cursor ? (
        <div className="mt-4 flex justify-center">
          <button type="button" className={cx(btn, btnSm)} onClick={() => void more()} disabled={loading}>
            {tx("me.peopledirectory.xem_them")}
          </button>
        </div>
      ) : null}
      {employees.length === 1 && !dept ? (
        <div className="bg-surface shadow-card mt-4 flex max-w-xl flex-wrap items-center gap-3 rounded-xl p-4">
          <p className="text-ink-2 m-0 min-w-0 flex-1 text-sm">{tx("me.peopledirectory.chi_co_ban")}</p>
          {canInvite ? (
            <Link href="/admin/workspace/members" className={cx(btn, btnSm)}>
              {tx("me.peopledirectory.moi_dong_nghiep")}
            </Link>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
