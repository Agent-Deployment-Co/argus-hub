import { createHmac, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "argus_hub_session";

export interface AdminAuth {
  /** The plaintext password — never sent to the client. */
  password: string;
  /** HMAC-derived token stored in the cookie; rotates when the password changes. */
  sessionToken: string;
}

/** Create an AdminAuth from an explicit password or generate one randomly.
 *  The session token is an HMAC of the password, so it changes whenever the password changes
 *  and is never the password itself. */
export function createAdminAuth(password?: string): AdminAuth {
  const pw = password || randomBytes(16).toString("hex");
  const sessionToken = createHmac("sha256", pw).update("argus-hub-session-v1").digest("hex");
  return { password: pw, sessionToken };
}

/** Return true if the Cookie header contains a valid session token. */
export function verifySession(cookieHeader: string | undefined, auth: AdminAuth): boolean {
  if (!cookieHeader) return false;
  return cookieHeader.split(";").some((part) => {
    const [name, value] = part.trim().split("=", 2);
    return name === SESSION_COOKIE && value === auth.sessionToken;
  });
}

function hostWithoutPort(host: string | undefined): string {
  if (!host) return "";
  const trimmed = host.trim().toLowerCase();
  if (trimmed.startsWith("[")) return trimmed.slice(1, trimmed.indexOf("]"));
  return trimmed.split(":", 1)[0] ?? "";
}

function isLoopbackDevHost(host: string | undefined): boolean {
  const name = hostWithoutPort(host);
  return name === "localhost" || name === "127.0.0.1";
}

/** Set-Cookie header value for a valid session (HttpOnly, SameSite=Lax). */
export function makeSessionCookie(auth: AdminAuth, requestHost?: string): string {
  const secure = isLoopbackDevHost(requestHost) ? "" : "; Secure";
  return `${SESSION_COOKIE}=${auth.sessionToken}; HttpOnly; Path=/; SameSite=Lax${secure}`;
}

/** Set-Cookie header value that expires the session immediately. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}
