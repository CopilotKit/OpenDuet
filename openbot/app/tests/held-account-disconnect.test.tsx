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
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type {
  PluginConnections,
  PluginServer,
  PluginsPage,
} from "@/lib/plugins/queries";
import { Route as ConnectedAccountRoute } from "@/routes/_authed/_app/connections.$key";
import { settleReactWork } from "./settle-react-work";

/**
 * Disconnecting Gmail and Google Calendar, an account this deployment holds the token for.
 *
 * The page used to offer "Disconnect" and then say it couldn't, leaving the token in place. It now
 * ends the account through the server, which asks Google first, and says what happened: done, or
 * done here with one more step at Google when Google did not confirm it.
 *
 * The harness is `composio-unconfigured-account.test.tsx`'s: the exported `Route` is captured and
 * restored around its `.update()`.
 */

beforeAll(() => GlobalRegistrator.register({ url: "http://localhost:3010" }));
afterEach(cleanup);
afterAll(async () => {
  await settleReactWork();
  GlobalRegistrator.unregister();
});

const originalFetch = global.fetch;
let connected: boolean;
let deletes: string[];
let answer: () => Response;

beforeEach(() => {
  connected = true;
  deletes = [];
  answer = () => Response.json({ disconnected: true, vendorRevoked: true });
  global.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path === "/api/plugins") return Response.json(page);
      if (path === "/api/plugins/connections")
        return Response.json(connectionsNow());
      if (
        path === "/api/plugins/servers/google-workspace/connection" &&
        init?.method === "DELETE"
      ) {
        deletes.push(path);
        const response = answer();
        if (response.ok) connected = false;
        return response;
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
});

afterEach(() => {
  global.fetch = originalFetch;
});

const workspace = {
  id: "google-workspace",
  title: "Gmail and Google Calendar",
  summary: "Mail and calendar of whoever is asking.",
  vendor: "Google",
  url: "https://www.googleapis.com/",
  provenance: "first-party",
  authScheme: null,
  accountMode: "personal",
  tools: [],
} as unknown as PluginServer;

const page: PluginsPage = {
  catalogue: [
    {
      key: "google-workspace",
      title: "Gmail and Google Calendar",
      vendor: "Google",
      summary: "Mail and calendar of whoever is asking.",
      docsUrl: "https://developers.google.com",
      auth: "user-oauth",
      perInstance: false,
    },
  ],
  servers: [workspace],
  skills: [],
  botsMayCallBack: true,
  redirectUri: "https://app.example/api/plugins/oauth/callback",
  composioConfigured: false,
  authorizesPerAction: false,
};

function connectionsNow(): PluginConnections {
  return {
    connections: connected
      ? [
          {
            serverId: "google-workspace",
            scope: "https://www.googleapis.com/auth/gmail.readonly",
            connectedAt: "2026-10-20T09:00:00Z",
            revoked: false,
            holder: "person",
          },
        ]
      : [],
    redirectUri: page.redirectUri,
  };
}

type Updatable = { update: (options: unknown) => unknown };
const pristine = {
  ...ConnectedAccountRoute,
  options: { ...ConnectedAccountRoute.options },
} as Record<string, unknown>;
afterEach(() => {
  for (const key of Object.keys(ConnectedAccountRoute)) {
    if (!(key in pristine)) {
      delete (ConnectedAccountRoute as unknown as Record<string, unknown>)[key];
    }
  }
  Object.assign(ConnectedAccountRoute, pristine);
});

function renderAccount() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const rootRoute = createRootRoute({ component: Outlet });
  const authedRoute = createRoute({
    id: "/_authed",
    getParentRoute: () => rootRoute,
    component: Outlet,
  });
  const appRoute = createRoute({
    id: "/_app",
    getParentRoute: () => authedRoute,
    component: Outlet,
  });
  const connectionsRoute = createRoute({
    path: "/connections",
    getParentRoute: () => appRoute,
    component: Outlet,
  });
  const indexRoute = createRoute({
    path: "/",
    getParentRoute: () => connectionsRoute,
    component: () => null,
  });
  const account = (ConnectedAccountRoute as unknown as Updatable).update({
    id: "/$key",
    path: "/$key",
    getParentRoute: () => connectionsRoute,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([
      authedRoute.addChildren([
        appRoute.addChildren([
          connectionsRoute.addChildren([indexRoute, account as never]),
        ]),
      ]),
    ]),
    history: createMemoryHistory({
      initialEntries: ["/connections/google-workspace"],
    }),
  });
  return render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router as never} />
    </QueryClientProvider>,
  );
}

async function pressDisconnect(view: ReturnType<typeof renderAccount>) {
  const user = userEvent.setup({ document });
  await user.click(await view.findByRole("button", { name: /Connected/ }));
  await user.click(await view.findByRole("menuitem", { name: "Disconnect" }));
}

test("Disconnect ends the account, says so, and the row offers Connect again", async () => {
  const view = renderAccount();
  await pressDisconnect(view);

  expect(
    await view.findByText(
      "Disconnected. OpenDuet can't use your Google account any more.",
    ),
  ).toBeTruthy();
  expect(deletes).toEqual(["/api/plugins/servers/google-workspace/connection"]);
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Connect" })).toBeTruthy(),
  );
  // The old "can't disconnect here yet" sentence, and the old product name, are gone.
  expect(view.queryByText(/can't disconnect here/)).toBeNull();
  expect(document.body.textContent).not.toContain("OpenBot");
});

test("when Google did not confirm it, the person is told the one step left", async () => {
  answer = () => Response.json({ disconnected: true, vendorRevoked: false });
  const view = renderAccount();
  await pressDisconnect(view);

  expect(
    await view.findByText(
      "Disconnected here. Google didn't confirm it, so also remove OpenDuet in your Google account's third-party access settings.",
    ),
  ).toBeTruthy();
});

test("when Google could not be reached, the server's sentence is shown and the account stays", async () => {
  answer = () =>
    Response.json(
      {
        error:
          "Couldn't reach Google, so nothing was disconnected. Try again in a moment.",
      },
      { status: 502 },
    );
  const view = renderAccount();
  await pressDisconnect(view);

  const alert = await view.findByRole("alert");
  expect(alert.textContent).toBe(
    "Couldn't reach Google, so nothing was disconnected. Try again in a moment.",
  );
  expect(view.getByRole("button", { name: /Connected/ })).toBeTruthy();
});
