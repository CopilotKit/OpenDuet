import { queryOptions } from "@tanstack/react-query";
import { client } from "@/lib/client";

/**
 * The setup checklist, as the server decided it for the person asking. See
 * server/src/openduet/setup.ts.
 *
 * Every sentence and every fix comes from the server, already shaped for its reader: an admin is
 * told which page to open or which variable to set, and a member is told only that it works or that
 * their admin sets it up. The browser draws what it is given and never decides who may see a fix.
 * Nothing on it is a secret's value: a key is reported as there or not there.
 */
export type SetupRowId =
  | "intelligence"
  | "model"
  | "google"
  | "gmail"
  /** The one row the browser adds itself: only it knows whether it may notify. */
  | "notifications"
  | "computer"
  | "apps"
  | "chat";

export type SetupFix =
  | {
      kind: "env";
      names: string[];
      docsUrl: string;
      page?: { label: string; path: string };
    }
  | { kind: "page"; label: string; path: string; docsUrl?: string }
  | { kind: "connect"; serverId: string }
  /** Turn on this browser's notifications. Never sent by the server: see the notifications row. */
  | { kind: "notify" };

/**
 * `ready` works, as far as the server can tell. `needs_setup` does not, and the row says why.
 * `not_checked` is set up, but nobody has asked whether it works, such as a model key added since
 * the server last asked the provider.
 */
export type SetupStatus = "ready" | "needs_setup" | "not_checked";

export type SetupRow = {
  id: SetupRowId;
  /** A deployment row is an admin's to set up; a person row is the reader's own. */
  scope: "deployment" | "person";
  title: string;
  /** True only where the product cannot answer without it. */
  required: boolean;
  status: SetupStatus;
  /** `status === "ready"`. */
  ready: boolean;
  /** What it gives you when ready, or what happens without it. */
  detail: string;
  fix: SetupFix | null;
};

export type SetupChecklist = {
  audience: "admin" | "member";
  rows: SetupRow[];
};

export const setupKeys = {
  all: ["setup"] as const,
  checklist: () => ["setup", "checklist"] as const,
};

export function setupChecklistQueryOptions() {
  return queryOptions({
    queryKey: setupKeys.checklist(),
    queryFn: (): Promise<SetupChecklist> =>
      client("/api/openduet/setup", "checklist", {
        fallback: "Couldn't check your setup.",
      }),
  });
}
