import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setSystemTime,
  test,
} from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import {
  type FakeGoogle,
  type SentMessage,
  startFakeGoogle,
} from "../../scripts/fake-google/server";
import { catalogueFor, hostAdmissible } from "../src/plugins/catalogue";
import { callTool } from "../src/plugins/google-workspace-rest";
import {
  authorizationUrlFor,
  challengeFor,
  createVerifier,
  redeemAuthorizationCode,
} from "../src/plugins/oauth";
import {
  exchangeRefreshTokenOverHttp,
  revokeRefreshTokenOverHttp,
} from "../src/plugins/plugin-store/model";

/**
 * The Gmail and Calendar adapter against the fake Google, over a real socket.
 *
 * The adapter's own tests stub `fetch` and check each request in isolation. This drives the whole
 * round a demo does: consent, search, read, reply, and then asks the fake what it received. The fake
 * was written from Google's documented shapes rather than from the adapter, so the two agreeing here
 * is evidence about both. It also files a reply in the thread it names only when the reply's
 * threading headers point into that thread, as Gmail does, so a reply that would not thread at
 * Google does not thread here either.
 */

type Seed = {
  id: string;
  label: string;
  why: string;
  from: string;
  subject: string;
  body: string;
};

const seeds: Seed[] = readFileSync(
  new URL("../../../evals/triage/emails.jsonl", import.meta.url),
  "utf8",
)
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

let fake: FakeGoogle;
let connection: { url: string; token: string };

/** Consent and redeem the code with PKCE, as OpenBot's connection flow does. */
async function signIn(base: string): Promise<{
  access_token: string;
  refresh_token: string;
  scope: string;
}> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const consent = new URL(`${base}/o/oauth2/v2/auth`);
  consent.search = new URLSearchParams({
    client_id: "test-client",
    redirect_uri: "http://127.0.0.1:3001/api/plugins/oauth/callback",
    response_type: "code",
    state: "sealed-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  }).toString();

  const redirected = await fetch(consent, { redirect: "manual" });
  expect(redirected.status).toBe(302);
  const back = new URL(redirected.headers.get("location") ?? "");
  expect(back.origin + back.pathname).toBe(
    "http://127.0.0.1:3001/api/plugins/oauth/callback",
  );
  expect(back.searchParams.get("state")).toBe("sealed-state");

  const tokens = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code") ?? "",
      client_id: "test-client",
      client_secret: "test-secret",
      redirect_uri: "http://127.0.0.1:3001/api/plugins/oauth/callback",
      code_verifier: verifier,
    }),
  });
  expect(tokens.status).toBe(200);
  return tokens.json();
}

const sentSoFar = async (): Promise<SentMessage[]> =>
  (await fetch(`${fake.url}/__fake/sent`)).json();

beforeAll(async () => {
  fake = startFakeGoogle({ port: 0 });
  const tokens = await signIn(fake.url);
  connection = { url: fake.url, token: tokens.access_token };
});

afterAll(async () => {
  await fake.stop();
});

describe("the fake's own OAuth", () => {
  test("grants the three scopes the connector asks for, with a refresh token", async () => {
    const tokens = await signIn(fake.url);
    expect(tokens.refresh_token).toStartWith("fake-refresh-");
    expect(tokens.scope.split(" ").sort()).toEqual([
      "https://www.googleapis.com/auth/calendar.readonly",
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
    ]);
  });

  test("without a redirect_uri it shows who is signed in", async () => {
    const response = await fetch(`${fake.url}/o/oauth2/v2/auth`);
    expect(await response.text()).toContain(
      "Fake Google: signed in as <strong>maya@marlowceramics.com</strong>",
    );
  });

  test("a wrong PKCE verifier is refused, as Google refuses it", async () => {
    const consent = await fetch(
      `${fake.url}/o/oauth2/v2/auth?redirect_uri=http://127.0.0.1:3001/cb&code_challenge=abc&code_challenge_method=S256`,
      { redirect: "manual" },
    );
    const code =
      new URL(consent.headers.get("location") ?? "").searchParams.get("code") ??
      "";
    const refused = await fetch(`${fake.url}/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: "test-client",
        redirect_uri: "http://127.0.0.1:3001/cb",
        code_verifier: "not-the-verifier",
      }),
    });
    expect(refused.status).toBe(400);
    expect((await refused.json()).error).toBe("invalid_grant");
  });

  test("a refresh token renews access until it is revoked", async () => {
    const { refresh_token } = await signIn(fake.url);
    const refresh = () =>
      fetch(`${fake.url}/token`, {
        method: "POST",
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token,
          client_id: "test-client",
        }),
      });

    const renewed = await refresh();
    expect(renewed.status).toBe(200);
    const { access_token } = await renewed.json();
    const works = await callTool(
      { url: fake.url, token: access_token },
      "calendar_list_events",
      {},
    );
    expect(works.isError).toBe(false);

    const revoked = await fetch(`${fake.url}/revoke`, {
      method: "POST",
      body: new URLSearchParams({ token: refresh_token }),
    });
    expect(revoked.status).toBe(200);
    expect((await refresh()).status).toBe(400);
    // The whole grant ends, so the access token minted from it stops working too.
    const after = await callTool(
      { url: fake.url, token: access_token },
      "calendar_list_events",
      {},
    );
    expect(after.isError).toBe(true);
    expect(after.text).toContain("(401)");
  });

  test("Disconnect's revocation, sent as the store sends it, ends the grant", async () => {
    const { refresh_token } = await signIn(fake.url);

    expect(
      await revokeRefreshTokenOverHttp({
        revokeUrl: `${fake.url}/revoke`,
        client: { clientId: "test-client", clientSecret: "test-secret" },
        refreshToken: refresh_token,
      }),
    ).toBe("revoked");

    const renewed = await fetch(`${fake.url}/token`, {
      method: "POST",
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token,
        client_id: "test-client",
      }),
    });
    expect(renewed.status).toBe(400);
  });

  test("an API call without a valid token is a 401, which the adapter says how to fix", async () => {
    const result = await callTool(
      { url: fake.url, token: "fake-access-made-up" },
      "gmail_search_messages",
      {},
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("(401)");
    expect(result.text).toContain("Reconnecting");
  });
});

/*
 * The override and the fake together, through OpenBot's own OAuth code: the consent URL it builds,
 * the code redemption and the refresh it does on every call. If the override moved the API host and
 * not the token endpoint, or the fake answered a shape OpenBot does not read, this is where it shows.
 */
describe("OpenBot's own connection flow, pointed at the fake by the override", () => {
  test("consents, redeems, refreshes and calls, all at the fake", async () => {
    const workspace = catalogueFor(
      { OPENDUET_FAKE_GOOGLE_URL: fake.url, NODE_ENV: "development" },
      () => {},
    ).find((entry) => entry.key === "google-workspace");
    if (workspace?.auth.kind !== "user-oauth" || workspace.host === null) {
      throw new Error("the override did not produce a user-oauth entry");
    }
    expect(hostAdmissible(workspace, fake.url)).toBe(true);

    const verifier = createVerifier();
    const redirectUri = "http://localhost:3001/api/plugins/oauth/callback";
    const consent = new URL(
      authorizationUrlFor({
        auth: workspace.auth,
        clientId: "test-client",
        redirectUri,
        state: "sealed",
        codeChallenge: challengeFor(verifier),
      }),
    );
    expect(consent.origin).toBe(fake.url);
    expect(consent.searchParams.get("access_type")).toBe("offline");
    expect(consent.searchParams.get("prompt")).toBe("consent");

    const redirected = await fetch(consent, { redirect: "manual" });
    const code =
      new URL(redirected.headers.get("location") ?? "").searchParams.get(
        "code",
      ) ?? "";
    const grant = await redeemAuthorizationCode({
      tokenUrl: workspace.auth.tokenUrl,
      clientId: "test-client",
      clientSecret: "test-secret",
      code,
      redirectUri,
      verifier,
    });
    if (!grant) throw new Error("the fake refused OpenBot's code redemption");
    expect(grant.scope.split(" ").sort()).toEqual(
      [...workspace.auth.scopes].sort(),
    );

    const access = await exchangeRefreshTokenOverHttp({
      tokenUrl: workspace.auth.tokenUrl,
      client: { clientId: "test-client", clientSecret: "test-secret" },
      refreshToken: grant.refreshToken,
    });
    const result = await callTool(
      { url: workspace.host, token: access.accessToken },
      "gmail_search_messages",
      {},
    );
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text).resultSizeEstimate).toBe(seeds.length);
  });
});

describe("the adapter against the fake", () => {
  test("a default search finds the last day of the inbox, in the contract's shape", async () => {
    const result = await callTool(connection, "gmail_search_messages", {});
    expect(result.isError).toBe(false);
    const found = JSON.parse(result.text);

    // Every one of the set arrived within the last day; twenty-five is the default page.
    expect(found.resultSizeEstimate).toBe(seeds.length);
    expect(found.messages).toHaveLength(25);
    for (const message of found.messages) {
      expect(Object.keys(message).sort()).toEqual(
        [
          "cc",
          "date",
          "from",
          "headers",
          "id",
          "labels",
          "snippet",
          "subject",
          "threadId",
          "to",
        ].sort(),
      );
      // To Maya, or to a group she is in, which says so in its List-Id.
      expect(
        message.to.includes("maya@marlowceramics.com") ||
          "List-Id" in message.headers,
      ).toBe(true);
      expect(Date.now() - Date.parse(message.date)).toBeLessThan(86_400_000);
    }
    // Newest first, as Gmail lists them.
    const dates = found.messages.map((message: { date: string }) =>
      Date.parse(message.date),
    );
    expect(dates).toEqual([...dates].sort((a, b) => b - a));
  });

  test("the whole mailbox comes back at the maximum of fifty, with the headers triage reads", async () => {
    const result = await callTool(connection, "gmail_search_messages", {
      maxResults: 50,
    });
    const found = JSON.parse(result.text);
    expect(found.messages).toHaveLength(50);
    const bulk = found.messages.filter(
      (message: { headers: Record<string, string> }) =>
        "List-Unsubscribe" in message.headers,
    );
    expect(bulk.length).toBeGreaterThan(0);
    for (const message of bulk) {
      // A newsletter says bulk, a Google Group says list, a mailing service may say neither.
      expect([undefined, "bulk", "list"]).toContain(message.headers.Precedence);
    }
    // The security report to Maya's group comes with the group it went through.
    expect(
      found.messages.some(
        (message: { headers: Record<string, string> }) =>
          message.headers["List-Id"] === "<security.marlowceramics.com>",
      ),
    ).toBe(true);
    // The eval's answers are never served, only the mail.
    expect(result.text).not.toContain("needs_you");
    for (const seed of seeds) expect(result.text).not.toContain(seed.why);
  });

  test("a Gmail query narrows the search", async () => {
    const result = await callTool(connection, "gmail_search_messages", {
      query: "category:promotions",
      maxResults: 50,
    });
    const found = JSON.parse(result.text);
    expect(found.messages.length).toBeGreaterThan(0);
    for (const message of found.messages) {
      expect(message.labels).toContain("CATEGORY_PROMOTIONS");
    }
  });

  test("searching, reading and replying lands one threaded reply in the fake's sent list", async () => {
    await fetch(`${fake.url}/__fake/reset`, { method: "POST" });
    expect(await sentSoFar()).toEqual([]);

    const seed = seeds.find((candidate) => candidate.id === "n01");
    if (!seed) throw new Error("the eval set has no n01");

    const search = JSON.parse(
      (
        await callTool(connection, "gmail_search_messages", {
          query: 'from:ana@hearthandco.com subject:"ship date"',
        })
      ).text,
    );
    expect(search.messages).toHaveLength(1);
    const [hit] = search.messages;
    expect(hit.subject).toBe(seed.subject);

    const read = JSON.parse(
      (await callTool(connection, "gmail_read_message", { id: hit.id })).text,
    );
    expect(read.body).toBe(seed.body);
    expect(read.messageId).toMatch(/^<n01\.[0-9a-f]{8}@hearthandco\.com>$/);

    const reply = await callTool(connection, "gmail_send_reply", {
      threadId: read.threadId,
      inReplyTo: read.id,
      to: [read.from],
      subject: read.subject,
      body: "Hi Ana,\nYes, the 120 mugs ship Friday.\nMaya",
    });
    expect(reply.isError).toBe(false);
    const answer = JSON.parse(reply.text);
    expect(answer.sent).toBe(true);

    const sent = await sentSoFar();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      id: answer.id,
      // The fake keeps a reply in the named thread only when its headers point into that thread.
      threadId: read.threadId,
      to: ["Ana Pereira <ana@hearthandco.com>"],
      cc: [],
      bcc: [],
      subject: `Re: ${seed.subject}`,
      body: "Hi Ana,\nYes, the 120 mugs ship Friday.\nMaya",
      inReplyTo: read.messageId,
      references: read.messageId,
    });
    expect(answer.threadId).toBe(read.threadId);

    // And it is in the mailbox as sent mail, where a later search finds it.
    const sentMail = JSON.parse(
      (
        await callTool(connection, "gmail_search_messages", {
          query: "in:sent",
        })
      ).text,
    );
    expect(sentMail.messages.map((m: { id: string }) => m.id)).toEqual([
      answer.id,
    ]);
  });

  test("a reply named by the message's Message-ID, as a model often names it, is threaded the same", async () => {
    await fetch(`${fake.url}/__fake/reset`, { method: "POST" });
    const search = JSON.parse(
      (
        await callTool(connection, "gmail_search_messages", {
          query: 'from:ana@hearthandco.com subject:"ship date"',
        })
      ).text,
    );
    const read = JSON.parse(
      (
        await callTool(connection, "gmail_read_message", {
          id: search.messages[0].id,
        })
      ).text,
    );
    const reply = await callTool(connection, "gmail_send_reply", {
      threadId: read.threadId,
      inReplyTo: read.messageId,
      to: [read.from],
      subject: read.subject,
      body: "Hi Ana, would Tuesday work instead? Maya",
    });
    expect(reply.isError).toBe(false);
    const [sent] = await sentSoFar();
    expect(sent?.threadId).toBe(read.threadId);
    expect(sent?.inReplyTo).toBe(read.messageId);

    // A Message-ID that is not in the mailbox is refused, and nothing is sent.
    const stray = await callTool(connection, "gmail_send_reply", {
      threadId: read.threadId,
      inReplyTo: "<nobody@example.com>",
      to: [read.from],
      subject: read.subject,
      body: "Hi",
    });
    expect(stray.isError).toBe(true);
    expect(stray.text).toContain(
      "No message in this mailbox has that Message-ID",
    );
    expect(await sentSoFar()).toHaveLength(1);
  });

  test("an HTML-only message is read as the words it holds", async () => {
    const result = JSON.parse(
      (
        await callTool(connection, "gmail_search_messages", {
          query: "category:promotions",
        })
      ).text,
    );
    const html = result.messages.find(
      (message: { headers: Record<string, string> }) =>
        "List-Unsubscribe" in message.headers,
    );
    if (!html) throw new Error("no bulk mail in promotions");
    const read = JSON.parse(
      (await callTool(connection, "gmail_read_message", { id: html.id })).text,
    );
    const seed = seeds.find((candidate) => candidate.subject === read.subject);
    expect(read.body).toBe(seed?.body);
    expect(read.body).not.toContain("<");
  });

  test("reset puts the mailbox back and forgets what was sent", async () => {
    const [first] = JSON.parse(
      (await callTool(connection, "gmail_search_messages", {})).text,
    ).messages;
    const sending = await callTool(connection, "gmail_send_reply", {
      threadId: first.threadId,
      inReplyTo: first.id,
      to: ["nobody@example.com"],
      subject: first.subject,
      body: "Something to forget.",
    });
    expect(sending.isError).toBe(false);
    expect((await sentSoFar()).length).toBeGreaterThan(0);

    await fetch(`${fake.url}/__fake/reset`, { method: "POST" });
    expect(await sentSoFar()).toEqual([]);
    const all = JSON.parse(
      (
        await callTool(connection, "gmail_search_messages", {
          query: "in:anywhere",
          maxResults: 50,
        })
      ).text,
    );
    expect(all.resultSizeEstimate).toBe(seeds.length);
  });

  test("delivered mail arrives dated now, and an after: search finds only what is new", async () => {
    await fetch(`${fake.url}/__fake/reset`, { method: "POST" });
    const search = async (query: string) =>
      JSON.parse(
        (
          await callTool(connection, "gmail_search_messages", {
            query,
            maxResults: 50,
          })
        ).text,
      );
    // The seeded mail is at least five minutes old, so nothing is newer than a minute ago.
    const since = Math.floor(Date.now() / 1000) - 60;
    expect((await search(`in:inbox after:${since}`)).resultSizeEstimate).toBe(
      0,
    );

    const deliver = (body: unknown) =>
      fetch(`${fake.url}/__fake/deliver`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await deliver({ from: "Priya <priya@example.com>" })).status).toBe(
      400,
    );
    const delivered = await deliver({
      from: "Priya Natarajan <priya@hearthandco.example>",
      subject: "My order arrived broken",
      body: "Two of the six mugs arrived in pieces. Can you send replacements today? We open on Saturday.",
    });
    expect(delivered.status).toBe(201);
    const { id } = (await delivered.json()) as { id: string };

    const fresh = await search(`in:inbox after:${since}`);
    expect(fresh.messages.map((message: { id: string }) => message.id)).toEqual(
      [id],
    );
    expect(fresh.messages[0]).toMatchObject({
      subject: "My order arrived broken",
      from: "Priya Natarajan <priya@hearthandco.example>",
      to: ["maya@marlowceramics.com"],
    });
    expect(fresh.messages[0].labels).toEqual(
      expect.arrayContaining(["INBOX", "UNREAD"]),
    );
    // before: is the other side of the same line, and a date counts from the start of that day.
    expect(
      (await search(`before:${since}`)).messages.map(
        (message: { id: string }) => message.id,
      ),
    ).not.toContain(id);
    expect((await search("after:2001/01/01")).resultSizeEstimate).toBe(
      seeds.length + 1,
    );

    // A reset takes delivered mail away again.
    await fetch(`${fake.url}/__fake/reset`, { method: "POST" });
    expect((await search(`in:inbox after:${since}`)).resultSizeEstimate).toBe(
      0,
    );
  });

  test("the calendar holds the studio's day, in order", async () => {
    // The studio is at UTC-7, so its day is 07:00 UTC to 07:00 UTC the next day.
    const local = new Date(Date.now() - 7 * 3_600_000);
    const dayStart =
      Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate(),
      ) +
      7 * 3_600_000;
    const result = await callTool(connection, "calendar_list_events", {
      timeMin: new Date(dayStart).toISOString(),
      timeMax: new Date(dayStart + 86_400_000).toISOString(),
    });
    expect(result.isError).toBe(false);
    const { events } = JSON.parse(result.text);

    expect(events.map((event: { summary: string }) => event.summary)).toEqual([
      "Kiln 2 out of service",
      "Glaze test review",
      "Lunch with Priya Shah: quarterly taxes",
      "Studio visit with Hearth & Co",
      "Pack the 120 mugs for Hearth & Co",
      "Makers Market vendor call",
      "Evening wheel class",
    ]);
    const glaze = events.find(
      (event: { id: string }) => event.id === "glazetestreview",
    );
    expect(glaze.start).toMatch(/T10:00:00-07:00$/);
    expect(glaze.location).toBe("Studio, glaze room");
    expect(glaze.organizer).toBe("maya@marlowceramics.com");
    expect(glaze.attendees).toContain("leo@marlowceramics.com");
    const visit = events.find(
      (event: { id: string }) => event.id === "studiovisithearthandco",
    );
    expect(visit.start).toMatch(/T15:00:00-07:00$/);
    // An all-day event is a date, not a midnight.
    expect(events[0].start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test("with no arguments the calendar answers with what is left of today, in the studio's zone", async () => {
    const result = await callTool(connection, "calendar_list_events", {});
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.text);
    // Read from the calendar, which is where the fake keeps the studio's zone, as Google does.
    expect(parsed.timeZone).toBe("America/Los_Angeles");
    expect(Object.keys(parsed)).not.toContain("note");
    for (const event of parsed.events) {
      // Google's bound: an event is included while it has not yet ended.
      if (event.end.includes("T")) {
        expect(Date.parse(event.end)).toBeGreaterThan(Date.now() - 60_000);
      }
    }
  });

  test("at 13:00 in the studio, the rest of today still holds the evening", async () => {
    // 13:00 PDT, when the UTC day has four hours left and the studio's has eleven.
    const oneInTheAfternoon = Date.parse("2026-10-22T20:00:00Z");
    setSystemTime(new Date(oneInTheAfternoon));
    const afternoon = startFakeGoogle({ now: () => oneInTheAfternoon });
    try {
      const { access_token } = await signIn(afternoon.url);
      const result = await callTool(
        { url: afternoon.url, token: access_token },
        "calendar_list_events",
        {},
      );
      expect(result.isError).toBe(false);
      const parsed = JSON.parse(result.text);
      expect(parsed.timeZone).toBe("America/Los_Angeles");
      expect(
        parsed.events.map((event: { summary: string }) => event.summary),
      ).toEqual([
        "Kiln 2 out of service",
        "Lunch with Priya Shah: quarterly taxes",
        "Studio visit with Hearth & Co",
        // Everything from here on starts after 17:00 PDT, which is midnight UTC.
        "Pack the 120 mugs for Hearth & Co",
        "Makers Market vendor call",
        "Evening wheel class",
      ]);
      const evening = parsed.events.at(-1);
      expect(evening.start).toBe("2026-10-22T19:30:00-07:00");
    } finally {
      setSystemTime();
      await afternoon.stop();
    }
  });
});
