import { createHmac, randomBytes } from "node:crypto";

export const SESSION_COOKIE = "argus_hub_session";

export interface AdminAuth {
  /** The plaintext password — never sent to the client. */
  password: string;
  /** HMAC-derived token stored in the cookie; rotates when the password changes. */
  sessionToken: string;
  /** Extra hostnames (no port) that should get a non-Secure session cookie, in addition to
   *  the always-allowed loopback hosts. For deployments reachable only over plain HTTP (e.g.
   *  a Tailscale-only address like `hub.your-tailnet.ts.net`) — never set this for anything
   *  reachable from the public internet. */
  insecureCookieHosts: Set<string>;
}

/** Create an AdminAuth from an explicit password or generate one randomly.
 *  The session token is an HMAC of the password, so it changes whenever the password changes
 *  and is never the password itself. */
export function createAdminAuth(password?: string, insecureCookieHosts?: string[]): AdminAuth {
  const pw = password || randomBytes(16).toString("hex");
  const sessionToken = createHmac("sha256", pw).update("argus-hub-session-v1").digest("hex");
  return { password: pw, sessionToken, insecureCookieHosts: new Set(insecureCookieHosts ?? []) };
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

function isInsecureCookieHost(host: string | undefined, extraHosts: Set<string>): boolean {
  const name = hostWithoutPort(host);
  return name === "localhost" || name === "127.0.0.1" || extraHosts.has(name);
}

/** Set-Cookie header value for a valid session (HttpOnly, SameSite=Lax). */
export function makeSessionCookie(auth: AdminAuth, requestHost?: string): string {
  const secure = isInsecureCookieHost(requestHost, auth.insecureCookieHosts) ? "" : "; Secure";
  return `${SESSION_COOKIE}=${auth.sessionToken}; HttpOnly; Path=/; SameSite=Lax${secure}`;
}

/** Set-Cookie header value that expires the session immediately. */
export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}
