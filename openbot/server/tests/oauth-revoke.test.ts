import { afterEach, describe, expect, test } from "bun:test";
import { revokeRefreshTokenOverHttp } from "../src/plugins/store";

/**
 * Withdrawing a person's refresh token at the vendor (RFC 7009), which is what Disconnect asks
 * before anything here is removed. Every outcome is one of four words, so the store can decide what
 * to keep and the trail can say what happened without carrying the vendor's text or the token.
 */

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Seen = {
  url: string;
  method: string | undefined;
  redirect: RequestRedirect | undefined;
  body: URLSearchParams;
};

function vendorAnswers(answer: () => Response | Promise<Response>): Seen[] {
  const seen: Seen[] = [];
  globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
    seen.push({
      url: String(url),
      method: init?.method,
      redirect: init?.redirect,
      body: new URLSearchParams(String(init?.body)),
    });
    return answer();
  }) as unknown as typeof fetch;
  return seen;
}

const ask = (client = { clientId: "c-1", clientSecret: "s-1" }) =>
  revokeRefreshTokenOverHttp({
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    client,
    refreshToken: "rt-1",
  });

describe("asking the vendor to withdraw a refresh token", () => {
  test("posts the token, as this client, to the catalogue's address only", async () => {
    const seen = vendorAnswers(() => new Response(null, { status: 200 }));

    expect(await ask()).toBe("revoked");

    expect(seen).toHaveLength(1);
    expect(seen[0]?.url).toBe("https://oauth2.googleapis.com/revoke");
    expect(seen[0]?.method).toBe("POST");
    // The request carries a secret, so a redirect is never followed.
    expect(seen[0]?.redirect).toBe("manual");
    expect(Object.fromEntries(seen[0]?.body ?? [])).toEqual({
      token: "rt-1",
      token_type_hint: "refresh_token",
      client_id: "c-1",
      client_secret: "s-1",
    });
  });

  test("a public client sends no empty secret, and no client still asks with the token", async () => {
    const seen = vendorAnswers(() => new Response(null, { status: 200 }));

    await ask({ clientId: "public", clientSecret: "" });
    await revokeRefreshTokenOverHttp({
      revokeUrl: "https://vendor.example/revoke",
      client: null,
      refreshToken: "rt-2",
    });

    expect(seen[0]?.body.has("client_secret")).toBe(false);
    expect(seen[0]?.body.get("client_id")).toBe("public");
    expect(Object.fromEntries(seen[1]?.body ?? [])).toEqual({
      token: "rt-2",
      token_type_hint: "refresh_token",
    });
  });

  test("a token the vendor already calls invalid is already gone", async () => {
    for (const error of ["invalid_token", "invalid_grant"]) {
      vendorAnswers(() => Response.json({ error }, { status: 400 }));
      expect(await ask()).toBe("already_gone");
    }
  });

  test("any other answer on purpose is a refusal, a redirect included", async () => {
    for (const answer of [
      () => Response.json({ error: "invalid_client" }, { status: 401 }),
      () => Response.json({ error: "invalid_request" }, { status: 400 }),
      () => new Response("<html>nope</html>", { status: 400 }),
      () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://elsewhere.example/revoke" },
        }),
    ]) {
      vendorAnswers(answer);
      expect(await ask()).toBe("refused");
    }
  });

  test("no answer, a server error or a rate limit is unreachable, and nothing throws", async () => {
    for (const answer of [
      () => new Response(null, { status: 503 }),
      () => new Response(null, { status: 429 }),
      () => Promise.reject(new TypeError("fetch failed")),
    ]) {
      vendorAnswers(answer);
      expect(await ask()).toBe("unreachable");
    }
  });
});
