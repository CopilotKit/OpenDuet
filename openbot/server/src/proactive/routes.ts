import { Hono, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { AppVariables } from "../auth/guards";
import type { ProactiveEngine } from "./engine";
import type { ProactiveStore } from "./store";
import { ProactiveNotFoundError, ProactiveRefusedError } from "./types";

/**
 * `/api/proactive`: a person's background-research settings, the suggestions they produced, and
 * the ones the person started.
 */
export function createProactiveRoutes(
  store: ProactiveStore,
  engine: ProactiveEngine,
  requireUser: MiddlewareHandler<{ Variables: AppVariables }>,
) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", requireUser, bodyLimit({ maxSize: 8_192 }));
  routes.onError((error, context) => {
    if (error instanceof ProactiveNotFoundError)
      return context.json({ error: error.message }, 404);
    if (error instanceof ProactiveRefusedError)
      return context.json({ error: error.message }, 400);
    console.error(
      JSON.stringify({
        type: "proactive-route-error",
        error: error.name,
        context: { route: context.req.path },
        timestamp: new Date().toISOString(),
      }),
    );
    return context.json(
      { error: "Background research is unavailable. Try again." },
      503,
    );
  });
  routes.get("/settings", async (context) =>
    context.json({ settings: await store.list(context.var.actor.id) }),
  );
  routes.post("/settings", async (context) =>
    context.json(
      {
        setting: await engine.create(
          context.var.actor.id,
          await body(context.req.raw),
        ),
      },
      201,
    ),
  );
  routes.patch("/settings/:id", async (context) =>
    context.json({
      setting: await store.update(
        context.var.actor.id,
        context.req.param("id"),
        await body(context.req.raw),
      ),
    }),
  );
  routes.post("/settings/:id/run", async (context) =>
    context.json(
      await engine.runNow(context.var.actor.id, context.req.param("id")),
    ),
  );
  routes.delete("/settings/:id", async (context) => {
    await store.remove(context.var.actor.id, context.req.param("id"));
    return context.body(null, 204);
  });
  routes.get("/suggestions", async (context) =>
    context.json({
      suggestions: await store.suggestions(context.var.actor.id),
    }),
  );
  // What the person started from a suggestion, and where each one stands, for Tasks.
  routes.get("/started", async (context) => {
    const asked = Number.parseInt(context.req.query("resolved") ?? "", 10);
    const resolvedLimit = Number.isFinite(asked)
      ? Math.min(Math.max(asked, 0), 500)
      : 20;
    return context.json(
      await store.started(context.var.actor.id, resolvedLimit),
    );
  });
  routes.post("/started/:id/resolve", async (context) => {
    await store.resolveTask(
      context.var.actor.id,
      context.req.param("id"),
      true,
    );
    return context.json({ resolved: true });
  });
  routes.post("/started/:id/reopen", async (context) => {
    await store.resolveTask(
      context.var.actor.id,
      context.req.param("id"),
      false,
    );
    return context.json({ resolved: false });
  });
  routes.post("/started/:id/retry", async (context) =>
    context.json(
      await engine.retry(context.var.actor.id, context.req.param("id")),
    ),
  );
  // One of the person's suggestions, whatever its status: how a card in Chat says Started or Hidden.
  routes.get("/suggestions/:id", async (context) =>
    context.json({
      suggestion: await store.suggestion(
        context.var.actor.id,
        context.req.param("id"),
      ),
    }),
  );
  routes.post("/suggestions/:id/start", async (context) =>
    context.json({
      suggestion: await engine.start(
        context.var.actor.id,
        context.req.param("id"),
      ),
    }),
  );
  routes.post("/suggestions/:id/dismiss", async (context) =>
    context.json({
      suggestion: await engine.dismiss(
        context.var.actor.id,
        context.req.param("id"),
      ),
    }),
  );
  return routes;
}
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get("content-type")?.includes("application/json"))
    throw new ProactiveRefusedError("Supply JSON settings.");
  try {
    return await request.json();
  } catch {
    throw new ProactiveRefusedError("The settings could not be read.");
  }
}
