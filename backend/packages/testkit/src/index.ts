/** A real password sign-in through the gateway (the identity module issues the tokens). Tests only. */
export async function passwordLogin(gatewayBase: string, email: string, password: string): Promise<{ accessToken: string; refreshToken: string; sessionId: string }> {
  const res = await fetch(`${gatewayBase}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (!res.ok) throw new Error(`login failed for ${email}: ${res.status} ${await res.text()}`);
  return (await res.json()) as { accessToken: string; refreshToken: string; sessionId: string };
}

export async function http(base: string, method: string, path: string, opts: { token?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  const res = await fetch(`${base}${path}`, { method, headers, ...(opts.body === undefined ? {} : { body: JSON.stringify(opts.body) }) });
  const text = await res.text();
  let body: any = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}
