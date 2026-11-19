"use client";

import { useLocale, useSetLocale, useT } from "@/lib/i18n/client";
import { browserLocale, DEFAULT_LOCALE, INTL_TAG, LOCALE_COOKIE, LOCALE_NAME, LOCALES, type Locale } from "@/lib/i18n/config";
import { BrandMark } from "@/components/ui/BrandMark";
import dynamic from "next/dynamic";
import { browserTimeZone } from "@/lib/timezone";
import { COUNTRIES, countryFromZone, regionName } from "@/lib/country";
import { Picker } from "@/components/ui/Picker";
import { DEFAULT_TIME_ZONE } from "@/lib/timezone";
import { authCta, control, cx } from "@/lib/ui";
import Link from "next/link";
import { useActionState, useEffect, useState } from "react";
import { setup, type SetupState } from "./actions";

// The searchable IANA picker (and the Picker it is built on) loads when the form renders on the client, not with
// the page: /setup is read once per installation and sits under the sign-in JS budget.
const TimeZoneField = dynamic(() => import("@/components/ui/TimeZoneField").then((m) => m.TimeZoneField), { ssr: false });

const field = `${control} min-h-10 w-full font-normal aria-[invalid=true]:border-block`;
const label = "grid gap-1.5 text-sm font-medium";
const hint = "text-ink-2 text-xs font-normal";
const TEAMS = [
  { value: "product", key: "setup.teamProduct" },
  { value: "sales", key: "setup.teamSales" },
  { value: "ops", key: "setup.teamOps" },
] as const;

/**
 * Two steps in one form: the company first, then the admin account. Step 2 opens as soon as the company name is
 * valid (CSS `:has`, so it works before hydration and without a "Next" click), and the one submit lives there.
 */
export function SetupForm({ tokenRequired, ai = true, aiDefault = false }: { tokenRequired: boolean; ai?: boolean; aiDefault?: boolean }) {
  const tx = useT();
  const [state, action, pending] = useActionState<SetupState, FormData>(setup, { error: null, fields: {} });
  const [company, setCompany] = useState(state.fields.companyName ?? "");
  const team = state.fields.teamType ?? "product";
  // The company's language and time zone: the browser's until the admin says otherwise. Picking a language here
  // also switches this page (the cookie), so the admin reads the rest of setup in it.
  const locale = useLocale();
  const setLocale = useSetLocale();
  const [tz, setTz] = useState(state.fields.timezone || DEFAULT_TIME_ZONE);
  const [country, setCountry] = useState(state.fields.country ?? "");
  const [countryTouched, setCountryTouched] = useState(!!state.fields.country);
  // Until someone picks a country, it follows the time zone (Europe/Madrid → Spain).
  useEffect(() => {
    if (!countryTouched) setCountry(countryFromZone(tz, locale) ?? "");
  }, [tz, locale, countryTouched]);
  useEffect(() => {
    if (!state.fields.timezone) setTz(browserTimeZone());
    // No language picked yet: follow the browser when it prefers one of ours (English otherwise, the default).
    if (!document.cookie.includes(`${LOCALE_COOKIE}=`)) {
      const preferred = browserLocale(navigator.languages.join(",")) ?? DEFAULT_LOCALE;
      if (preferred !== locale) setLocale(preferred);
    }
    // Once, on mount: later changes come from the controls below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <form action={action} className="group grid gap-6">
      {/* A miniature of the sidebar's top row (bòn bon tile until a logo is uploaded), filled in as the name is typed. */}
      <div className="border-hairline bg-hover/50 flex h-12 items-center gap-2 rounded-xl border px-2.5" aria-hidden="true">
        <BrandMark className={cx("size-7 rounded-md transition-opacity", company.trim() ? "opacity-100" : "opacity-35")} />
        <span className={cx("truncate text-sm font-semibold", company.trim() ? "text-ink" : "text-ink-2 font-normal")}>{company.trim() || tx("setup.previewEmpty")}</span>
      </div>

      {state.error ? (
        <div className="bg-block-wash rounded-lg px-3.5 py-2.5 text-sm" role="alert">
          {state.error === "already_set_up" ? (
            <>
              <b className="font-semibold">{tx("setup.alreadySetUp")}</b> <Link href="/login">{tx("signIn.signupForm.dang_nhap")}</Link>
            </>
          ) : state.error === "rate_limited" ? (
            <>
              <b className="font-semibold">{tx("signIn.signupForm.ban_da_thu_qua")}</b> {tx("signIn.signupForm.vui_long_thu_lai")}
            </>
          ) : state.error === "setup_token" ? (
            <>
              <b className="font-semibold">{tx("setup.tokenWrong")}</b> {tx("setup.tokenWrongHint")}
            </>
          ) : state.error === "weak_password" ? (
            <b className="font-semibold">{tx("setup.passwordWeak")}</b>
          ) : state.error === "invalid" ? (
            <>
              <b className="font-semibold">{tx("signIn.signupForm.thong_tin_chua_hop")}</b>{" "}
              {tx("signIn.signupForm.kiem_tra_lai_cac", { p0: state.detail ? ` (${state.detail})` : "" })}
            </>
          ) : (
            <>
              <b className="font-semibold">{tx("signIn.signupForm.khong_tao_duoc_workspace")}</b>
              {state.requestId ? <span className="text-ink-2 mt-1 block font-mono text-xs">{tx("signIn.signupForm.ma_yeu_cau", { p0: state.requestId })}</span> : null}
            </>
          )}
        </div>
      ) : null}

      <ol className="m-0 flex list-none items-center gap-2 p-0 text-xs" aria-label={tx("setup.steps")}>
        <li className="text-ink flex items-center gap-1.5 font-medium">
          <span className="bg-brand text-on-brand grid size-5 place-items-center rounded-full text-[11px] tabular-nums">1</span>
          {tx("setup.stepCompany")}
        </li>
        <li aria-hidden="true" className="bg-hairline h-px w-6" />
        <li className="text-ink-2 group-has-[#setup-company:valid]:text-ink flex items-center gap-1.5 transition-colors group-has-[#setup-company:valid]:font-medium">
          <span className="border-hairline group-has-[#setup-company:valid]:bg-brand group-has-[#setup-company:valid]:text-on-brand grid size-5 place-items-center rounded-full border text-[11px] tabular-nums transition-colors group-has-[#setup-company:valid]:border-transparent">
            2
          </span>
          {tx("setup.stepOwner")}
        </li>
      </ol>

      <fieldset className="m-0 grid gap-4 border-0 p-0">
        <legend className="sr-only">{tx("setup.stepCompany")}</legend>
        <label className={label}>
          {tx("signIn.signupForm.ten_cong_ty")}
          <input
            id="setup-company"
            className={field}
            name="companyName"
            required
            pattern=".*\S.*\S.*"
            minLength={2}
            maxLength={80}
            value={company}
            onChange={(e) => setCompany(e.target.value)}
            onKeyDown={(e) => {
              // Enter on step 1 moves on to step 2 instead of submitting a half-filled form.
              if (e.key !== "Enter" || !e.currentTarget.validity.valid) return;
              e.preventDefault();
              const form = e.currentTarget.form;
              requestAnimationFrame(() => form?.querySelector<HTMLInputElement>('input[name="ownerName"]')?.focus());
            }}
            autoComplete="organization"
            autoFocus
          />
        </label>
        <div className="grid gap-1.5">
          <span id="setup-team" className="text-sm font-medium">
            {tx("setup.teamLabel")}
          </span>
          <div role="radiogroup" aria-labelledby="setup-team" className="bg-hover grid grid-cols-3 gap-0.5 rounded-full p-0.5">
            {TEAMS.map((t) => (
              <label
                key={t.value}
                className="has-[:checked]:bg-surface has-[:checked]:text-ink has-[:focus-visible]:outline-ink-2 text-ink-2 hover:text-ink has-[:checked]:shadow-raised grid h-8 cursor-pointer place-items-center rounded-full text-sm transition-colors has-[:checked]:font-medium has-[:focus-visible]:outline has-[:focus-visible]:outline-2"
              >
                <input type="radio" name="teamType" value={t.value} defaultChecked={t.value === team} className="sr-only" />
                {tx(t.key)}
              </label>
            ))}
          </div>
          <span className={hint}>{tx("setup.teamHint")}</span>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="grid gap-1.5">
            <span id="setup-language" className="text-sm font-medium">
              {tx("setup.language")}
            </span>
            <div role="radiogroup" aria-labelledby="setup-language" className="bg-hover grid grid-cols-2 gap-0.5 rounded-full p-0.5">
              {LOCALES.map((l) => (
                <label
                  key={l}
                  className="has-[:checked]:bg-surface has-[:checked]:text-ink has-[:focus-visible]:outline-ink-2 text-ink-2 hover:text-ink has-[:checked]:shadow-raised grid h-8 cursor-pointer place-items-center rounded-full text-sm transition-colors has-[:checked]:font-medium has-[:focus-visible]:outline has-[:focus-visible]:outline-2"
                >
                  <input type="radio" name="locale" value={l} checked={locale === l} onChange={() => setLocale(l as Locale)} className="sr-only" />
                  {LOCALE_NAME[l]}
                </label>
              ))}
            </div>
            <span className={hint}>{tx("setup.languageHint")}</span>
          </div>
          <div className="grid content-start gap-1.5">
            <span className="text-sm font-medium" aria-hidden="true">
              {tx("setup.timezone")}
            </span>
            <TimeZoneField label={tx("setup.timezone")} value={tz} onChange={setTz} />
            <input type="hidden" name="timezone" value={tz} />
            <span className={hint}>{tx("setup.timezoneHint")}</span>
          </div>
          {/* Holidays, the default annual leave and the currency follow the country; the time zone suggests it. */}
          <div className="grid content-start gap-1.5 sm:col-span-2">
            <span className="text-sm font-medium" aria-hidden="true">
              {tx("setup.country")}
            </span>
            <Picker
              variant="field"
              label={tx("setup.country")}
              value={country}
              onChange={(v) => {
                setCountry(v);
                setCountryTouched(true);
              }}
              placeholder={tx("setup.countryOther")}
              options={[
                ...COUNTRIES.map((c) => ({ value: c, label: regionName(c, INTL_TAG[locale]) })).sort((a, b) => a.label.localeCompare(b.label)),
                { value: "", label: tx("setup.countryOther") },
              ]}
            />
            <input type="hidden" name="country" value={country} />
            <span className={hint}>{tx("setup.countryHint")}</span>
          </div>
        </div>
        {/* A deployment without AI (DISABLED_FEATURES=ai) is the full work app: nothing to choose here. */}
        {ai ? (
          <>
            {/* What the installation is for: the full work app, or AI Insights only on top of the team's own task tool
                (Asana, ClickUp, Linear, Jira through task sync). Switchable later in Admin › Settings. */}
            <fieldset className="border-hairline m-0 grid gap-2 rounded-xl border p-3">
              <legend className="px-1 text-sm font-medium">{tx("setup.mode")}</legend>
              {(["full", "insights"] as const).map((m) => (
                <label key={m} className="flex cursor-pointer items-start gap-2.5 text-sm">
                  <input type="radio" name="mode" value={m} defaultChecked={(state.fields.mode || "full") === m} className="accent-brand mt-0.5 size-4" />
                  <span className="grid gap-0.5">
                    <span className="font-medium">{tx(m === "full" ? "setup.modeFull" : "setup.modeInsights")}</span>
                    <span className={hint}>{tx(m === "full" ? "setup.modeFullHint" : "setup.modeInsightsHint")}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            {/* AI is two separate switches, both off by default: the company's own model, and recording what staff do
                on ChatGPT/Claude/Gemini/Copilot (a form of staff monitoring, so it is a conscious choice, never a default). */}
            <fieldset className="border-hairline m-0 grid gap-2 rounded-xl border p-3">
              <legend className="px-1 text-sm font-medium">{tx("setup.ai")}</legend>
              <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  name="aiAssistant"
                  value="1"
                  defaultChecked={state.fields.aiAssistant ? state.fields.aiAssistant === "1" : aiDefault}
                  className="accent-brand mt-0.5 size-4"
                />
                <span className="grid gap-0.5">
                  <span className="font-medium">{tx("setup.aiAssistant")}</span>
                  <span className={hint}>{tx("setup.aiAssistantHint")}</span>
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2.5 text-sm">
                <input
                  type="checkbox"
                  name="aiMonitoring"
                  value="1"
                  defaultChecked={state.fields.aiMonitoring ? state.fields.aiMonitoring === "1" : aiDefault}
                  className="accent-brand mt-0.5 size-4"
                />
                <span className="grid gap-0.5">
                  <span className="font-medium">{tx("setup.aiInsights")}</span>
                  <span className={hint}>{tx("setup.aiInsightsHint")}</span>
                </span>
              </label>
            </fieldset>
          </>
        ) : null}
      </fieldset>

      <fieldset className="animate-rise border-hairline m-0 hidden gap-4 border-0 border-t p-0 pt-6 group-has-[#setup-company:valid]:grid">
        <legend className="sr-only">{tx("setup.stepOwner")}</legend>
        <label className={label}>
          {tx("signIn.signupForm.ho_ten_cua_ban")}
          <input
            className={field}
            name="ownerName"
            required
            maxLength={80}
            defaultValue={state.fields.ownerName}
            autoComplete="name"
            placeholder={tx("signIn.signupForm.nguyen_van_minh")}
          />
        </label>
        <label className={label}>
          {tx("signIn.signupForm.email_cong_viec")}
          <input className={field} name="ownerEmail" type="email" required defaultValue={state.fields.ownerEmail} autoComplete="email" />
        </label>
        <label className={label}>
          {tx("signIn.signupForm.mat_khau")}
          <input
            className={field}
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            aria-invalid={state.error === "weak_password" ? true : undefined}
            aria-describedby="setup-password-hint"
          />
          <span id="setup-password-hint" className={cx(hint, state.passwordError && "text-block")}>
            {state.passwordError ? tx(`signIn.resetPasswordActions.${state.passwordError as "pw_too_short"}`) : tx("setup.passwordHint")}
          </span>
        </label>
        {tokenRequired ? (
          <label className={label}>
            {tx("setup.token")}
            <input
              className={field}
              name="setupToken"
              required
              autoComplete="off"
              spellCheck={false}
              defaultValue={state.fields.setupToken}
              aria-invalid={state.error === "setup_token" ? true : undefined}
            />
            <span className={hint}>{tx("setup.tokenHint")}</span>
          </label>
        ) : null}
        <button className={authCta} type="submit" disabled={pending}>
          {pending ? tx("setup.submitting") : tx("setup.submit")}
        </button>
      </fieldset>
    </form>
  );
}
