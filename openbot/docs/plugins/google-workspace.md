# Gmail and Google Calendar

A Bot with this connector granted reads mail and the calendar **as the person asking**, and can send a
reply in one of their threads, as them, once that send has been through the approval gate. Two people
asking the same question get the answers their own accounts can see, and neither sees anything they
could not open themselves.

It is one connector for both products, on purpose. Over REST they share one Google OAuth client, and
Google revokes a person's grant to a client as a whole: as two connectors on one client, disconnecting
Calendar would quietly end Gmail's access too, and everybody would consent twice to what reads to them
as one question.

The connector reaches Google over the ordinary REST APIs, the Gmail API at
`www.googleapis.com/gmail/v1` and the Calendar API at `www.googleapis.com/calendar/v3`, not over
Google's hosted Workspace MCP servers, which are gated behind the Workspace Developer Preview Program.
It is the same choice the [Google Drive](google-drive.md) connector makes, for the same reason.

Setting it up takes two people, and neither can do the other's half:

| Who              | Does                                                 | Where                                                         |
| ---------------- | ---------------------------------------------------- | ------------------------------------------------------------- |
| An administrator | Registers the OAuth client and enables the connector | Google Cloud console, then `/admin/plugins/google-workspace` |
| Each person      | Consents with their own Google account               | `/connections/google-workspace`                               |

There is deliberately no endpoint for an administrator to connect an account on somebody's behalf.

## What an administrator does

### 1. Enable the Gmail API and the Google Calendar API

In a Google Cloud project, enable both:

- `gmail.googleapis.com`, the Gmail API;
- `calendar-json.googleapis.com`, the Google Calendar API. The service name is not the obvious one.

A connector that returns `403` where the credential is otherwise good is most often one of these not
being enabled, and the message names which; see [Troubleshooting](#troubleshooting).

### 2. Configure the OAuth consent screen

Add exactly these three scopes:

- `https://www.googleapis.com/auth/gmail.readonly`: read mail;
- `https://www.googleapis.com/auth/gmail.send`: send mail, and nothing else (it cannot read, label or
  delete);
- `https://www.googleapis.com/auth/calendar.readonly`: read the calendar.

Two things about Google's rules decide who can connect:

- **While the app is in Testing, only listed test users can consent.** Everyone who will connect needs
  to be on the test-user list, or their consent fails with an access-denied error that says nothing
  about test users. Testing mode also expires refresh tokens after seven days, so people have to
  reconnect weekly.
- **Beyond Testing, Google has to verify the app.** `gmail.readonly` is a _restricted_ scope, and
  `gmail.send` and `calendar.readonly` are _sensitive_ ones. Publishing an app with an External user
  type means Google's verification for the sensitive scopes, and for the restricted one also an annual
  third-party security assessment. A Google Workspace organization whose people are the only ones who
  connect can set the user type to **Internal** instead, which needs no verification.

### 3. Create an OAuth client

Type **Web application**. Under **Authorised redirect URIs**, add this deployment's callback:

```
<OPENBOT_PUBLIC_URL>/api/plugins/oauth/callback
```

Locally that is `http://localhost:3001/api/plugins/oauth/callback`: port 3001, the API, not 3010, the
app. It has to match character for character, and OpenBot shows the exact string to paste under the
**Connection** section of the plugin page.

Use a client of its own, not the one Google Drive uses. Google revokes a grant per client, so two
connectors sharing one client means disconnecting either ends both.

Keep the client ID and client secret for the next step.

### 4. Enable the connector in OpenBot

At `/admin/plugins/google-workspace`:

1. Turn on **Enable for this deployment**.
2. Open **OAuth client** and paste the client ID and secret. The secret is encrypted with
   `KEY_ENCRYPTION_KEY` and never read back out to the browser.
3. Press **Refresh tools**, which records the four tools below.

No personal account is needed to get this far: the tool list is OpenBot's own code rather than an
answer from a remote server. To check it actually works, use **Your account** on the same page, which
connects _your_ Google account like anybody else's.

### 5. Grant tools to a Bot

Enabling the connector does not give any Bot access to it. Each tool is granted per Bot, the same as
every other plugin tool. Every call then checks the grant, evaluates the action policy, and writes an
audit row.

## The tools

Every result is JSON, in a fixed shape, because OpenDuet's own code reads these results as well as
models do.

| Tool                    | Effect | What it does                                                                                                                                                                                         |
| ----------------------- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `gmail_search_messages` | read   | Searches with Gmail's own syntax, by default `in:inbox newer_than:1d`, 25 at a time and at most 50. Each message has its sender, recipients, subject, date, snippet, labels, and the `List-Unsubscribe`, `Precedence` and `Auto-Submitted` headers when it has them. |
| `gmail_read_message`    | read   | Reads one message by its Gmail id: the same fields, its `Message-ID`, and its text. The plain-text part is preferred, HTML is read as text when there is none, and the body is cut at 20,000 characters with a note saying so. |
| `gmail_send_reply`      | write  | Sends a plain-text reply in an existing thread, as the person.                                                                                                                                       |
| `calendar_list_events`  | read   | Lists events on the primary calendar in start order, recurring events expanded. By default from now to midnight in the calendar's own time zone, at most 50.                                                        |

The catalogue names the three reads and the one write explicitly, so any other tool name counts as a
write.

### Sending a reply is a write

`gmail_send_reply` is the only tool that changes anything, and it is classified as a write. So every
call goes through the approval gate before it reaches Google: the action policy decides, and auto-review
looks at it like any other write that reaches outside the deployment. Because it sends something to
other people, the private-share check also asks the owner before a Bot sends anything from a private
conversation or memory.

What the connector itself enforces, whatever was approved:

- A reply is threaded under the message it answers, with `In-Reply-To` and `References` taken from that
  message at Google rather than from the model, and the message must be in the thread named.
- A line break in a recipient or the subject is refused before anything is sent, because it would add a
  header (a `Bcc`, say) that the approval never showed.
- There is no tool for writing to somebody who has not written first, and none that deletes, labels or
  archives mail. The `gmail.send` scope could not do those anyway.

## What each person does

At `/connections`, Gmail and Google Calendar appears once an administrator has enabled it. Open it and
press **Connect**. That leaves OpenBot for Google's consent screen and returns to the same page, which
then reads **Connected** with the scopes Google actually granted.

Google's consent screen lets a person untick individual permissions. Each one left unticked breaks the
tools that need it, with a message saying the access granted does not cover the request; reconnecting
and allowing all three fixes it.

Nothing is cached. OpenBot stores the refresh token and mints a short-lived access token for each call,
so revoking access at Google takes effect on the next call.

### Disconnecting

On `/connections/google-workspace`, open **Connected** and choose **Disconnect**. It disconnects only the
signed-in person's own account. It asks Google to revoke the refresh token, then revokes the stored
credential and removes the connection in one transaction, and writes an audit event.

- If Google cannot be reached, nothing changes and the page asks you to try again, so access is never
  reported withdrawn when it was not.
- If Google refuses the revocation, access still ends in this deployment, and the page tells you to
  finish at Google's own third-party access settings
  ([myaccount.google.com/connections](https://myaccount.google.com/connections)).

## Trying it without a Google account

`openbot/scripts/fake-google/server.ts` is a fake Google: just enough of Google's OAuth, the Gmail API
and the Calendar API to use this connector end to end, with nobody's real mail. It holds the mailbox of
Maya Okafor, who runs a small ceramics studio: the 60 invented messages from `evals/triage/emails.jsonl`,
re-dated so they all arrived within the last day, and a calendar for today with a 10:00 glaze test
review and a 15:00 studio visit among others.

1. Start it, from the repository root:

   ```sh
   bun openbot/scripts/fake-google/server.ts --port 4900
   ```

2. Point the connector at it in `openbot/.env`, then restart the API:

   ```sh
   OPENDUET_FAKE_GOOGLE_URL=http://127.0.0.1:4900
   ```

3. At `/admin/plugins/google-workspace`, enable the connector, paste any client ID and secret (the fake
   accepts any), and press **Refresh tools**.
4. At `/connections/google-workspace`, press **Connect**. The fake consents at once, as
   `maya@marlowceramics.com`, and sends you straight back.
5. Grant the tools to a Bot and ask it about the inbox.

To see what was sent, and to start over:

```sh
curl http://127.0.0.1:4900/__fake/sent
curl -X POST http://127.0.0.1:4900/__fake/reset
```

Reset puts the mailbox and calendar back, dated from now, and forgets what was sent. People stay
connected across a reset and across restarting the fake.

What the variable does and does not do:

- It moves this connector's API host and its OAuth consent, token and revocation addresses to the fake,
  where the catalogue entry is resolved, so admitting the host, enabling the connector and connecting an
  account all agree.
- It is **refused in production**. When `NODE_ENV=production` it is ignored, the server logs that it was,
  and Google's own addresses are used. Every other address in the catalogue is reviewed in code; this one
  comes from the environment, and on a deployed server it would send client secrets and people's tokens
  wherever it pointed.
- It never affects Google Drive.
- It is ignored under `bun test`, so a laptop set up for a demo still tests the reviewed catalogue.
- Switching back to Google means reconnecting: the stored refresh token belongs to the fake.

The fake is not a faithful Gmail. Search understands the operators people commonly write (`in:`,
`label:`, `category:`, `is:`, `from:`, `to:`, `subject:`, `newer_than:`, `older_than:` and plain words)
and ignores the rest. It does check what matters for the connector: PKCE on the token exchange, a bearer
token on every API call, and that a reply's `In-Reply-To` or `References` points into the thread it is
filed in, as Gmail does.

## Troubleshooting

Every message below is what OpenBot actually shows. Each starts with Google's own sentence, and then says
whose move it is.

**Look at the audit trail first.** Every call leaves one row, written after the attempt:

| Row                  | Means                                                                                       |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `mcp.call_rejected`  | This deployment declined. A missing grant, or a policy rule; `decision.rule` names which.  |
| `mcp.call_failed`    | Permitted here, failed at Google. `failure` carries Google's own sentence.                  |
| `mcp.call_succeeded` | Google answered.                                                                            |

A Bot that appears to have no access and leaves **no rows at all** never called the tool: check that the
tool is granted to _that_ Bot at `/admin/plugins/google-workspace`.

### `redirect_uri_mismatch` or `access_denied` on the consent screen

`redirect_uri_mismatch` is the redirect URI: compare the value shown under **Connection** on the plugin
page with what is registered on the OAuth client, character for character.

`access_denied`, or "has not completed the Google verification process", is who may consent: in Testing
mode the account must be on the test-user list, and beyond Testing the app needs Google's verification
(see [step 2](#2-configure-the-oauth-consent-screen)).

### "Gmail refused this request (401)." or "Google Calendar refused this request (401)."

Google will not accept the token. Reconnecting at `/connections/google-workspace` is the usual fix. In
Testing mode, refresh tokens expire after seven days, which shows up as exactly this.

### "… refused this request (403): … not enabled on the Google Cloud project …"

The credential is fine; the API is not enabled. The message names the service: `gmail.googleapis.com` or
`calendar-json.googleapis.com` ([step 1](#1-enable-the-gmail-api-and-the-google-calendar-api)). Enabling
an API takes a few minutes to apply.

### "… The access this person granted does not cover this. …"

The person unticked a permission on Google's consent screen. Reconnecting and allowing all three fixes it.

### "… Google is limiting how fast this account can be read. …"

A `429`, or a `403` that is really a rate limit. Wait a minute and try again.

### "… No message with that id is in this mailbox. …"

The message was deleted, or the id is not one a search returned. A search that finds a message which is
deleted before it is looked up skips it rather than failing.

### "A recipient or the subject contains a line break, …"

The reply was refused before anything was sent. The usual cause is a model copying a header out of mail
it read; the reply needs writing again.

### "The message being answered is in thread …, not …"

The thread id and the message id given for a reply do not belong together. Nothing was sent.

### "You have not connected your Gmail and Google Calendar account."

The Bot was asked to read as somebody with no connection stored. Connect at
`/connections/google-workspace`. There is no fallback to a deployment-wide credential, by design.

### The connection worked and stopped about an hour later

That is an access token with no refresh token behind it, which OpenBot refuses to store. Google returns
no refresh token when it believes the person already consented, which is why the authorization URL sends
both `access_type=offline` and `prompt=consent`.

## See also

- [Google Drive](google-drive.md): the same per-person shape, read-only.
- [Architecture](../architecture.md): where plugins, grants, policy and audit sit.
- [Configuration](../configuration.md): `OPENBOT_PUBLIC_URL`, `KEY_ENCRYPTION_KEY`,
  `OPENDUET_FAKE_GOOGLE_URL`.
- [Gmail API](https://developers.google.com/workspace/gmail/api/reference/rest) and
  [Calendar API](https://developers.google.com/workspace/calendar/api/v3/reference): the REST APIs this
  connector calls.
