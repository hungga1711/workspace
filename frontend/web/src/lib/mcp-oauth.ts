/**
 * The OAuth consent for an MCP server opens in a popup; the callback page (/mcp-callback) tells this window when it
 * is done. The popup is opened on the click itself (blank), and pointed at the consent URL once the server returns
 * it, so popup blockers let it through; without a popup the whole tab goes to the consent page instead.
 */
export function openBlank(): Window | null {
  try {
    return window.open("about:blank", "mcp-oauth", "popup,width=520,height=720");
  } catch {
    return null;
  }
}

/** Sends the popup (or this tab) to `url`; resolves with the outcome when the popup reports back or is closed. */
export function finishInPopup(win: Window | null, url: string): Promise<{ ok: boolean } | null> {
  if (!win || win.closed) {
    window.location.assign(url);
    return new Promise(() => undefined);
  }
  win.location.href = url;
  return new Promise((resolve) => {
    const done = (v: { ok: boolean } | null) => {
      window.removeEventListener("message", onMessage);
      clearInterval(timer);
      resolve(v);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.origin !== window.location.origin) return;
      const d = e.data as { type?: string; ok?: boolean } | null;
      if (d?.type === "mcp-oauth") done({ ok: !!d.ok });
    };
    window.addEventListener("message", onMessage);
    const timer = setInterval(() => {
      if (win.closed) done(null);
    }, 600);
  });
}
