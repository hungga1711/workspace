import { describe, expect, it } from "vitest";
import { defaultConfig, effectiveFeatures, readWorkspaceConfig, workspaceConfigSchema } from "./config.js";

describe("workspace mode", () => {
  it("is the full app unless chosen, including on rows saved before the mode existed", () => {
    const full = defaultConfig("Acme");
    expect(full.mode).toBe("full");
    const { mode: _drop, ...older } = full;
    expect(readWorkspaceConfig(older).mode).toBe("full");
    expect(effectiveFeatures(full)).toMatchObject({ chat: true, work: true, attendance: true, insightsOnly: false });
  });

  it("AI Insights only keeps every module but switches attendance off and flags the short navigation", () => {
    const c = defaultConfig("Acme", "en", "Europe/London", { assistant: false, monitoring: true }, "GB", "insights");
    expect(c.mode).toBe("insights");
    expect(effectiveFeatures(c)).toMatchObject({ chat: true, work: true, attendance: false, aiMonitoring: true, insightsOnly: true });
    // Switching back restores attendance as it was set.
    expect(effectiveFeatures({ ...c, mode: "full" }).attendance).toBe(true);
  });
});

describe("features left out at deploy time (DISABLED_FEATURES)", () => {
  const c = defaultConfig("Acme", "en", "Europe/London", { assistant: true, monitoring: true });
  it("are all on by default, under their own names", () => {
    expect(effectiveFeatures(c, {})).toMatchObject({
      docs: true,
      whiteboards: true,
      calendar: true,
      time: true,
      ai: true,
      attendance: true,
      aiAssistant: true,
      aiMonitoring: true,
    });
  });

  it("outrank what the admin switched on", () => {
    const f = effectiveFeatures(c, { DISABLED_FEATURES: "time,ai,whiteboards" });
    expect(f).toMatchObject({ docs: true, calendar: true, whiteboards: false, time: false, ai: false, attendance: false, aiAssistant: false, aiMonitoring: false });
    // Chat and tasks cannot be left out.
    expect(effectiveFeatures(c, { DISABLED_FEATURES: "chat,work,tasks" })).toMatchObject({ chat: true, work: true });
  });

  it("AI Insights only falls back to the full app when AI is left out", () => {
    const insights = { ...c, mode: "insights" as const };
    expect(effectiveFeatures(insights, {}).insightsOnly).toBe(true);
    expect(effectiveFeatures(insights, { DISABLED_FEATURES: "ai" }).insightsOnly).toBe(false);
  });
});

describe("desktopDownloadUrl", () => {
  const base = defaultConfig("Acme");
  it("is null until an admin sets it, and only a web link is accepted (Profile renders it as a link)", () => {
    expect(readWorkspaceConfig({ ...base, desktopDownloadUrl: undefined }).desktopDownloadUrl).toBeNull();
    expect(workspaceConfigSchema.safeParse({ ...base, desktopDownloadUrl: "https://drive.acme.com/desktop" }).success).toBe(true);
    expect(workspaceConfigSchema.safeParse({ ...base, desktopDownloadUrl: "javascript:alert(1)" }).success).toBe(false);
  });
});
