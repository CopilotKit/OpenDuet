import { describe, expect, test } from "bun:test";
import { connect } from "node:net";
import { networkInterfaces } from "node:os";
import { LOOPBACK, listenHosts } from "@openbot/shared/listen-host";
import { loadConfig } from "../src/config";
import { startHttpServer } from "../src/http-server";
import { testEnvironment } from "./support/environment";

/**
 * Where the server listens.
 *
 * A default clone runs with `OPENBOT_SINGLE_USER=true`, so whoever reaches the port is the
 * administrator, and the server listened on every interface: `curl http://<LAN-IP>:3001/api/me`
 * answered `{"role":"admin"}` while the boot log said `http://127.0.0.1:3001`. It now listens on this
 * machine alone unless `OPENBOT_HOST` says otherwise.
 */

function singleUser(overrides: Record<string, string> = {}) {
  const {
    GOOGLE_OAUTH_CLIENT_ID: _id,
    GOOGLE_OAUTH_CLIENT_SECRET: _secret,
    BETTER_AUTH_SECRET: _auth,
    BETTER_AUTH_URL: _url,
    INITIAL_ADMIN_EMAILS: _admins,
    ...rest
  } = testEnvironment();
  return { ...rest, OPENBOT_SINGLE_USER: "true", ...overrides };
}

const NO_INTERFACES = {};
const EVERY = { host: undefined, required: true, local: false };

describe("OPENBOT_HOST", () => {
  test("unset is both loopbacks where there is no sign-in, and every interface where there is", () => {
    expect(listenHosts(undefined, "loopback")).toEqual({
      ok: true,
      hosts: [...LOOPBACK],
    });
    expect(listenHosts("  ", "loopback")).toEqual({
      ok: true,
      hosts: [...LOOPBACK],
    });
    expect(listenHosts(undefined, "every")).toEqual({
      ok: true,
      hosts: [EVERY],
    });
    // ::1 may be missing on a machine with IPv6 off; 127.0.0.1 may not.
    expect(LOOPBACK).toEqual([
      { host: "127.0.0.1", required: true, local: true },
      { host: "::1", required: false, local: true },
    ]);
  });

  test("0.0.0.0, :: or * is every interface, as the server listened before", () => {
    for (const raw of ["0.0.0.0", "::", "[::]", "*", "127.0.0.1, 0.0.0.0"])
      expect(listenHosts(raw, "loopback")).toEqual({
        ok: true,
        hosts: [EVERY],
      });
  });

  test("a list is each address, once, each required, and local only when it is loopback", () => {
    expect(
      listenHosts("127.0.0.1, [::1], 192.168.1.10, 127.0.0.1", "loopback"),
    ).toEqual({
      ok: true,
      hosts: [
        { host: "127.0.0.1", required: true, local: true },
        { host: "::1", required: true, local: true },
        { host: "192.168.1.10", required: true, local: false },
      ],
    });
  });

  test("anything that is not an address is refused rather than handed to a listener", () => {
    for (const raw of ["http://0.0.0.0", "0.0.0.0:3001/x", "my host"])
      expect(listenHosts(raw, "loopback").ok).toBe(false);
    expect(() =>
      loadConfig(singleUser({ OPENBOT_HOST: "http://0.0.0.0" }), NO_INTERFACES),
    ).toThrow("OPENBOT_HOST must be a comma-separated list of addresses");
  });
});

describe("the deployment's listen addresses", () => {
  test("with no sign-in, this machine only", () => {
    expect(loadConfig(singleUser(), NO_INTERFACES).listen).toEqual([
      ...LOOPBACK,
    ]);
  });

  test("with no sign-in on Linux, also Docker's bridge, where the Bots' containers call back", () => {
    const interfaces = {
      lo: [
        {
          address: "127.0.0.1",
          family: "IPv4",
          internal: true,
          netmask: "255.0.0.0",
          mac: "00:00:00:00:00:00",
          cidr: "127.0.0.1/8",
        },
      ],
      docker0: [
        {
          address: "172.17.0.1",
          family: "IPv4",
          internal: false,
          netmask: "255.255.0.0",
          mac: "02:42:00:00:00:00",
          cidr: "172.17.0.1/16",
        },
      ],
    } as unknown as ReturnType<typeof networkInterfaces>;
    expect(loadConfig(singleUser(), interfaces).listen).toEqual([
      ...LOOPBACK,
      { host: "172.17.0.1", required: false, local: true },
    ]);
    // Named addresses are exactly what was named.
    expect(
      loadConfig(singleUser({ OPENBOT_HOST: "127.0.0.1" }), interfaces).listen,
    ).toEqual([{ host: "127.0.0.1", required: true, local: true }]);
  });

  test("OPENBOT_HOST opens it further when somebody asks", () => {
    expect(
      loadConfig(singleUser({ OPENBOT_HOST: "0.0.0.0" }), NO_INTERFACES).listen,
    ).toEqual([EVERY]);
  });

  test("with sign-in, every interface, as every such deployment always listened", () => {
    expect(loadConfig(testEnvironment(), NO_INTERFACES).listen).toEqual([
      EVERY,
    ]);
  });
});

/**
 * Somewhere this machine answers that is not loopback, if it has one: a private address, which the
 * suite's network guard lets a raw socket reach (server/scripts/test-network-guard.ts).
 */
const lanAddress = Object.values(networkInterfaces())
  .flat()
  .find(
    (entry) =>
      entry &&
      entry.family === "IPv4" &&
      !entry.internal &&
      /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(entry.address),
  )?.address;

function freePort() {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port;
  probe.stop(true);
  return port as number;
}

/** Whether anything accepts a connection there: a raw socket, which is what a stranger opens. */
function answers(host: string, port: number): Promise<"open" | "refused"> {
  return new Promise((resolve) => {
    const socket = connect({ host, port, timeout: 2_000 });
    socket.once("connect", () => {
      socket.destroy();
      resolve("open");
    });
    socket.once("error", () => resolve("refused"));
    socket.once("timeout", () => {
      socket.destroy();
      resolve("refused");
    });
  });
}

function serve(listen: ReturnType<typeof loadConfig>["listen"], port: number) {
  return startHttpServer({
    port,
    config: { ...loadConfig(singleUser(), NO_INTERFACES), listen },
    resolveRequestActor: async () => {
      throw new Error("not asked");
    },
    agentProfileStore: {} as never,
    computerGateway: undefined,
    demonstrationStore: {} as never,
    demonstrationRecorder: {} as never,
    app: { fetch: () => Response.json({ role: "admin" }) },
  });
}

describe("listening for real", () => {
  test("the loopback default answers on this machine and not on its network address", async () => {
    const port = freePort();
    const server = serve([...LOOPBACK], port);
    try {
      expect(server.addresses).toContain(`http://127.0.0.1:${port}`);
      expect(await answers("127.0.0.1", port)).toBe("open");
      // The repro: `curl http://<LAN-IP>:PORT/api/me` answered as the administrator.
      if (lanAddress) expect(await answers(lanAddress, port)).toBe("refused");
    } finally {
      server.stop();
    }
  });

  test.skipIf(!lanAddress)(
    "OPENBOT_HOST=0.0.0.0 answers on the network address too",
    async () => {
      const port = freePort();
      const server = serve([EVERY], port);
      try {
        expect(server.addresses).toEqual([`every interface on port ${port}`]);
        expect(await answers(lanAddress as string, port)).toBe("open");
      } finally {
        server.stop();
      }
    },
  );
});
