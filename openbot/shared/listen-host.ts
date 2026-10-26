/**
 * Where a local process listens: the API server, and the app's dev, preview and installed servers.
 *
 * LOOPBACK, UNLESS SOMEBODY SAYS OTHERWISE. With `OPENBOT_SINGLE_USER` every request is the one
 * administrator, so whatever can reach the port is that administrator. The server used to listen on
 * every interface and the app on `::`, which is every interface too (the comments beside it said
 * "both loopbacks", which is not what `::` is), so a default clone answered `{"role":"admin"}` to
 * anybody on the same Wi-Fi, directly or through the app's `/api` proxy. Both now listen on
 * 127.0.0.1 and ::1 and nowhere else unless `OPENBOT_HOST` names more.
 *
 * `OPENBOT_HOST`, NOT `HOST`. `HOST` is a name shells and platforms set for their own reasons, often
 * to the machine's own name, and a listener that read it would follow that name onto the network
 * without anybody having asked it to. The prefixed name is only ever somebody's decision.
 *
 * ONE DECLARATION FOR EVERY LISTENER, because the server alone on loopback is no protection while
 * the app beside it proxies `/api` to it from every interface.
 */
export const LISTEN_HOST_VARIABLE = "OPENBOT_HOST";

/** One address to listen on. `host` undefined is every interface, which is a listener's default. */
export type ListenHost = {
  host: string | undefined;
  /**
   * False for ::1 in the loopback default: a machine or container with IPv6 switched off has no ::1
   * to bind, and that is not a reason to refuse to start on 127.0.0.1.
   */
  required: boolean;
  /** Whether only this machine (and the containers it runs) can reach it. */
  local: boolean;
};

export type ListenHosts =
  | { ok: true; hosts: ListenHost[] }
  | { ok: false; reason: string };

/** Both loopbacks: everything on this machine, and nothing beyond it. */
export const LOOPBACK: readonly ListenHost[] = [
  { host: "127.0.0.1", required: true, local: true },
  { host: "::1", required: false, local: true },
];

/** Every interface: what a listener does when it is given no host at all. */
const EVERY: ListenHost = { host: undefined, required: true, local: false };

/** The spellings of "every interface", which a listener is given as no host at all. */
const EVERY_INTERFACE = new Set(["0.0.0.0", "::", "*"]);

const LOOPBACK_NAMES = new Set(["localhost", "::1", "0:0:0:0:0:0:0:1"]);

/** Whether an address is this machine only: `localhost`, 127.0.0.0/8 or ::1. */
export function isLoopbackHost(host: string): boolean {
  const bare = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return LOOPBACK_NAMES.has(bare) || /^127(\.\d{1,3}){3}$/.test(bare);
}

/**
 * The addresses to listen on, from `OPENBOT_HOST` and what to do without it.
 *
 * Unset or blank takes `fallback`: `loopback` for anything that may be running as the single
 * administrator, `every` for a deployment whose every route asks who is calling. Set, it is a comma-
 * separated list of addresses, each listened on; `0.0.0.0`, `::` or `*` anywhere in it means every
 * interface, the way the server listened before this existed. IPv6 may be written bare or in
 * brackets. Anything that is not an address or a name is refused rather than handed to a listener
 * to fail on, or worse to resolve.
 */
export function listenHosts(
  raw: string | undefined,
  fallback: "loopback" | "every",
): ListenHosts {
  const entries = (raw ?? "")
    .split(",")
    .map((entry) => entry.trim().replace(/^\[(.*)\]$/, "$1"))
    .filter(Boolean);
  if (entries.length === 0)
    return fallback === "loopback"
      ? { ok: true, hosts: [...LOOPBACK] }
      : { ok: true, hosts: [EVERY] };
  if (entries.some((entry) => EVERY_INTERFACE.has(entry)))
    return { ok: true, hosts: [EVERY] };
  const malformed = entries.find((entry) => !/^[A-Za-z0-9.:%-]+$/.test(entry));
  if (malformed !== undefined)
    return {
      ok: false,
      reason: `${LISTEN_HOST_VARIABLE} must be a comma-separated list of addresses, such as 127.0.0.1,::1 or 0.0.0.0 (got ${JSON.stringify(raw)}).`,
    };
  return {
    ok: true,
    hosts: [...new Set(entries)].map((host) => ({
      host,
      required: true,
      local: isLoopbackHost(host),
    })),
  };
}

/** `http://127.0.0.1:3001`, with IPv6 bracketed, or the words for every interface. */
export function listenAddress(host: string | undefined, port: number): string {
  if (host === undefined) return `every interface on port ${port}`;
  return `http://${host.includes(":") ? `[${host}]` : host}:${port}`;
}
