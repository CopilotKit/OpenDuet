import { describe, expect, test } from "bun:test";
import { createApp } from "../src/app";
import type { ApprovalService } from "../src/approvals/service";
import { appOrigins, crossSiteRefusal } from "../src/auth/same-origin";
import { loadConfig } from "../src/config";
import { testEnvironment } from "./support/environment";

/**
 * Only this deployment's own pages may change anything through `/api`.
 *
 * The release review's repro, on a default install: a page at evil.example posted
 * `{"behaviour":"allow"}` to `/api/approvals/rules` as text/plain, got 201, and the Bot then sent
 * email without asking. A WebSocket to `/api/channels/events` opened for the same origin. See
 * auth/same-origin.ts for the rule and what it leaves alone.
 */

/** A default clone's `.env`: one administrator, no sign-in, the app on 3010 and the API on 3001. */
function singleUserEnvironment(overrides: Record<string, string> = {}) {
  const {
    GOOGLE_OAUTH_CLIENT_ID: _id,
    GOOGLE_OAUTH_CLIENT_SECRET: _secret,
    BETTER_AUTH_SECRET: _auth,
    BETTER_AUTH_URL: _url,
    INITIAL_ADMIN_EMAILS: _admins,
    ...rest
  } = testEnvironment();
  return {
    ...rest,
    OPENBOT_SINGLE_USER: "true",
    PORT: "3001",
    OPENBOT_PUBLIC_URL: "http://localhost:3001",
    TRUSTED_ORIGINS: "http://localhost:3010",
    ...overrides,
  };
}

const own = appOrigins(loadConfig(singleUserEnvironment(), {}));
const EVIL = "https://evil.example";
const RULE = JSON.stringify({ toolRef: "*", behaviour: "allow" });

function request(
  url: string,
  init: {
    method?: string;
    origin?: string;
    site?: string;
    type?: string;
    body?: string;
    upgrade?: boolean;
  } = {},
) {
  const headers = new Headers();
  if (init.origin !== undefined) headers.set("origin", init.origin);
  if (init.site !== undefined) headers.set("sec-fetch-site", init.site);
  if (init.type !== undefined) headers.set("content-type", init.type);
  if (init.upgrade) {
    headers.set("upgrade", "websocket");
    headers.set("connection", "Upgrade");
  }
  return new Request(url, {
    method: init.method ?? "POST",
    headers,
    ...(init.body !== undefined ? { body: init.body } : {}),
  });
}
const status = (value: Request) => crossSiteRefusal(value, own)?.status ?? "ok";
const API = "http://localhost:3001/api/approvals/rules";

describe("a state-changing request from another site", () => {
  test("is refused, whatever it is dressed as", () => {
    for (const type of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "application/json",
    ])
      expect(status(request(API, { origin: EVIL, type, body: RULE }))).toBe(
        403,
      );
    // A body-less POST is a state change too.
    expect(status(request(API, { origin: EVIL }))).toBe(403);
    for (const method of ["PUT", "PATCH", "DELETE"])
      expect(status(request(API, { method, origin: EVIL, body: RULE }))).toBe(
        403,
      );
  });

  test("from a sandboxed frame or a file, which send Origin: null, is refused", () => {
    expect(
      status(request(API, { origin: "null", type: "text/plain", body: RULE })),
    ).toBe(403);
  });

  test("with no Origin but a browser's Sec-Fetch-Site naming another site is refused", () => {
    for (const site of ["cross-site", "same-site"])
      expect(
        status(request(API, { site, type: "application/json", body: RULE })),
      ).toBe(403);
  });

  test("a read is left to CORS, which already keeps another site from reading the answer", () => {
    expect(status(request(API, { method: "GET", origin: EVIL }))).toBe("ok");
  });
});

describe("the app's own requests", () => {
  test("pass from every address a local install is opened at", () => {
    for (const origin of [
      "http://localhost:3010",
      "http://127.0.0.1:3010",
      "http://[::1]:3010",
      "http://localhost:3001",
    ])
      expect(
        status(request(API, { origin, type: "application/json", body: RULE })),
      ).toBe("ok");
  });

  test("an upload passes, and so does a body-less change", () => {
    const origin = "http://localhost:3010";
    expect(
      status(
        request("http://localhost:3001/api/channels/c1/attachments", {
          origin,
          type: "multipart/form-data; boundary=x",
          body: "--x--",
        }),
      ),
    ).toBe("ok");
    expect(
      status(
        request("http://localhost:3001/api/attachments/a1", {
          method: "DELETE",
          origin,
        }),
      ),
    ).toBe("ok");
  });

  test("but a body that is not JSON is refused even from the app's own page", () => {
    const origin = "http://localhost:3010";
    for (const type of [
      "text/plain",
      "text/plain;charset=UTF-8",
      "application/x-www-form-urlencoded",
    ])
      expect(status(request(API, { origin, type, body: RULE }))).toBe(415);
    // A Blob with no type, which a page can send cross-site without asking.
    expect(status(request(API, { origin, body: RULE }))).toBe(415);
  });

  test("every TRUSTED_ORIGINS entry counts, including in single-user mode, as the desktop writes them", () => {
    const desktop = appOrigins(
      loadConfig(
        singleUserEnvironment({
          APP_PORT: "3456",
          TRUSTED_ORIGINS:
            "http://localhost:3456,http://127.0.0.1:3456,http://[::1]:3456",
        }),
        {},
      ),
    );
    for (const origin of [
      "http://localhost:3456",
      "http://127.0.0.1:3456",
      "http://[::1]:3456",
    ])
      expect(
        crossSiteRefusal(
          request(API, { origin, type: "application/json", body: RULE }),
          desktop,
        ),
      ).toBeNull();
  });
});

describe("a caller that is not a page", () => {
  test("sends no Origin and passes to the route's own authentication", () => {
    // The worker, a Bot with its token, the mobile app with its cookie, curl.
    expect(status(request(API, { type: "application/json", body: RULE }))).toBe(
      "ok",
    );
    // Bun's own fetch sends a string body with no type at all.
    expect(status(request(API, { body: RULE }))).toBe("ok");
    expect(
      status(
        request(API, {
          site: "same-origin",
          type: "application/json",
          body: RULE,
        }),
      ),
    ).toBe("ok");
    expect(
      status(
        request(API, { site: "none", type: "application/json", body: RULE }),
      ),
    ).toBe("ok");
  });

  test("but a JSON document sent as text/plain is refused, as no client of this server sends one", () => {
    expect(status(request(API, { type: "text/plain", body: RULE }))).toBe(415);
  });

  test("signed ingress keeps the types its senders use", () => {
    // AWS SNS posts text/plain; Twilio posts forms. Each is signed over its body.
    expect(
      status(
        request("http://localhost:3001/api/events/email/sns", {
          type: "text/plain; charset=UTF-8",
          body: "{}",
        }),
      ),
    ).toBe("ok");
    expect(
      status(
        request("http://localhost:3001/api/delivery/webhooks/sms", {
          type: "application/x-www-form-urlencoded",
          body: "From=%2B1",
        }),
      ),
    ).toBe("ok");
    // A page still may not post to them.
    expect(
      status(
        request("http://localhost:3001/api/events/triggers/t1", {
          origin: EVIL,
          type: "text/plain",
          body: "{}",
        }),
      ),
    ).toBe(403);
  });

  test("sign-in is Better Auth's to check, including a SAML identity provider's cross-site post", () => {
    expect(
      status(
        request("http://localhost:3001/api/auth/sso/saml2/sp/acs/acme", {
          origin: "https://idp.acme.example",
          type: "application/x-www-form-urlencoded",
          body: "SAMLResponse=x",
        }),
      ),
    ).toBe("ok");
  });

  test("the worker's handoff, outside /api, passes as it always did", () => {
    expect(
      status(
        request("http://localhost:3001/internal/routines/run", {
          type: "application/json",
          body: "{}",
        }),
      ),
    ).toBe("ok");
  });
});

/*
 * Hono decodes a path before it routes it. Scoped to the path as sent, `/%61pi/approvals/rules`
 * had no `/api` in it, was not checked, and reached the approvals route from another site.
 */
describe("a path spelled another way", () => {
  test("is checked as the route that answers it", () => {
    for (const path of [
      "/%61pi/approvals/rules",
      "/api/%61pprovals/rules",
      "/api/auth/%2e%2e/approvals/rules",
      "/%61pi/auth/../approvals/rules",
    ])
      expect(
        status(
          request(`http://localhost:3001${path}`, {
            origin: EVIL,
            type: "text/plain",
            body: RULE,
          }),
        ),
      ).toBe(403);
  });

  test("is exempt only when every reading of it is under the exemption", () => {
    // `/%61pi/auth/` reads as `/api/auth/` once decoded, and as nothing exempt as sent.
    expect(
      status(
        request("http://localhost:3001/%61pi/auth/sign-out", {
          origin: EVIL,
        }),
      ),
    ).toBe(403);
    expect(
      status(
        request("http://localhost:3001/api/auth/sign-out", { origin: EVIL }),
      ),
    ).toBe("ok");
  });
});

describe("a WebSocket", () => {
  const events = "http://localhost:3001/api/channels/events";
  const stream = "http://localhost:3001/api/computers/bot-1/stream";

  test("opened by another site is refused, for channel activity and for the live screen", () => {
    for (const url of [events, stream])
      expect(
        status(request(url, { method: "GET", origin: EVIL, upgrade: true })),
      ).toBe(403);
  });

  test("opened by the app passes, from the app's port to the server's", () => {
    for (const url of [events, stream])
      expect(
        status(
          request(url, {
            method: "GET",
            origin: "http://127.0.0.1:3010",
            upgrade: true,
          }),
        ),
      ).toBe("ok");
  });
});

describe("the address the request came to", () => {
  test("counts as the page's own when it is an IP address or loopback", () => {
    // OPENBOT_HOST opened on a LAN address: the page and its sockets, on the app's port too.
    for (const origin of [
      "http://192.168.1.10:3001",
      "http://192.168.1.10:3010",
    ])
      expect(
        status(
          request("http://192.168.1.10:3001/api/approvals/rules", {
            origin,
            type: "application/json",
            body: RULE,
          }),
        ),
      ).toBe("ok");
    // `docker run -p 8080:3001`, opened at the published port.
    expect(
      status(
        request("http://localhost:8080/api/approvals/rules", {
          origin: "http://localhost:8080",
          type: "application/json",
          body: RULE,
        }),
      ),
    ).toBe("ok");
  });

  test("but not another port on that address, and never a name, which could be a rebinding", () => {
    expect(
      status(
        request("http://192.168.1.10:3001/api/approvals/rules", {
          origin: "http://192.168.1.10:8000",
          type: "application/json",
          body: RULE,
        }),
      ),
    ).toBe(403);
    // evil.example re-pointed at 127.0.0.1: same origin to the browser, refused here.
    expect(
      status(
        request("http://evil.example:3001/api/approvals/rules", {
          origin: "http://evil.example:3001",
          type: "application/json",
          body: RULE,
        }),
      ),
    ).toBe(403);
  });

  test("a deployment's configured public address counts, behind whatever proxy", () => {
    const hosted = appOrigins(
      loadConfig(
        testEnvironment({
          BETTER_AUTH_URL: "https://openbot.example.com",
          TRUSTED_ORIGINS: "https://openbot.example.com",
        }),
        {},
      ),
    );
    expect(
      crossSiteRefusal(
        request("http://10.0.0.7:3001/api/approvals/rules", {
          origin: "https://openbot.example.com",
          type: "application/json",
          body: RULE,
        }),
        hosted,
      ),
    ).toBeNull();
    expect(
      crossSiteRefusal(
        request("http://10.0.0.7:3001/api/approvals/rules", {
          origin: EVIL,
          type: "application/json",
          body: RULE,
        }),
        hosted,
      )?.status,
    ).toBe(403);
  });
});

/*
 * The same repro through the assembled app: the guard is mounted in front of every route, so the
 * approvals route is never reached by the forged request, and is by the app's own.
 */
describe("the assembled app", () => {
  function app() {
    const created: unknown[] = [];
    const approvals = {
      createRule: async (_owner: string, input: unknown) => {
        created.push(input);
        return { id: "rule-1", ...(input as object) };
      },
    } as unknown as ApprovalService;
    const args: unknown[] = [loadConfig(singleUserEnvironment(), {})];
    args[34] = { approvals };
    return {
      created,
      app: (
        createApp as (...values: unknown[]) => ReturnType<typeof createApp>
      )(...args),
    };
  }

  test("refuses the forged rule and keeps the app's own", async () => {
    const { app: served, created } = app();
    const forged = await served.request(
      request(API, { origin: EVIL, type: "text/plain", body: RULE }),
    );
    expect(forged.status).toBe(403);
    const encoded = await served.request(
      request("http://localhost:3001/%61pi/approvals/rules", {
        origin: EVIL,
        type: "text/plain",
        body: RULE,
      }),
    );
    expect(encoded.status).toBe(403);
    const smuggled = await served.request(
      request(API, {
        origin: "http://localhost:3010",
        type: "text/plain",
        body: RULE,
      }),
    );
    expect(smuggled.status).toBe(415);
    expect(created).toEqual([]);

    const own = await served.request(
      request(API, {
        origin: "http://localhost:3010",
        type: "application/json",
        body: RULE,
      }),
    );
    expect(own.status).toBe(201);
    const mobile = await served.request(
      request(API, { type: "application/json", body: RULE }),
    );
    expect(mobile.status).toBe(201);
    expect(created).toHaveLength(2);
  });

  test("refuses another site's socket before any route sees it", async () => {
    const { app: served } = app();
    const response = await served.request(
      request("http://localhost:3001/api/channels/events", {
        method: "GET",
        origin: EVIL,
        upgrade: true,
      }),
    );
    expect(response.status).toBe(403);
  });
});
