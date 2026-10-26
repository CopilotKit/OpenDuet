import { isLoopbackHost } from "@openbot/shared/listen-host";
import type { MiddlewareHandler } from "hono";
import type { DeploymentConfig } from "../config";

/**
 * Only this deployment's own pages may change anything through `/api`.
 *
 * THE HOLE. A browser sends a "simple" request to any site without asking it first: a POST whose
 * body is text/plain, a form, or nothing. This server has no CORS, so a page on another site can
 * never READ an answer, but it never needed to: a page at evil.example posted `{"behaviour":
 * "allow"}` to `/api/approvals/rules` as text/plain, got its 201, and the Bot then sent email with
 * nobody asked. In single-user mode the session is the network position, so every page the person
 * opens could do that; with sign-in, the cookie rides along all the same wherever SameSite does not
 * stop it. A WebSocket is not covered by CORS at all, and `/api/channels/events` opened for
 * `Origin: https://evil.example`.
 *
 * THE RULE, for every request that changes something (anything but GET, HEAD and OPTIONS) and for
 * every WebSocket upgrade, on every path, not only `/api`: Hono decodes a path before routing it, so
 * `/%61pi/approvals/rules` reaches `/api/approvals/rules` while the path as sent has no `/api` in it,
 * and a check scoped to the prefix let it through. Nothing outside `/api` changes anything a page
 * could borrow (`/internal/routines/run` is the worker's, by secret, and sends no `Origin`).
 *
 *  1. An `Origin`, which every browser sends on these, must be one of this deployment's own: an
 *     address it was configured with (see {@link appOrigins}), or the address the request itself
 *     came to when that is loopback or an IP literal (see {@link ownAddress}). `Origin: null`, which
 *     sandboxed frames and `file:` pages send, is nobody's and is refused.
 *  2. No `Origin` at all is a caller that is not a page: the worker, a Bot calling back with its
 *     token, a webhook with its signature, the mobile app with its session cookie, curl. It passes
 *     this check and meets the route's own authentication, which is what it always met. A browser
 *     that omitted `Origin` still says where it was when it sends `Sec-Fetch-Site`, and anything
 *     but `same-origin` or `none` (typed into the address bar) is refused.
 *  3. A body must say it is JSON, or be an upload. text/plain and form encoding are the two types a
 *     page can send cross-site without asking and that can still carry a JSON document, so a route
 *     that reads `c.req.json()` would have read them; refusing them here means no route has to
 *     remember to. A body with no type at all is the third (a `Blob` with none), and is refused
 *     when a browser sent it; from anything else it is ordinary, because Bun's own `fetch` sends a
 *     string body with no type, and a caller with no `Origin` and no `Sec-Fetch-Site` is not a
 *     page. multipart/form-data is how uploads arrive and is not JSON whatever a page puts in it,
 *     and any other type makes a browser ask first, which this server never answers.
 *
 * WHAT IS LEFT ALONE.
 *  - `/api/auth/*`, which Better Auth answers with its own origin check against the same trusted
 *    origins (auth/index.ts), and where a SAML identity provider's form post is cross-site by
 *    design. The organization hand-off under it checks its own `Origin` (auth/organization.ts).
 *  - Signed ingress, for rule 3 only: Twilio posts forms, AWS SNS posts text/plain, and a trigger is
 *    whatever its sender sends. Each is authenticated by a signature over the body and never by a
 *    session or by where it came from, so a page has nothing to borrow there. Rules 1 and 2 still
 *    apply, and none of them sends an `Origin`.
 *
 * An exemption holds only when the path is under it however it is read, as sent and decoded the way
 * Hono decodes it, so no spelling of a path can look exempt here and route somewhere else.
 */

/** Paths whose callers prove themselves with a signature over the body, not a session. */
const SIGNED_INGRESS = ["/api/events/", "/api/delivery/webhooks/"];

/** Types a page can send to another site without a preflight, and that can still carry JSON. */
const SMUGGLES_JSON = new Set([
  "text/plain",
  "application/x-www-form-urlencoded",
]);

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** The app's port when the server is not told one: what Vite and `serve.ts` default to. */
const DEFAULT_APP_PORT = 3010;

export type Refusal = { status: 403 | 415; error: string };

type OriginConfig = Partial<
  Pick<
    DeploymentConfig,
    "appOrigins" | "publicUrl" | "appUrl" | "auth" | "port"
  >
>;

/** This deployment's own origins, and the ports they are on. Built once, by {@link appOrigins}. */
export type AppOrigins = { origins: Set<string>; ports: Set<string> };

/**
 * Every origin this deployment's pages are served from, as a browser writes it in `Origin`.
 *
 * `OPENBOT_PUBLIC_URL` (or `BETTER_AUTH_URL`), `OPENBOT_APP_URL` and every `TRUSTED_ORIGINS` entry:
 * the addresses Better Auth already trusts, so a deployment whose sign-in works passes this too.
 * And the loopback spellings of the app's port and this server's own, which is where a local
 * install is opened: the app's sockets go straight to the server's port (vite.config.ts), so the
 * page's port and the socket's differ, and the server is told the app's by `APP_PORT`.
 */
export function appOrigins(config: OriginConfig): AppOrigins {
  const loopbackPorts = new Set([DEFAULT_APP_PORT]);
  if (config.port) loopbackPorts.add(config.port);
  const named = [
    ...(config.appOrigins ?? []),
    config.publicUrl,
    config.appUrl,
    config.auth?.baseUrl,
    ...(config.auth?.trustedOrigins ?? []),
    ...[...loopbackPorts].flatMap((port) =>
      ["localhost", "127.0.0.1", "[::1]"].map(
        (host) => `http://${host}:${port}`,
      ),
    ),
  ];
  const origins = new Set<string>();
  const ports = new Set<string>();
  for (const value of named) {
    if (!value) continue;
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      // Not a URL: never an origin a browser could send, so nothing to admit.
      continue;
    }
    if (url.origin === "null") continue;
    origins.add(url.origin);
    ports.add(portOf(url));
  }
  return { origins, ports };
}

const portOf = (url: URL) =>
  url.port || (url.protocol === "https:" ? "443" : "80");

/**
 * The page this server is answering for, named by the address the request came to.
 *
 * Only when that address is loopback or an IP literal, which a browser puts in `Host` only when it
 * was pointed at that address. A DNS name could be a rebinding (evil.example re-pointed at
 * 127.0.0.1), whose page would then be "same origin" with itself, so a name has to be configured.
 * Covers what no configuration names: `docker run -p 8080:3001` opened at http://localhost:8080,
 * and an `OPENBOT_HOST` listener opened at http://192.168.1.10:3001. The ports of this deployment's
 * own pages on the same address count too, because the app's sockets go to the server's port from
 * the app's page.
 */
function ownAddress(origin: URL, request: Request, own: AppOrigins) {
  let self: URL;
  try {
    self = new URL(request.url);
  } catch {
    return false;
  }
  const host = self.hostname.replace(/^\[|\]$/g, "");
  const literal =
    isLoopbackHost(host) || /^[\d.]+$/.test(host) || host.includes(":");
  return (
    literal &&
    origin.hostname === self.hostname &&
    (origin.protocol === "http:" || origin.protocol === "https:") &&
    (portOf(origin) === portOf(self) || own.ports.has(portOf(origin)))
  );
}

const FOREIGN_PAGE: Refusal = {
  status: 403,
  error:
    "This request came from a page that is not this deployment's, so it was refused. Open OpenBot at its own address and try again.",
};
const NOT_JSON: Refusal = {
  status: 415,
  error: "Send this request as application/json.",
};

/** Why this request is refused, or null when it may go on to its route. */
export function crossSiteRefusal(
  request: Request,
  own: AppOrigins,
): Refusal | null {
  const upgrade = request.headers.get("upgrade")?.toLowerCase() === "websocket";
  if (SAFE_METHODS.has(request.method) && !upgrade) return null;
  const paths = readingsOf(request);
  const under = (prefix: string) =>
    paths.every((path) => path.startsWith(prefix));
  if (under("/api/auth/")) return null;

  const origin = request.headers.get("origin");
  const site = request.headers.get("sec-fetch-site");
  if (origin !== null) {
    let from: URL | null;
    try {
      from = new URL(origin);
    } catch {
      from = null;
    }
    if (
      !from ||
      from.origin !== origin ||
      !(own.origins.has(origin) || ownAddress(from, request, own))
    )
      return FOREIGN_PAGE;
  } else if (site !== null && site !== "same-origin" && site !== "none") {
    return FOREIGN_PAGE;
  }

  if (upgrade || SIGNED_INGRESS.some(under)) return null;
  if (!hasBody(request)) return null;
  const type = request.headers
    .get("content-type")
    ?.split(";")[0]
    ?.trim()
    .toLowerCase();
  if (!type) return origin !== null || site !== null ? NOT_JSON : null;
  return SMUGGLES_JSON.has(type) ? NOT_JSON : null;
}

/**
 * The request's path as sent, and as Hono reads it to route: percent-decoded with `decodeURI`, and
 * where the whole path will not decode, each sequence that will (hono/utils/url `tryDecode`).
 */
function readingsOf(request: Request): string[] {
  const sent = new URL(request.url).pathname;
  let decoded: string;
  try {
    decoded = decodeURI(sent);
  } catch {
    decoded = sent.replace(/(?:%[0-9A-Fa-f]{2})+/g, (match) => {
      try {
        return decodeURI(match);
      } catch {
        return match;
      }
    });
  }
  return decoded === sent ? [sent] : [sent, decoded];
}

/**
 * Whether the request carries a body. Read from the framing headers a client sends, since an
 * incoming body-less POST still arrives with `Content-Length: 0`; a request built in-process has
 * neither header, and its own body says.
 */
function hasBody(request: Request): boolean {
  const length = request.headers.get("content-length");
  if (length !== null) return Number(length) > 0;
  if (request.headers.get("transfer-encoding") !== null) return true;
  return request.body !== null;
}

/** {@link crossSiteRefusal} in front of every route. Mounted first in app.ts. */
export function createSameOriginGuard(config: OriginConfig): MiddlewareHandler {
  const own = appOrigins(config);
  return async (context, next) => {
    const refusal = crossSiteRefusal(context.req.raw, own);
    if (refusal) return context.json({ error: refusal.error }, refusal.status);
    await next();
  };
}
