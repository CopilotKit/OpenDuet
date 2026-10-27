import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { refreshNotificationPermission } from "@/lib/setup/notifications";
import { queryClient } from "@/query-client";
import type { RouterContext } from "@/router-context";
import { Route as OnboardingRoute } from "@/routes/_authed/onboarding";
import { settleReactWork } from "./settle-react-work";

/**
 * Where somebody is in onboarding lives in the address: `?step=<id>`. A reload stays on the step,
 * browser Back walks back one, a consent comes back to the step it left from, and every move is
 * saved, so arriving without a step opens the one they were on.
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
  mine: false,
};

const originalFetch = globalThis.fetch;
let saved: number;
let saves: number[];
let completed: boolean;
/** Whether the server says this is somebody trying OpenDuet alone, which adds three steps. */
let localEvaluation: boolean;

beforeEach(() => {
  // Another file's screens may have cached the signed-in person in the app's one query client.
  queryClient.clear();
  saved = 0;
  saves = [];
  completed = false;
  localEvaluation = false;
  (globalThis as { Notification?: unknown }).Notification = {
    permission: "default",
    requestPermission: async () => "default",
  };
  refreshNotificationPermission();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      const method = init?.method ?? "GET";
      if (path === "/api/me")
        return Response.json({
          user: {
            id: "person-1",
            email: "maya@example.com",
            name: "Maya",
            role: "admin",
            onboarding: {
              step: saved,
              completedAt: completed ? "2026-10-23T00:00:00Z" : null,
            },
          },
        });
      if (path === "/api/me/onboarding" && method === "POST") {
        const body = JSON.parse(String(init?.body)) as {
          step?: number;
          completed?: boolean;
        };
        if (body.completed) {
          completed = true;
          return Response.json({
            onboarding: { step: saved, completedAt: "2026-10-23T00:00:00Z" },
          });
        }
        if (body.step === undefined) throw new Error("Missing onboarding step");
        saves.push(body.step);
        saved = body.step;
        return Response.json({
          onboarding: { step: saved, completedAt: null },
        });
      }
      if (path === "/api/capabilities")
        return Response.json({ localEvaluation });
      if (path.startsWith("/api/agents"))
        return Response.json({ agents: [BOT] });
      if (path === "/api/plugins/for/openduet/apps/google-workspace")
        return Response.json({
          app: { key: "google-workspace", state: "not_connected" },
        });
      if (path === "/api/openduet/setup")
        return Response.json({ checklist: { audience: "admin", rows: [] } });
      if (path === "/api/delivery")
        return Response.json({
          bindings: [],
          devices: [],
          deliveries: [],
          available: { slack: false, teams: false, sms: false, push: false },
        });
      return Response.json({});
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
  queryClient.clear();
  window.sessionStorage.clear();
});

function open(path: string, given?: ReturnType<typeof createMemoryHistory>) {
  const rootRoute = createRootRouteWithContext<RouterContext>()({
    component: Outlet,
  });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const homeRoute = createRoute({
    path: "/",
    getParentRoute: () => authedRoute,
    component: () => <p>Home</p>,
  });
  const wired = (
    OnboardingRoute as unknown as {
      update: (options: unknown) => typeof OnboardingRoute;
    }
  ).update({
    id: "/onboarding",
    path: "/onboarding",
    getParentRoute: () => authedRoute,
  });
  const history = given ?? createMemoryHistory({ initialEntries: [path] });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([homeRoute, wired]),
    ]),
    history,
    context: { queryClient },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
  return Object.assign(view, { router, history });
}

const heading = (view: ReturnType<typeof render>, name: string) =>
  view.findByRole("heading", { name });
const searchOf = (view: ReturnType<typeof open>) =>
  view.router.state.location.search as { step?: string; connected?: string };

test("arriving without a step writes the first one into the address, in place", async () => {
  const view = open("/onboarding");

  await heading(view, "Welcome to OpenDuet");
  await waitFor(() => expect(searchOf(view).step).toBe("welcome"));
  // In place: nothing behind it to go Back to inside onboarding.
  expect(view.history.length).toBe(1);
});

test("the local install's step says where its data really lives", async () => {
  localEvaluation = true;
  const view = open("/onboarding?step=local");

  await heading(view, "Where your data lives");
  const page = document.body.textContent ?? "";
  // Conversations live in Intelligence, which is CopilotKit's cloud unless self-hosted, and every
  // message reaches the model: neither is "on this computer".
  expect(page).toContain(
    "Conversations and memory are kept in CopilotKit Intelligence",
  );
  expect(page).toContain("What you ask goes to your AI model.");
  expect(page).toContain("Set DO_NOT_TRACK=1 to turn them off.");
  expect(page).not.toContain("stored on this computer");
  expect(page).not.toContain("Only what you send to your model leaves it");
});

test("the organization step offers enterprise early access and CopilotKit's other products", async () => {
  localEvaluation = true;
  const view = open("/onboarding?step=organization");

  await heading(view, "Deploy it for your organization");
  expect(document.body.textContent).toContain(
    "Enterprise deployments are available now in early access.",
  );
  const early = view.getByRole("link", { name: "Get early access" });
  expect(early.getAttribute("href")).toBe(
    "https://www.copilotkit.ai/talk-to-an-engineer?ref=openduet_app",
  );
  expect(early.getAttribute("target")).toBe("_blank");
  for (const product of ["openbot", "openmuse", "opendots"]) {
    const link = view
      .getAllByRole("link")
      .find((a) => a.getAttribute("href")?.includes(`/${product}?`));
    expect(link?.getAttribute("href")).toBe(
      `https://www.copilotkit.ai/${product}?ref=openduet_onboarding`,
    );
    expect(link?.getAttribute("target")).toBe("_blank");
  }
});

test("Next adds a step to the address and to history, and saves it", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenDuet");

  fireEvent.click(view.getByRole("button", { name: "Next" }));

  await heading(view, "Each Bot has its own computer");
  expect(searchOf(view).step).toBe("computer");
  expect(view.history.length).toBe(2);
  await waitFor(() => expect(saves).toContain(2));
});

test("Next and Back start the visible step at the top of the scroll container", async () => {
  const view = open("/onboarding?step=computer");
  await heading(view, "Each Bot has its own computer");
  const main = view.getByRole("main");
  main.scrollTop = 120;

  fireEvent.click(view.getByRole("button", { name: "Next" }));

  const roster = await heading(view, "Pick a Bot or make your own");
  await waitFor(() => expect(document.activeElement).toBe(roster));
  expect(view.getByRole("main")).toBe(main);
  expect(main.scrollTop).toBe(0);

  main.scrollTop = 120;
  fireEvent.click(view.getByRole("button", { name: "Back" }));

  const computer = await heading(view, "Each Bot has its own computer");
  await waitFor(() => expect(document.activeElement).toBe(computer));
  expect(view.getByRole("main")).toBe(main);
  expect(main.scrollTop).toBe(0);
});

test("updating the current step keeps its scroll position", async () => {
  const view = open("/onboarding?step=apps");
  await heading(view, "Connect your apps");
  fireEvent.click(view.getByRole("button", { name: "Not now" }));
  await heading(view, "Get notified");
  const main = view.getByRole("main");
  main.scrollTop = 120;

  fireEvent.click(view.getByRole("button", { name: "Turn on notifications" }));

  await view.findByText("You can turn them on later in Settings.");
  expect(view.getByRole("button", { name: "Next" })).toBeTruthy();
  expect(searchOf(view).step).toBe("notify");
  expect(view.getByRole("main")).toBe(main);
  expect(main.scrollTop).toBe(120);
});

test("browser Back goes to the step before, not out of onboarding", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenDuet");
  fireEvent.click(view.getByRole("button", { name: "Next" }));
  await heading(view, "Each Bot has its own computer");

  await act(async () => view.history.back());

  expect(await heading(view, "Welcome to OpenDuet")).toBeTruthy();
  expect(searchOf(view).step).toBe("welcome");
});

test("the bar's Back after Next returns through history, so Forward still works", async () => {
  const view = open("/onboarding?step=welcome");
  await heading(view, "Welcome to OpenDuet");
  fireEvent.click(view.getByRole("button", { name: "Next" }));
  await heading(view, "Each Bot has its own computer");

  fireEvent.click(view.getByRole("button", { name: "Back" }));

  expect(await heading(view, "Welcome to OpenDuet")).toBeTruthy();
  expect(view.history.canGoBack()).toBe(false);
  await act(async () => view.history.forward());
  expect(await heading(view, "Each Bot has its own computer")).toBeTruthy();
});

test("the bar's Back on a step opened by reload replaces it with the step before", async () => {
  const view = open("/onboarding?step=roster");
  await heading(view, "Pick a Bot or make your own");

  fireEvent.click(view.getByRole("button", { name: "Back" }));

  expect(await heading(view, "Each Bot has its own computer")).toBeTruthy();
  expect(searchOf(view).step).toBe("computer");
  expect(view.history.length).toBe(1);
});

test("a reload stays on the step in the address", async () => {
  const view = open("/onboarding?step=apps");

  expect(await heading(view, "Connect your apps")).toBeTruthy();
  expect(searchOf(view).step).toBe("apps");
});

test("arriving with no step opens the one the server saved", async () => {
  saved = 8;
  const view = open("/onboarding");

  expect(await heading(view, "Get notified")).toBeTruthy();
  await waitFor(() => expect(searchOf(view).step).toBe("notify"));
});

test("a failed consent says so on its step, and only `connected` leaves the address", async () => {
  const view = open("/onboarding?step=apps&connected=failed");

  expect(await heading(view, "Connect your apps")).toBeTruthy();
  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't connect your Gmail and Calendar. Try again.",
  );
  await waitFor(() => expect(searchOf(view)).toEqual({ step: "apps" }));
});

test("a step that isn't one is ignored", async () => {
  const view = open("/onboarding?step=nonsense");

  expect(await heading(view, "Welcome to OpenDuet")).toBeTruthy();
  await waitFor(() => expect(searchOf(view).step).toBe("welcome"));
});

test("after a reload, the bar's Back still returns through history, not a second entry", async () => {
  const first = open("/onboarding?step=welcome");
  await heading(first, "Welcome to OpenDuet");
  fireEvent.click(first.getByRole("button", { name: "Next" }));
  await heading(first, "Each Bot has its own computer");
  const history = first.history;
  first.unmount();
  queryClient.clear();

  // The same history, a new page: what a reload keeps.
  const reloaded = open("/onboarding?step=computer", history);
  await heading(reloaded, "Each Bot has its own computer");
  fireEvent.click(reloaded.getByRole("button", { name: "Back" }));

  expect(await heading(reloaded, "Welcome to OpenDuet")).toBeTruthy();
  expect(history.length).toBe(2);
  expect(history.canGoBack()).toBe(false);
});

test("back from a consent, browser Back goes to the step before, not to the vendor", async () => {
  window.sessionStorage.setItem(
    "openduet-onboarding-consent",
    JSON.stringify({ step: "apps", entry: "the-entry-that-left" }),
  );
  const view = open("/onboarding?step=apps&connected=failed");

  expect(await heading(view, "Connect your apps")).toBeTruthy();
  await waitFor(() => expect(view.history.length).toBe(2));
  expect(searchOf(view)).toEqual({ step: "apps" });
  expect((await view.findByRole("alert")).textContent).toBe(
    "Couldn't connect your Gmail and Calendar. Try again.",
  );
  expect(
    window.sessionStorage.getItem("openduet-onboarding-consent"),
  ).toBeNull();

  await act(async () => view.history.back());
  expect(await heading(view, "Pick a Bot or make your own")).toBeTruthy();
});

test("the failed line goes once the person moves on, and doesn't come back with Back", async () => {
  const view = open("/onboarding?step=apps&connected=failed");
  await view.findByRole("alert");

  fireEvent.click(view.getByRole("button", { name: "Not now" }));
  await heading(view, "Get notified");
  fireEvent.click(view.getByRole("button", { name: "Back" }));

  expect(await heading(view, "Connect your apps")).toBeTruthy();
  await settleReactWork();
  expect(view.queryByRole("alert")).toBeNull();
});

test("finishing plays the orb's finish before entering Chat", async () => {
  const view = open("/onboarding?step=setup");
  await heading(view, "Check your setup");
  fireEvent.click(view.getByRole("button", { name: "Start using OpenDuet" }));
  await waitFor(() =>
    expect(
      view.container.querySelector(
        '[data-onboarding-finish] [data-state="finished"]',
      ),
    ).not.toBeNull(),
  );
  expect(view.queryByText("Home")).toBeNull();
  expect(
    view.getByRole("button", { name: "Saving…" }).hasAttribute("disabled"),
  ).toBe(true);
  await waitFor(() => expect(view.getByText("Home")).toBeTruthy(), {
    timeout: 3000,
  });
});
