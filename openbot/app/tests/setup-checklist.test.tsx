import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";
import { SetupChecklist } from "@/components/onboarding/setup-checklist";
import { refreshNotificationPermission } from "@/lib/setup/notifications";
import type {
  SetupChecklist as Checklist,
  SetupRow,
} from "@/lib/setup/queries";
import { settleReactWork } from "./settle-react-work";

/**
 * The setup checklist onboarding ends on. It draws what the server decided, row by row, and lets
 * somebody connect their own Gmail, put that off, check again, and finish whatever is missing.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = globalThis.fetch;
let answer: () => Response;
/** What `POST /api/openduet/setup/check` answers; the plain read's answer when unset. */
let answerCheck: (() => Response) | null;
let devices: { id: string; platform: "ios"; enabled: boolean }[];
let requests: { path: string; method: string }[];

/**
 * The browser's notifications, as happy-dom has none: a permission to read and a prompt that
 * answers with `prompted`.
 */
let permission: NotificationPermission;
let prompted: NotificationPermission;
let asked: number;
const originalNotification = (globalThis as { Notification?: unknown })
  .Notification;

beforeEach(() => {
  requests = [];
  answerCheck = null;
  devices = [];
  permission = "granted";
  prompted = "granted";
  asked = 0;
  (globalThis as { Notification?: unknown }).Notification = {
    get permission() {
      return permission;
    },
    requestPermission: async () => {
      asked += 1;
      permission = prompted;
      return prompted;
    },
  };
  refreshNotificationPermission();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      requests.push({ path, method });
      if (path.startsWith("/api/plugins/servers/")) {
        return Response.json({
          authorizationUrl: "https://accounts.example/consent?state=s",
        });
      }
      if (path === "/api/delivery") {
        return Response.json({
          bindings: [],
          devices,
          deliveries: [],
          available: { slack: false, teams: false, sms: false, push: false },
        });
      }
      if (path === "/api/openduet/setup/check" && answerCheck) {
        return answerCheck();
      }
      return answer();
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  (globalThis as { Notification?: unknown }).Notification =
    originalNotification;
});

const READY_ROW = (
  row: Partial<SetupRow> & Pick<SetupRow, "id">,
): SetupRow => ({
  scope: "deployment",
  title: row.id,
  required: false,
  status: row.ready === false ? "needs_setup" : "ready",
  ready: true,
  detail: "Works.",
  fix: null,
  ...row,
});

/** What an admin is sent: Intelligence ready, the model key missing, Gmail connectable, Slack unset. */
const ADMIN: Checklist = {
  audience: "admin",
  rows: [
    READY_ROW({
      id: "intelligence",
      title: "CopilotKit Intelligence",
      required: true,
      detail: "Keeps your conversations and what OpenDuet remembers.",
    }),
    READY_ROW({
      id: "model",
      title: "AI model",
      required: true,
      ready: false,
      detail: "Without a model key, OpenDuet can't answer.",
      fix: {
        kind: "env",
        names: ["OPENAI_API_KEY"],
        docsUrl: "https://github.com/CopilotKit/OpenDuet#quick-start",
        page: { label: "Credentials", path: "/admin/credentials" },
      },
    }),
    READY_ROW({ id: "google", title: "Google apps" }),
    READY_ROW({
      id: "gmail",
      scope: "person",
      title: "Your Gmail and Calendar",
      ready: false,
      detail: "Without it, OpenDuet can't read your mail or calendar.",
      fix: { kind: "connect", serverId: "google-workspace" },
    }),
    READY_ROW({
      id: "chat",
      title: "Slack and Teams",
      ready: false,
      detail: "Without it, people can talk to OpenDuet only here.",
      fix: {
        kind: "env",
        names: ["OPENTAG_SHARED_SECRET", "OPENTAG_URL"],
        docsUrl:
          "https://github.com/CopilotKit/OpenDuet/blob/main/openbot/docs/configuration.md",
      },
    }),
  ],
};

/** What a member is sent for the same deployment: no fix on a deployment row, and no names. */
const MEMBER: Checklist = {
  audience: "member",
  rows: ADMIN.rows.map((row) =>
    row.scope === "deployment" && !row.ready
      ? { ...row, detail: "Your admin sets this up.", fix: null }
      : row,
  ),
};

function serving(checklist: Checklist) {
  answer = () => Response.json({ checklist });
}

function draw(
  props: Partial<Parameters<typeof SetupChecklist>[0]> = {},
): ReturnType<typeof render> & { opened: string[]; left: string[] } {
  const opened: string[] = [];
  const left: string[] = [];
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <SetupChecklist
        leaveFor={(url) => left.push(url)}
        openPage={(path) => opened.push(path)}
        returnTo="onboarding"
        {...props}
      />
    </QueryClientProvider>,
  );
  return Object.assign(view, { opened, left });
}

const rowOf = (view: ReturnType<typeof render>, id: string) => {
  const row = view.container.querySelector<HTMLElement>(
    `[data-setup-row="${id}"]`,
  );
  if (!row) throw new Error(`no ${id} row`);
  return within(row);
};

test("Ready and Needs setup rows come from the server's answer", async () => {
  serving(ADMIN);
  const view = draw();

  await view.findByRole("list", { name: "Setup" });
  expect(rowOf(view, "intelligence").getByText("Ready")).not.toBeNull();
  expect(rowOf(view, "model").getByText("Needs setup")).not.toBeNull();
  expect(rowOf(view, "model").getByText("Required")).not.toBeNull();
  expect(
    rowOf(view, "model").getByText(
      "Without a model key, OpenDuet can't answer.",
    ),
  ).not.toBeNull();
  expect(
    view.getByText("3 things need setup, and 1 is required."),
  ).not.toBeNull();
  // Gmail's row wears Gmail's and Calendar's own marks.
  const gmail = view.container.querySelector('[data-setup-row="gmail"]');
  expect(
    [...(gmail?.querySelectorAll("[data-logo]") ?? [])].map((logo) =>
      logo.getAttribute("data-logo"),
    ),
  ).toEqual(["gmail", "google-calendar"]);
});

test("an admin is shown the variable to set, the page, and the guide", async () => {
  serving(ADMIN);
  const view = draw();
  await view.findByRole("list", { name: "Setup" });

  const model = rowOf(view, "model");
  expect(model.getByText("OPENAI_API_KEY")).not.toBeNull();
  const guide = model.getByRole("link", { name: "Setup guide" });
  expect(guide.getAttribute("href")).toBe(
    "https://github.com/CopilotKit/OpenDuet#quick-start",
  );
  expect(guide.getAttribute("target")).toBe("_blank");

  fireEvent.click(model.getByRole("link", { name: "Credentials" }));
  expect(view.opened).toEqual(["/admin/credentials"]);

  expect(rowOf(view, "chat").getByText("OPENTAG_SHARED_SECRET")).not.toBeNull();
});

test("a member sees their admin sets it up, and no variable names", async () => {
  serving(MEMBER);
  const view = draw();
  await view.findByRole("list", { name: "Setup" });

  const model = rowOf(view, "model");
  expect(model.getByText("Your admin sets this up.")).not.toBeNull();
  expect(model.getByText("Needs setup")).not.toBeNull();
  expect(view.container.textContent).not.toContain("OPENAI_API_KEY");
  expect(view.container.textContent).not.toContain("OPENTAG");
  expect(view.queryByRole("link", { name: "Setup guide" })).toBeNull();
  // Their own row is still theirs to act on.
  expect(
    rowOf(view, "gmail").getByRole("button", { name: "Connect" }),
  ).not.toBeNull();
});

test("Gmail's Connect starts the Connections flow, and comes back to onboarding", async () => {
  serving(ADMIN);
  const view = draw();
  await view.findByRole("list", { name: "Setup" });

  const gmail = rowOf(view, "gmail");
  fireEvent.click(gmail.getByRole("button", { name: "Connect" }));

  await waitFor(() =>
    expect(view.left).toEqual(["https://accounts.example/consent?state=s"]),
  );
  expect(requests).toContainEqual({
    path: "/api/plugins/servers/google-workspace/connect?returnTo=onboarding",
    method: "POST",
  });
});

test("Not now sits beside Connect, and puts it off", async () => {
  serving(ADMIN);
  const view = draw();
  await view.findByRole("list", { name: "Setup" });

  const gmail = rowOf(view, "gmail");
  const connect = gmail.getByRole("button", { name: "Connect" });
  const notNow = gmail.getByRole("button", { name: "Not now" });
  expect(connect.parentElement).toBe(notNow.parentElement);

  fireEvent.click(notNow);

  expect(
    gmail.getByText("You can connect it later in Connections."),
  ).not.toBeNull();
  expect(gmail.queryByRole("button", { name: "Connect" })).toBeNull();
  expect(requests.some((request) => request.method === "POST")).toBe(false);
});

test("Check again asks the server to check again, and draws its answer", async () => {
  serving(ADMIN);
  const view = draw();
  await view.findByRole("list", { name: "Setup" });

  answerCheck = () =>
    Response.json({
      checklist: {
        audience: "admin",
        rows: ADMIN.rows.map((row) => ({
          ...row,
          status: "ready",
          ready: true,
          fix: null,
        })),
      },
    });
  fireEvent.click(view.getByRole("button", { name: "Check again" }));

  expect(await view.findByText("Everything is set up.")).not.toBeNull();
  expect(requests).toContainEqual({
    path: "/api/openduet/setup/check",
    method: "POST",
  });
});

test("a key nobody has checked reads Not checked, never Ready", async () => {
  serving({
    audience: "admin",
    rows: ADMIN.rows.map((row) =>
      row.id === "model"
        ? {
            ...row,
            status: "not_checked",
            ready: false,
            detail: "Key set, not checked yet. Check again to ask OpenAI.",
            fix: null,
          }
        : { ...row, status: "ready", ready: true, fix: null },
    ),
  });
  const view = draw();
  await view.findByRole("list", { name: "Setup" });

  const model = rowOf(view, "model");
  expect(model.getByText("Not checked")).not.toBeNull();
  expect(model.queryByText("Ready")).toBeNull();
  expect(view.getByText("1 thing isn't checked yet.")).not.toBeNull();
});

test("notifications are a row of their own, Ready when this browser allows them", async () => {
  serving(ADMIN);
  const view = draw();
  await view.findByRole("list", { name: "Setup" });

  const notifications = rowOf(view, "notifications");
  expect(notifications.getByText("Notifications")).not.toBeNull();
  expect(notifications.getByText("Ready")).not.toBeNull();
  // It sits with the reader's other own row, right after Gmail.
  const ids = Array.from(
    view.container.querySelectorAll("[data-setup-row]"),
  ).map((row) => row.getAttribute("data-setup-row"));
  expect(ids.indexOf("notifications")).toBe(ids.indexOf("gmail") + 1);
});

test("notifications not yet allowed offer Turn on, which asks the browser", async () => {
  permission = "default";
  refreshNotificationPermission();
  serving(ADMIN);
  const view = draw();
  await view.findByRole("list", { name: "Setup" });

  const notifications = rowOf(view, "notifications");
  expect(notifications.getByText("Needs setup")).not.toBeNull();
  fireEvent.click(notifications.getByRole("button", { name: "Turn on" }));

  await waitFor(() =>
    expect(rowOf(view, "notifications").getByText("Ready")).not.toBeNull(),
  );
  expect(asked).toBe(1);
});

test("blocked notifications say where to allow them, with no button", async () => {
  permission = "denied";
  refreshNotificationPermission();
  serving(ADMIN);
  const view = draw();
  await view.findByRole("list", { name: "Setup" });

  const notifications = rowOf(view, "notifications");
  expect(
    notifications.getByText(
      "Blocked for this site. Allow notifications in your browser's site settings.",
    ),
  ).not.toBeNull();
  expect(notifications.queryByRole("button")).toBeNull();
});

test("a phone registered for push counts, whatever this browser says", async () => {
  permission = "denied";
  refreshNotificationPermission();
  devices = [{ id: "device-1", platform: "ios", enabled: true }];
  serving(ADMIN);
  const view = draw();
  await view.findByRole("list", { name: "Setup" });

  await waitFor(() =>
    expect(rowOf(view, "notifications").getByText("Ready")).not.toBeNull(),
  );
});

test("a check that fails says so, and Check again stays", async () => {
  answer = () => Response.json({ error: "nope" }, { status: 503 });
  const view = draw();

  expect(
    await view.findByText(
      "Couldn't check your setup. Check again, or carry on and look later in Settings.",
    ),
  ).not.toBeNull();
  expect(view.getByRole("button", { name: "Check again" })).not.toBeNull();
});

test("a connection that came back failed is said above the list", async () => {
  serving(ADMIN);
  const view = draw({
    notice: "Couldn't connect your Gmail and Calendar. Try again.",
  });
  expect((await view.findAllByRole("alert"))[0]?.textContent).toBe(
    "Couldn't connect your Gmail and Calendar. Try again.",
  );
});

test("finishing works with a required gap still open", async () => {
  serving(ADMIN);
  let finished = 0;
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const view = render(
    <QueryClientProvider client={client}>
      <OnboardingWizard
        finishLabel="Start using OpenDuet"
        initialStepId="setup"
        onFinish={() => {
          finished += 1;
        }}
        steps={[
          { id: "welcome", render: () => <h1>Welcome</h1> },
          {
            id: "setup",
            render: () => (
              <SetupChecklist openPage={() => {}} returnTo="onboarding" />
            ),
          },
        ]}
      />
    </QueryClientProvider>,
  );

  await view.findByText("3 things need setup, and 1 is required.");
  const finish = view.getByRole("button", { name: "Start using OpenDuet" });
  expect((finish as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(finish);
  expect(finished).toBe(1);
});
