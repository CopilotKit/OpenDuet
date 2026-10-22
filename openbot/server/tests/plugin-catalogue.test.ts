import { describe, expect, test } from "bun:test";
import {
  CATALOGUE,
  type CatalogueEntry,
  catalogueEntry,
  catalogueFor,
  classifyTool,
  customUrlRefusal,
  fakeGoogleOrigin,
  hostAdmissible,
  resolveServerUrl,
  serverCredentialKind,
} from "../src/plugins/catalogue";
import { shareTargetOf } from "../src/plugins/share-target";

/**
 * The catalogue decides two things that are worth being sure about: which addresses this deployment
 * will talk to at all, and which of a server's tools change something.
 *
 * Both fail closed, and both are tested for that rather than for the happy path. An admissibility
 * check that accepts one address too many is a request-forgery primitive; an effect classifier that
 * calls a write a read is a governance surface that quietly stops covering the thing it exists for.
 */

describe("which servers this deployment will talk to", () => {
  test("a pinned host matches only itself", () => {
    const drive = catalogueEntry("google-drive");
    expect(drive).not.toBeNull();
    expect(hostAdmissible(drive!, "https://www.googleapis.com")).toBe(true);
    // A prefix, a suffix and a lookalike are each refused. The suffix case is the one that matters:
    // a check written with endsWith rather than equality would accept it.
    expect(hostAdmissible(drive!, "https://www.googleapis.com.evil.test")).toBe(
      false,
    );
    expect(hostAdmissible(drive!, "https://evil.test/www.googleapis.com")).toBe(
      false,
    );
    expect(hostAdmissible(drive!, "http://www.googleapis.com")).toBe(false);
    // The MCP host this entry used to name. Now inadmissible, which is the point of pinning: moving
    // the entry to the GA API is also a decision to stop talking to the preview endpoint.
    expect(hostAdmissible(drive!, "https://drivemcp.googleapis.com")).toBe(
      false,
    );
  });

  test("an entry whose pattern this build never compiled is refused", () => {
    /*
     * WHAT THIS NO LONGER COVERS. ServiceNow was the only per-instance entry, and removing it took
     * the anchored-pattern assertions with it — that a prefix, a suffix and a subdomain are each
     * refused. `PATTERNS` is compiled from the catalogue by KEY, so an entry this build never
     * compiled a pattern for reaches no pattern, and there is no way left to exercise the matching
     * itself through the public API.
     *
     * What survives is the fail-closed half, which is worth keeping on its own: an entry claiming to
     * be per-instance that this build has no pattern for is refused rather than admitted. Whoever
     * adds the next per-instance vendor should restore the anchoring cases with it.
     *
     * THE KEY IS DELIBERATELY ONE NO ENTRY HOLDS, and asserted to be. This case used to borrow
     * `google-drive`, which passed only because no catalogue entry declares a `hostPattern` today:
     * `PATTERNS` is keyed, not identity-checked, so a synthetic entry that reuses a real key reaches
     * whatever pattern that key compiled. Giving Drive a pattern made the old version admit
     * `https://acme.service-now.com`. With an unheld key the lookup misses for the reason the test
     * names, whatever the catalogue later declares.
     */
    const perInstance = {
      key: "no-entry-holds-this-key",
      title: "Per-instance vendor",
      vendor: "Example",
      summary: "",
      host: null,
      hostPattern:
        "^https://([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)\\.service-now\\.com$",
      path: "/mcp",
      auth: { kind: "deployment-bearer" },
      writeTools: [],
      docsUrl: "",
    } as const;

    expect(catalogueEntry(perInstance.key)).toBeNull();
    // No compiled pattern for this key, so the entry's own `hostPattern` is never consulted and the
    // host is refused outright. That is itself the fail-closed property: no pattern means no.
    expect(hostAdmissible(perInstance, "https://acme.service-now.com")).toBe(
      false,
    );
  });

  test("a server not in the catalogue resolves to nothing", () => {
    expect(resolveServerUrl("not-a-vendor")).toBeNull();
    expect(catalogueEntry("not-a-vendor")).toBeNull();
  });

  test("the path is the catalogue's, never the caller's", () => {
    // An instance host offered for a vendor with a pinned host is ignored, not honoured: the host and
    // the path both come from the entry, so nothing a caller sends can reach another endpoint.
    expect(resolveServerUrl("google-drive", "https://evil.test").url).toBe(
      "https://www.googleapis.com/drive/v3",
    );
  });

  test("every catalogue entry pins a host or an anchored pattern", () => {
    for (const entry of CATALOGUE) {
      if (entry.host === null) {
        expect(entry.hostPattern).toBeDefined();
        // Anchored at both ends or the pattern is decoration.
        expect(entry.hostPattern?.startsWith("^")).toBe(true);
        expect(entry.hostPattern?.endsWith("$")).toBe(true);
      } else if (entry.auth.kind === "builtin") {
        // First-party and in-process: there is no host outside this process to reach, so the
        // https requirement below does not apply. Asserted positively instead, so this branch
        // cannot quietly become a loophole for a future entry that DOES dial a real host.
        expect(entry.host).toBe("builtin://routines");
      } else {
        expect(entry.host.startsWith("https://")).toBe(true);
      }
    }
  });
});

describe("whose credential a server uses", () => {
  test("every entry says which, rather than leaving it to be inferred", () => {
    // The whole point of replacing a `needsCredential` boolean. "Needs a credential" did not say
    // whose, and a reader who guessed would guess the deployment's, which for a user-oauth vendor
    // is the one answer that breaks the promise the connector exists to keep.
    for (const entry of CATALOGUE) {
      expect(["none", "deployment-bearer", "user-oauth", "builtin"]).toContain(
        entry.auth.kind,
      );
    }
  });

  test("a user-oauth entry pins its own endpoints over https and asks for a scope", () => {
    for (const entry of CATALOGUE) {
      if (entry.auth.kind !== "user-oauth") continue;
      // Pinned for the same reason the MCP host is: these are addresses this deployment sends a
      // person's authorization code and receives their refresh token at.
      expect(entry.auth.authorizationUrl.startsWith("https://")).toBe(true);
      expect(entry.auth.tokenUrl.startsWith("https://")).toBe(true);
      expect(entry.auth.revokeUrl.startsWith("https://")).toBe(true);
      // No scopes means consent to nothing, which would fail at the vendor with a message that
      // does not name us — except for a vendor whose consent screen itself is the scoping
      // (Notion, with dynamic client registration), where a scope string would assert a control
      // that does not exist.
      if (entry.auth.clientRegistration !== "dynamic") {
        expect(entry.auth.scopes.length).toBeGreaterThan(0);
      }
      if (entry.auth.clientRegistration === "dynamic") {
        expect(entry.auth.registrationUrl?.startsWith("https://")).toBe(true);
      }
    }
  });

  test("a vendor this build has never heard of is not an entry", () => {
    // The five bearer vendors that used to be asserted here are gone. What matters now is the same
    // property from the other side: a key with no entry resolves to nothing rather than to a default.
    for (const key of [
      "atlassian",
      "box",
      "slack",
      "salesforce",
      "servicenow",
    ]) {
      expect(catalogueEntry(key)).toBeNull();
      expect(resolveServerUrl(key)).toBeNull();
    }
  });
});

describe("Google Drive", () => {
  const drive = catalogueEntry("google-drive");

  test("resolves to the one address Google publishes for it", () => {
    expect(drive).not.toBeNull();
    /*
     * The GA REST API, not the MCP server. Google publishes both; the MCP one is gated behind the
     * Workspace Developer Preview Program and refuses an unenrolled project with a message about
     * permission that describes the project rather than the credential. Swapping back is `transport`
     * plus these two fields, which is why the transport is asserted alongside the address.
     */
    expect(resolveServerUrl("google-drive")?.url).toBe(
      "https://www.googleapis.com/drive/v3",
    );
    expect(drive?.transport).toBe("google-drive-rest");
  });

  test("is reached as the person asking, not as the deployment", () => {
    expect(drive?.auth.kind).toBe("user-oauth");
  });

  test("asks only to read", () => {
    // K1 answers questions and writes nothing. A wider scope would be granted by every person who
    // connects and used by nothing, which is the kind of permission nobody remembers agreeing to.
    expect(drive?.auth.kind === "user-oauth" ? drive.auth.scopes : []).toEqual([
      "https://www.googleapis.com/auth/drive.readonly",
    ]);
  });

  test("still calls its writes writes, and lets Google be the one to refuse them", () => {
    // The read-only scope means these fail at the vendor. They stay classified as writes anyway, so
    // a boundary written about writes keeps covering them if the scope ever widens.
    expect(classifyTool(drive, "create_file", true)).toBe("write");
    expect(classifyTool(drive, "copy_file", true)).toBe("write");
    expect(classifyTool(drive, "search_files", true)).toBe("read");
    expect(classifyTool(drive, "read_file_content", true)).toBe("read");
  });
});

describe("Gmail and Google Calendar", () => {
  const entry = catalogueEntry("google-workspace");

  test("is one entry, reached at the bare Google API host over its REST transport", () => {
    expect(entry).not.toBeNull();
    expect(entry?.title).toBe("Gmail and Google Calendar");
    expect(entry?.vendor).toBe("Google");
    expect(entry?.summary).toBe("Mail and calendar of whoever is asking.");
    expect(entry?.transport).toBe("google-workspace-rest");
    /*
     * The path is `/`, so the resolved url is the host itself and the adapter adds `/gmail/v1` or
     * `/calendar/v3`. Either prefix as the path would leave it rewriting one into the other.
     */
    expect(entry?.path).toBe("/");
    expect(resolveServerUrl("google-workspace")?.url).toBe(
      "https://www.googleapis.com",
    );
    expect(hostAdmissible(entry!, "https://www.googleapis.com")).toBe(true);
    expect(hostAdmissible(entry!, "https://gmail.googleapis.com")).toBe(false);
    // The fake's address, which only the development override can make admissible.
    expect(hostAdmissible(entry!, "http://127.0.0.1:4900")).toBe(false);
  });

  test("is reached as the person asking, at Google's own OAuth endpoints", () => {
    if (entry?.auth.kind !== "user-oauth") throw new Error("wrong auth kind");
    expect(entry.auth.authorizationUrl).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(entry.auth.tokenUrl).toBe("https://oauth2.googleapis.com/token");
    expect(entry.auth.revokeUrl).toBe("https://oauth2.googleapis.com/revoke");
    // Without both, Google returns no refresh token on a reconnect.
    expect(entry.auth.authorizationParams).toEqual({
      access_type: "offline",
      prompt: "consent",
    });
  });

  test("asks to read mail, send mail and read the calendar, and nothing wider", () => {
    expect(entry?.auth.kind === "user-oauth" ? entry.auth.scopes : []).toEqual([
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.send",
      "https://www.googleapis.com/auth/calendar.readonly",
    ]);
  });

  test("names its reads and its write explicitly", () => {
    expect(entry?.readTools).toEqual([
      "gmail_search_messages",
      "gmail_read_message",
      "calendar_list_events",
    ]);
    expect(entry?.writeTools).toEqual(["gmail_send_reply"]);
  });

  test("sending a reply is a write, and nothing can talk it down to a read", () => {
    expect(classifyTool(entry, "gmail_send_reply", true)).toBe("write");
    // A vendor-recorded effect may narrow and never widen.
    expect(classifyTool(entry, "gmail_send_reply", true, "read")).toBe("write");
    for (const name of [
      "gmail_search_messages",
      "gmail_read_message",
      "calendar_list_events",
    ]) {
      expect(classifyTool(entry, name, true)).toBe("read");
    }
  });

  test("a tool on neither list is a write, advertised or not", () => {
    // Because the entry names its reads, an advertised tool nobody listed cannot classify as one.
    expect(classifyTool(entry, "gmail_delete_message", true)).toBe("write");
    expect(classifyTool(entry, "calendar_create_event", true)).toBe("write");
    expect(classifyTool(entry, "gmail_search_messages", false)).toBe("write");
  });

  test("a reply is a send, so the private-share check asks about it too", () => {
    /*
     * Writes are the only calls that reach this check, so what matters is that the one write is
     * recognised as a send and that its recipients and words reach it: the owner is asked about the
     * right people and the right text.
     */
    const share = shareTargetOf("google-workspace", "gmail_send_reply", {
      to: ["ana@hearthandco.com"],
      subject: "Friday",
      body: "Yes, Friday.",
    });
    expect(share).not.toBeNull();
    expect(share?.audience.id).toBe("ana@hearthandco.com");
    expect(share?.content).toContain("Yes, Friday.");
  });
});

/*
 * OPENDUET_FAKE_GOOGLE_URL points the Gmail and Calendar entry at scripts/fake-google instead of
 * Google, for development and tests. Every address in the catalogue is a reviewed source contract
 * and this one comes from the environment, so it is refused in production. Both halves are tested:
 * that it works where it should, and that it is refused, with a warning, where it must not.
 */
describe("pointing Gmail and Calendar at a fake Google", () => {
  const fake = "http://127.0.0.1:4900";
  const google = "https://www.googleapis.com";
  const entryIn = (entries: readonly CatalogueEntry[], key: string) => {
    const found = entries.find((entry) => entry.key === key);
    if (!found) throw new Error(`no ${key} entry`);
    return found;
  };

  test("outside production, the entry's API host and OAuth endpoints are the fake's", () => {
    const warnings: string[] = [];
    const entries = catalogueFor(
      { OPENDUET_FAKE_GOOGLE_URL: `${fake}/`, NODE_ENV: "development" },
      (message) => warnings.push(message),
    );
    const workspace = entryIn(entries, "google-workspace");

    expect(warnings).toEqual([]);
    expect(workspace.host).toBe(fake);
    expect(hostAdmissible(workspace, fake)).toBe(true);
    // While it is active, the real Google is not where this entry's tokens go.
    expect(hostAdmissible(workspace, google)).toBe(false);
    if (workspace.auth.kind !== "user-oauth") throw new Error("wrong kind");
    expect(workspace.auth.authorizationUrl).toBe(`${fake}/o/oauth2/v2/auth`);
    expect(workspace.auth.tokenUrl).toBe(`${fake}/token`);
    expect(workspace.auth.revokeUrl).toBe(`${fake}/revoke`);
    // Only the addresses move. What is asked for, and how, is the reviewed entry's.
    const reviewed = catalogueEntry("google-workspace");
    if (reviewed?.auth.kind !== "user-oauth") throw new Error("wrong kind");
    expect(workspace.auth.scopes).toEqual(reviewed.auth.scopes);
    expect(workspace.auth.authorizationParams).toEqual(
      reviewed.auth.authorizationParams,
    );
    expect(workspace.readTools).toEqual(reviewed.readTools);
    expect(workspace.writeTools).toEqual(["gmail_send_reply"]);
  });

  test("an unset NODE_ENV is development, which is what a laptop has", () => {
    expect(
      fakeGoogleOrigin({ OPENDUET_FAKE_GOOGLE_URL: fake }, () => {
        throw new Error("no warning expected");
      }),
    ).toBe(fake);
  });

  test("Google Drive stays on Google whatever the override says", () => {
    const entries = catalogueFor({ OPENDUET_FAKE_GOOGLE_URL: fake }, () => {});
    // The very same reviewed object, not a copy that happens to match today.
    expect(entryIn(entries, "google-drive")).toBe(
      catalogueEntry("google-drive")!,
    );
    expect(hostAdmissible(entryIn(entries, "google-drive"), fake)).toBe(false);
  });

  test("in production it is refused, said out loud, and Google is used", () => {
    // With a trailing space too, which survives env files and dashboards alike.
    for (const NODE_ENV of ["production", "production "]) {
      const warnings: string[] = [];
      const entries = catalogueFor(
        { OPENDUET_FAKE_GOOGLE_URL: fake, NODE_ENV },
        (message) => warnings.push(message),
      );
      const workspace = entryIn(entries, "google-workspace");

      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("OPENDUET_FAKE_GOOGLE_URL");
      expect(warnings[0]).toContain("production");
      expect(workspace.host).toBe(google);
      expect(hostAdmissible(workspace, fake)).toBe(false);
      if (workspace.auth.kind !== "user-oauth") throw new Error("wrong kind");
      expect(workspace.auth.tokenUrl).toBe(
        "https://oauth2.googleapis.com/token",
      );
    }
  });

  test("unset, nothing changes and nothing is said", () => {
    const warnings: string[] = [];
    expect(catalogueFor({}, (message) => warnings.push(message))).toBe(
      CATALOGUE,
    );
    expect(warnings).toEqual([]);
  });

  test("anything but a bare http or https origin is refused with a warning", () => {
    for (const value of [
      "not a url",
      "ftp://127.0.0.1:4900",
      "http://127.0.0.1:4900/google",
      "http://127.0.0.1:4900/?token=x",
      "http://user:secret@127.0.0.1:4900",
    ]) {
      const warnings: string[] = [];
      expect(
        fakeGoogleOrigin({ OPENDUET_FAKE_GOOGLE_URL: value }, (message) =>
          warnings.push(message),
        ),
      ).toBeNull();
      expect(warnings).toHaveLength(1);
      // The refusal must not repeat a credential somebody put in the address.
      expect(warnings[0]).not.toContain("secret");
    }
  });

  /*
   * The two cases above call the function. These start a process with the variable set and import
   * the catalogue as the server does, so they also prove the module's own CATALOGUE is built from
   * the environment, which is the wiring a refactor could quietly drop.
   */
  const resolvedIn = (environment: Record<string, string>) => {
    const script = [
      'import { catalogueEntry, resolveServerUrl } from "./src/plugins/catalogue";',
      'const entry = catalogueEntry("google-workspace");',
      "console.log(JSON.stringify({",
      '  workspace: resolveServerUrl("google-workspace")?.url,',
      "  tokenUrl: entry?.auth.kind === 'user-oauth' ? entry.auth.tokenUrl : null,",
      '  drive: resolveServerUrl("google-drive")?.url,',
      "}));",
    ].join("\n");
    const result = Bun.spawnSync(["bun", "-e", script], {
      cwd: `${import.meta.dir}/..`,
      env: { ...process.env, ...environment },
    });
    expect(result.exitCode).toBe(0);
    return {
      resolved: JSON.parse(result.stdout.toString()) as Record<string, string>,
      stderr: result.stderr.toString(),
    };
  };

  test("a process started with it set, outside production, resolves to the fake", () => {
    const { resolved } = resolvedIn({
      OPENDUET_FAKE_GOOGLE_URL: fake,
      NODE_ENV: "development",
    });
    expect(resolved).toEqual({
      workspace: fake,
      tokenUrl: `${fake}/token`,
      drive: `${google}/drive/v3`,
    });
  });

  test("a process started with it set in production resolves to Google and warns", () => {
    const { resolved, stderr } = resolvedIn({
      OPENDUET_FAKE_GOOGLE_URL: fake,
      NODE_ENV: "production",
    });
    expect(resolved).toEqual({
      workspace: google,
      tokenUrl: "https://oauth2.googleapis.com/token",
      drive: `${google}/drive/v3`,
    });
    expect(stderr).toContain("OPENDUET_FAKE_GOOGLE_URL is set and ignored");
  });
});

describe("Notion", () => {
  const entry = catalogueEntry("notion");

  test("is in the catalogue with the MCP transport", () => {
    expect(entry).not.toBeNull();
    // Transport omitted means MCP, which is the point: Drive's REST adapter is the exception.
    expect(entry?.transport).toBeUndefined();
    expect(entry?.host).toBe("https://mcp.notion.com");
    expect(entry?.path).toBe("/mcp");
  });

  test("registers its client dynamically, with every endpoint pinned to https", () => {
    if (entry?.auth.kind !== "user-oauth") throw new Error("wrong auth kind");
    expect(entry.auth.clientRegistration).toBe("dynamic");
    expect(entry.auth.registrationUrl?.startsWith("https://")).toBe(true);
    expect(entry.auth.authorizationUrl.startsWith("https://")).toBe(true);
    expect(entry.auth.tokenUrl.startsWith("https://")).toBe(true);
    // Notion MCP scoping is the consent screen; scope strings would assert control that
    // does not exist.
    expect(entry.auth.scopes).toEqual([]);
  });

  test("pins the exact write list, so a dropped or renamed entry fails here", () => {
    // Copied from the catalogue's Notion entry, in its declared order. This list is the
    // entire write barrier for Notion (see the comment above writeTools in catalogue.ts) —
    // asserting membership against itself would never catch a silently dropped or renamed
    // tool, so the fix is to pin the literal names.
    expect(entry?.writeTools).toEqual([
      "notion-convert-page-to-skill",
      "notion-create-attachment",
      "notion-create-comment",
      "notion-create-database",
      "notion-create-file-upload",
      "notion-create-folder",
      "notion-create-pages",
      "notion-create-view",
      "notion-duplicate-page",
      "notion-move-pages",
      "notion-update-data-source",
      "notion-update-folder",
      "notion-update-page",
      "notion-update-view",
    ]);
    for (const name of entry?.writeTools ?? []) {
      expect(classifyTool(entry, name, true)).toBe("write");
    }
    expect(classifyTool(entry, "notion-search", true)).toBe("read");
    expect(classifyTool(entry, "brand-new-tool", false)).toBe("write");
  });
});

describe("Routines", () => {
  const entry = catalogueEntry("routines");

  test("is in the catalogue and resolves to its own builtin address", () => {
    expect(entry).not.toBeNull();
    expect(resolveServerUrl("routines")?.url).toBe("builtin://routines");
  });

  test("has no credential, because there is nothing to authenticate to", () => {
    expect(entry?.auth.kind).toBe("builtin");
  });

  test("is reached through the builtin transport, not a vendor", () => {
    expect(entry?.transport).toBe("builtin-routines");
  });

  test("pins the exact write list, so a dropped or renamed entry fails here", () => {
    expect(entry?.writeTools).toEqual([
      "create_routine",
      "update_routine",
      "delete_routine",
      "create_trigger",
      "pause_trigger",
      "resume_trigger",
      "delete_trigger",
    ]);
  });

  test("classifies its tools the same way every other vendor's are classified", () => {
    for (const name of entry?.writeTools ?? []) {
      expect(classifyTool(entry, name, true)).toBe("write");
    }
    expect(classifyTool(entry, "list_routines", true)).toBe("read");
    // A name nothing here has vouched for is a write, the same as for any other vendor.
    expect(classifyTool(entry, "brand-new-tool", false)).toBe("write");
    // Every tool, advertised or not, is a write when the server never said it was advertised.
    for (const name of [
      ...(entry?.writeTools ?? []),
      "list_routines",
      "brand-new-tool",
    ]) {
      expect(classifyTool(entry, name, false)).toBe("write");
    }
  });
});

describe("what a tool does", () => {
  const drive = catalogueEntry("google-drive")!;

  test("a named write is a write", () => {
    expect(classifyTool(drive, "create_file", true)).toBe("write");
  });

  test("an advertised tool that is not a named write is a read", () => {
    expect(classifyTool(drive, "search_files", true)).toBe("read");
  });

  test("a tool the server never advertised is a write", () => {
    // The only thing that produced this name was a model, so nothing has vouched for it.
    expect(classifyTool(drive, "search_files", false)).toBe("write");
  });

  test("every tool on a server nobody reviewed is a write", () => {
    expect(classifyTool(null, "anything_at_all", true)).toBe("write");
  });

  test("copying is a write, and reading a file's content is not", () => {
    // `copy_file` is the case a list built by reading verbs off tool names would miss: it creates
    // nothing named "create" and still puts a new object in somebody's Drive.
    expect(classifyTool(drive, "copy_file", true)).toBe("write");
    expect(classifyTool(drive, "read_file_content", true)).toBe("read");
    expect(classifyTool(drive, "get_file_metadata", true)).toBe("read");
  });
});

describe("a URL an administrator typed", () => {
  test("an ordinary vendor URL is accepted", () => {
    expect(customUrlRefusal("https://mcp.example.com/mcp")).toBeNull();
  });

  test("plaintext is refused", () => {
    expect(customUrlRefusal("http://mcp.example.com")).toContain("https");
  });

  test("an address literal is refused", () => {
    // The cloud metadata endpoint, which is the reason this check exists.
    expect(
      customUrlRefusal("https://169.254.169.254/latest/meta-data/"),
    ).toContain("hostname");
    expect(customUrlRefusal("https://127.0.0.1/mcp")).toContain("hostname");
    expect(customUrlRefusal("https://[::1]/mcp")).toContain("hostname");
  });

  test("names that only resolve inside the network are refused", () => {
    expect(customUrlRefusal("https://localhost/mcp")).not.toBeNull();
    expect(customUrlRefusal("https://database/mcp")).not.toBeNull();
    expect(customUrlRefusal("https://vault.internal/mcp")).not.toBeNull();
    expect(customUrlRefusal("https://printer.local/mcp")).not.toBeNull();
  });

  test("the fully qualified spelling of those names is refused too", () => {
    // A trailing dot is the root-anchored form of the same name and resolves to the same place, so
    // every rule above has to see through it. It defeats them in two different ways: the suffix
    // tests stop matching because the string now ends in the dot, and "database." acquires the dot
    // that the single-label test keys on.
    expect(customUrlRefusal("https://localhost./mcp")).not.toBeNull();
    expect(customUrlRefusal("https://database./mcp")).not.toBeNull();
    expect(customUrlRefusal("https://vault.internal./mcp")).not.toBeNull();
    expect(customUrlRefusal("https://printer.local./mcp")).not.toBeNull();
    expect(
      customUrlRefusal("https://metadata.google.internal./computeMetadata/v1/"),
    ).not.toBeNull();
    // More than one, because stripping a single dot leaves a string that still misses every rule.
    expect(customUrlRefusal("https://localhost../mcp")).not.toBeNull();
    expect(customUrlRefusal("https://vault.internal.../mcp")).not.toBeNull();
  });

  test("an in-cluster service name is refused", () => {
    // .svc is how a Kubernetes service is addressed from inside the cluster. It has dots and none
    // of the other suffixes, so it reads as an ordinary vendor name.
    expect(
      customUrlRefusal("https://kubernetes.default.svc/mcp"),
    ).not.toBeNull();
    expect(
      customUrlRefusal("https://kubernetes.default.svc.cluster.local/mcp"),
    ).not.toBeNull();
  });

  test("a credential in the URL is refused", () => {
    // Userinfo is not part of the host, so every rule above passes it, and addCustomServer then
    // writes the string it was given into mcp_servers.url and into the configuration.changed audit
    // payload. Audit redaction keys on the field name and "url" is not sensitive, so the secret
    // would sit in the trail in clear text.
    expect(
      customUrlRefusal("https://oauth:s3cret@mcp.example.com/mcp"),
    ).not.toBeNull();
    expect(
      customUrlRefusal("https://token@mcp.example.com/mcp"),
    ).not.toBeNull();
  });

  test("refusing a credential in the URL does not repeat the credential", () => {
    // The refusal is rendered to the administrator and can reach a log, so it must not carry the
    // thing it exists to reject.
    const refusal = customUrlRefusal(
      "https://oauth:s3cret@mcp.example.com/mcp",
    );
    expect(refusal).not.toBeNull();
    expect(refusal).not.toContain("s3cret");
    expect(refusal).not.toContain("oauth");
  });

  test("a credential in the query string is refused", () => {
    // The same harm as the userinfo case above, reached through the other part of the URL no host
    // rule looks at. addCustomServer writes the string it was given into mcp_servers.url and into
    // the configuration.changed audit payload, audit redaction keys on the field name, and "url" is
    // not a sensitive name, so a token here sits in an append-only trail in clear text.
    expect(
      customUrlRefusal("https://mcp.example.com/mcp?token=sk-live-abcdef"),
    ).not.toBeNull();
    expect(
      customUrlRefusal("https://mcp.example.com/mcp?api_key=SECRET"),
    ).not.toBeNull();
    expect(
      customUrlRefusal("https://mcp.example.com/mcp?access_token=SECRET"),
    ).not.toBeNull();
    expect(
      customUrlRefusal("https://mcp.example.com/mcp?client_secret=SECRET"),
    ).not.toBeNull();
  });

  test("the names a credential is actually given are refused too", () => {
    // The first version of this rule listed exact names, which is a corner of the class rather than
    // the class: every one of these was accepted while `?token=` was refused, and an operator does
    // not know which spelling the check happens to hold. The match reads the name for what it says.
    for (const name of [
      "auth_token",
      "api_token",
      "apiToken",
      "access_key",
      "secret_key",
      "private_key",
      "session_token",
      "x-api-key",
      "subscription-key",
      "X-Amz-Signature",
      "bearer",
      "pwd",
    ]) {
      expect(
        customUrlRefusal(`https://mcp.example.com/mcp?${name}=s3cret`),
      ).not.toBeNull();
    }
  });

  test("an ordinary query parameter is still accepted", () => {
    // The rule reads the parameter name, not the presence of a query, because vendors route and
    // version with parameters. Refusing every query string would make this floor an outage rather
    // than a guard, and an operator who cannot add a working server will find a way around it.
    expect(
      customUrlRefusal("https://mcp.example.com/mcp?workspace=acme&version=2"),
    ).toBeNull();
    // The near misses, which are what a rule that reads names rather than matching them exactly has
    // to get right: "keyword" is not a key and "author" is not auth.
    expect(
      customUrlRefusal("https://mcp.example.com/mcp?keyword=x&author=jane"),
    ).toBeNull();
  });

  test("refusing a credential in the query does not repeat it", () => {
    // Same property as the userinfo refusal: this string is rendered to an administrator and can
    // reach a log, so it must not carry the secret it exists to reject.
    const refusal = customUrlRefusal(
      "https://mcp.example.com/mcp?token=s3cret",
    );
    expect(refusal).not.toBeNull();
    expect(refusal).not.toContain("s3cret");
    expect(refusal).not.toContain("mcp.example.com");
  });

  test("a credential in the fragment is refused too", () => {
    // The fragment never leaves the browser, but that is not the harm here. addCustomServer stores
    // and audits the whole string, so a secret written after the hash is as durable and as readable
    // as one in the query. Refusing one and not the other would leave the same bypass a character
    // away.
    expect(
      customUrlRefusal("https://mcp.example.com/mcp#token=s3cret"),
    ).not.toBeNull();
    // The shapes a fragment is actually written in. A hash route or an OAuth-style callback puts a
    // path before the question mark, and reading the whole fragment as one query string turns all
    // of it into a single name that matches nothing.
    expect(
      customUrlRefusal("https://mcp.example.com/mcp#/callback?token=s3cret"),
    ).not.toBeNull();
    expect(
      customUrlRefusal("https://mcp.example.com/mcp#!/x?token=s3cret"),
    ).not.toBeNull();
    expect(
      customUrlRefusal("https://mcp.example.com/mcp#token%3Ds3cret"),
    ).not.toBeNull();
    // An ordinary fragment is not a credential and is left alone.
    expect(customUrlRefusal("https://mcp.example.com/mcp#section")).toBeNull();
  });

  test("the short name for the cloud metadata endpoint is refused", () => {
    // metadata.goog is Google's own alias for the metadata server, published beside
    // metadata.google.internal and 169.254.169.254. It carries a dot and none of the suffixes
    // above, so it read as an ordinary vendor name, while the long spelling was caught only
    // incidentally by the .internal test.
    expect(
      customUrlRefusal("https://metadata.goog/computeMetadata/v1/"),
    ).not.toBeNull();
    expect(
      customUrlRefusal("https://metadata.goog./computeMetadata/v1/"),
    ).not.toBeNull();
    expect(
      customUrlRefusal("https://METADATA.GOOG/computeMetadata/v1/"),
    ).not.toBeNull();
  });

  test("nonsense is refused rather than thrown", () => {
    expect(customUrlRefusal("not a url")).toBe("That is not a URL.");
  });
});

describe("which credential a curated server is given", () => {
  /**
   * A synthetic entry, because the catalogue holds one vendor today and it is `user-oauth`.
   *
   * The shared-token branch is the one a fork re-enables when it puts a removed vendor back, which
   * is the case this rule exists for, so it is exercised here rather than left to be discovered
   * then. The other side of the same argument is why the entry is written out in full rather than
   * spread from a real one: what is under test is the auth kind deciding the answer.
   */
  const sharedToken: CatalogueEntry = {
    key: "shared-token-vendor",
    title: "Vendor",
    vendor: "Vendor",
    summary: "A server the deployment holds one token for.",
    host: "https://mcp.vendor.example",
    path: "/mcp",
    auth: { kind: "deployment-bearer" },
    writeTools: [],
    docsUrl: "https://vendor.example/docs",
  };

  test("a shared-token server takes the deployment's own token for it", () => {
    expect(serverCredentialKind(sharedToken)).toBe("mcp");
  });

  test("a server reached as the asker takes no credential from the caller", () => {
    // Its OAuth client arrives through registerOAuthClient, which mints the credential itself. An id
    // offered here is therefore never the right one, whatever kind it names.
    const drive = catalogueEntry("google-drive");
    expect(drive?.auth.kind).toBe("user-oauth");
    expect(serverCredentialKind(drive as CatalogueEntry)).toBeNull();
  });

  test("a server that needs no credential takes none", () => {
    expect(
      serverCredentialKind({ ...sharedToken, auth: { kind: "none" } }),
    ).toBeNull();
  });
});

test("a curated entry keeps classifying from its write list when nothing was recorded", () => {
  const notion = catalogueEntry("notion");
  expect(notion).not.toBeNull();
  if (!notion) return;

  // The behaviour that shipped before the column existed, unchanged for every existing row.
  expect(classifyTool(notion, "notion-fetch", true)).toBe("read");
  expect(classifyTool(notion, "notion-update-page", true)).toBe("write");
});

test("a recorded write overrides a curated entry that omits the action", () => {
  const notion = catalogueEntry("notion");
  // Asserted rather than only guarded. The early return below reads as a pass, so a renamed or
  // dropped key would retire this case silently instead of failing.
  expect(notion).not.toBeNull();
  if (!notion) return;

  // The write list is known-incomplete. A vendor saying an action writes settles it, and the list
  // being out of date stops mattering.
  expect(classifyTool(notion, "notion-fetch", true, "write")).toBe("write");
});

test("a recorded read cannot take an action off a curated entry's write list", () => {
  const notion = catalogueEntry("notion");
  expect(notion).not.toBeNull();
  if (!notion) return;

  /*
   * The mirror image of the case above, and the only direction that is refused. A recorded effect
   * may NARROW what a Bot may do — the `write` case above — and may never widen it: `effect` is
   * vendor-supplied text in an unconstrained column, `writeTools` was reviewed by a person, and a
   * value in the column must not buy an action less scrutiny than review already gave it. The
   * per-value cases live in composio-classify.test.ts; this pins the property beside the write list
   * it protects, so dropping a name from that list fails here too.
   */
  expect(notion.writeTools).toContain("notion-update-page");
  expect(classifyTool(notion, "notion-update-page", true, "read")).toBe(
    "write",
  );
  // And the empty string is a recorded value rather than a silence, so it does not fall through to
  // the write list and read as a read for an action the list omits.
  expect(classifyTool(notion, "notion-fetch", true, "")).toBe("write");
});
