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
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type { ReactNode } from "react";
import { ConnectAppsStep } from "@/components/onboarding/connect-apps-step";
import {
  GRANTED_BEAT_MS,
  notificationPreview,
  useNotifyStep,
} from "@/components/onboarding/notify-step";
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";
import { agentKeys } from "@/lib/agents/queries";
import type { AppAccessState } from "@/lib/app-access/queries";
import { refreshNotificationPermission } from "@/lib/setup/notifications";
import { settleReactWork } from "./settle-react-work";

/**
 * Onboarding's two optional steps. Connect your apps reads Gmail's state for this person on the
 * primary Bot and starts the real connection, coming back to this step. Get notified asks the
 * browser, shows the answer, and moves on.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const BOT = {
  id: "openduet",
  name: "OpenDuet",
  title: "Your proactive assistant",
  roleDescription: "",
  avatarSeed: "openduet",
  visibility: "private",
  endpoint: null,
  builtIn: true,
  hasAuth: false,
};

const originalFetch = globalThis.fetch;
let gmail: AppAccessState | "error";
let audience: "admin" | "member";
let requests: { path: string; method: string }[];

let permission: NotificationPermission;
let prompted: NotificationPermission;
let asked: number;
const originalNotification = (globalThis as { Notification?: unknown })
  .Notification;

beforeEach(() => {
  requests = [];
  gmail = "not_connected";
  audience = "member";
  permission = "default";
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
      if (path === "/api/plugins/for/openduet/apps/google-workspace") {
        if (gmail === "error")
          return Response.json({ error: "nope" }, { status: 503 });
        return Response.json({
          app: { key: "google-workspace", state: gmail },
        });
      }
      if (path.startsWith("/api/plugins/servers/google-workspace/connect")) {
        return Response.json({
          authorizationUrl: "https://accounts.example/consent?state=s",
        });
      }
      if (path.startsWith("/api/agents"))
        return Response.json({ agents: [BOT] });
      if (path === "/api/openduet/setup") {
        return Response.json({ checklist: { audience, rows: [] } });
      }
      return Response.json({});
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

function withQueries(children: ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  client.setQueryData(agentKeys.list(false), [BOT]);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function drawConnect(failed = false) {
  const left: string[] = [];
  const view = render(
    withQueries(
      <ConnectAppsStep failed={failed} leaveFor={(url) => left.push(url)} />,
    ),
  );
  return Object.assign(view, { left });
}

const appRow = (view: ReturnType<typeof render>) => {
  const row = view.container.querySelector<HTMLElement>(
    '[data-app-row="google-workspace"]',
  );
  if (!row) throw new Error("no Gmail row");
  return within(row);
};

test("Connect your apps has one Gmail and Calendar row, asked of the primary Bot", async () => {
  const view = drawConnect();

  expect(view.getByRole("heading", { name: "Connect your apps" })).toBeTruthy();
  const connect = await view.findByRole("button", {
    name: "Connect Gmail and Google Calendar",
  });
  expect(connect.textContent).toContain("Gmail and Google Calendar");
  // The apps' own marks, not a generic envelope.
  expect(
    [...connect.querySelectorAll("[data-logo]")].map((logo) =>
      logo.getAttribute("data-logo"),
    ),
  ).toEqual(["gmail", "google-calendar"]);
  expect(requests).toContainEqual({
    path: "/api/plugins/for/openduet/apps/google-workspace",
    method: "GET",
  });
});

test("tapping the row starts the real connection, coming back to this step", async () => {
  const view = drawConnect();

  fireEvent.click(
    await view.findByRole("button", {
      name: "Connect Gmail and Google Calendar",
    }),
  );

  await waitFor(() =>
    expect(view.left).toEqual(["https://accounts.example/consent?state=s"]),
  );
  expect(requests).toContainEqual({
    path: "/api/plugins/servers/google-workspace/connect?returnTo=onboarding-apps",
    method: "POST",
  });
});

test("connected reads Connected, with nothing to press", async () => {
  gmail = "ready";
  const view = drawConnect();

  expect(await appRow(view).findByText("Connected")).toBeTruthy();
  expect(appRow(view).queryByRole("button")).toBeNull();
});

test("a refused key offers Reconnect", async () => {
  gmail = "reconnect";
  const view = drawConnect();

  expect(
    await view.findByRole("button", {
      name: "Reconnect Gmail and Google Calendar",
    }),
  ).toBeTruthy();
  expect(appRow(view).getByText("Needs reconnecting.")).toBeTruthy();
});

test("a Bot never given Gmail tells a member it is their admin's move, with no plus", async () => {
  gmail = "not_granted";
  const view = drawConnect();

  expect(
    await appRow(view).findByText("Your admin has to set this up."),
  ).toBeTruthy();
  expect(appRow(view).queryByRole("button")).toBeNull();
});

test("an admin is pointed at the last step instead", async () => {
  gmail = "disabled";
  audience = "admin";
  const view = drawConnect();

  expect(
    await appRow(view).findByText("Not set up yet. The last step shows how."),
  ).toBeTruthy();
});

test("a connection that came back failed is said on the step", async () => {
  const view = drawConnect(true);

  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't connect your Gmail and Calendar. Try again.",
  );
});

test("a state that could not be read says so, and never claims Connected", async () => {
  gmail = "error";
  const view = drawConnect();

  expect(
    await appRow(view).findByText(
      "Couldn't check it. Continue, and connect it later in Connections.",
    ),
  ).toBeTruthy();
  expect(appRow(view).queryByText("Connected")).toBeNull();
});

/** Get notified between two plain steps, in the real frame. */
function NotifyOnboarding() {
  const notify = useNotifyStep("OpenDuet");
  return (
    <OnboardingWizard
      finishLabel="Start using OpenDuet"
      initialStepId="notify"
      onFinish={() => {}}
      steps={[
        { id: "apps", render: () => <h1>Connect your apps</h1> },
        notify,
        { id: "setup", render: () => <h1>Check your setup</h1> },
      ]}
    />
  );
}

test("Get notified previews the notification the app really sends", () => {
  const view = render(<NotifyOnboarding />);

  expect(view.getByRole("heading", { name: "Get notified" })).toBeTruthy();
  const preview = notificationPreview("OpenDuet");
  expect(preview).toEqual({
    title: "OpenDuet needs you",
    body: "1 question, 1 approval",
  });
  expect(view.getByText(preview.title)).toBeTruthy();
  expect(view.getByText(preview.body)).toBeTruthy();
  expect(
    view.getByText(
      "Notifications show while OpenDuet is open in a browser tab.",
    ),
  ).toBeTruthy();
});

test("Turn on notifications asks the browser, reads Notifications on, then moves on", async () => {
  const view = render(<NotifyOnboarding />);

  fireEvent.click(view.getByRole("button", { name: "Turn on notifications" }));

  const on = await view.findByRole("button", { name: "Notifications on" });
  expect(on.hasAttribute("data-done")).toBe(true);
  expect(asked).toBe(1);
  expect(view.queryByRole("button", { name: "Not now" })).toBeNull();
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, GRANTED_BEAT_MS + 50));
  });
  expect(
    await view.findByRole("heading", { name: "Check your setup" }),
  ).toBeTruthy();
});

test("while the browser's prompt is up, the button waits, and can't be pressed twice", async () => {
  let answer: (value: NotificationPermission) => void = () => {};
  (globalThis as { Notification?: unknown }).Notification = {
    get permission() {
      return permission;
    },
    requestPermission: () =>
      new Promise<NotificationPermission>((resolve) => {
        asked += 1;
        answer = (value) => {
          permission = value;
          resolve(value);
        };
      }),
  };
  refreshNotificationPermission();
  const view = render(<NotifyOnboarding />);

  fireEvent.click(view.getByRole("button", { name: "Turn on notifications" }));
  const waiting = await waitFor(() => {
    const button = view.container.querySelector<HTMLButtonElement>(
      "[data-onboarding-primary][data-pending]",
    );
    if (!button) throw new Error("not waiting yet");
    return button;
  });
  expect(waiting.disabled).toBe(true);
  fireEvent.click(waiting);
  expect(asked).toBe(1);

  await act(async () => answer("granted"));
  expect(
    await view.findByRole("button", { name: "Notifications on" }),
  ).toBeTruthy();
});

test("a prompt closed without an answer says they can turn them on later, and offers Next", async () => {
  prompted = "default";
  const view = render(<NotifyOnboarding />);

  fireEvent.click(view.getByRole("button", { name: "Turn on notifications" }));

  const why = await view.findByText("You can turn them on later in Settings.");
  // Said just above the button, in the frame's footer, where a small screen can't scroll it away.
  expect(why.closest("footer")).not.toBeNull();
  expect(view.queryByRole("button", { name: "Not now" })).toBeNull();
  // Not now's place is kept, so Next stays where Turn on notifications was.
  expect(
    view.container.querySelector("footer [data-onboarding-secondary-slot]"),
  ).not.toBeNull();
  fireEvent.click(view.getByRole("button", { name: "Next" }));
  expect(
    await view.findByRole("heading", { name: "Check your setup" }),
  ).toBeTruthy();
});

test("Not now moves on and asks the browser nothing", async () => {
  const view = render(<NotifyOnboarding />);

  fireEvent.click(view.getByRole("button", { name: "Not now" }));

  expect(
    await view.findByRole("heading", { name: "Check your setup" }),
  ).toBeTruthy();
  expect(asked).toBe(0);
});

test("a no from the browser says where to allow them, and the button becomes Next", async () => {
  prompted = "denied";
  const view = render(<NotifyOnboarding />);

  fireEvent.click(view.getByRole("button", { name: "Turn on notifications" }));

  expect(
    await view.findByText(
      "Notifications are blocked for this site. Allow them in your browser's site settings to turn them on.",
    ),
  ).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: "Next" }));
  expect(
    await view.findByRole("heading", { name: "Check your setup" }),
  ).toBeTruthy();
});

test("a browser with no notifications says so, and offers Next", () => {
  (globalThis as { Notification?: unknown }).Notification = undefined;
  refreshNotificationPermission();
  const view = render(<NotifyOnboarding />);

  expect(view.getByText("This browser can't show notifications.")).toBeTruthy();
  expect(view.getByRole("button", { name: "Next" })).toBeTruthy();
  expect(view.queryByRole("button", { name: "Not now" })).toBeNull();
});
