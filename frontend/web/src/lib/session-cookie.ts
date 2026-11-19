/**
 * The session cookie, shared by the session store and the middleware (which cannot load the store: it runs without
 * Node's pg). A session lasts while it is used: every request renews the cookie and every token refresh (each ten
 * minutes of use) renews the stored session, so only a week without opening the app signs a person out.
 */
export const SESSION_COOKIE = "wos_session";
export const SESSION_SID = /^[A-Za-z0-9_-]{43}$/;
export const SESSION_IDLE_SECONDS = 7 * 86400;
