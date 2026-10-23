import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Fragment, useState } from "react";
import { GmailLogo, GoogleCalendarLogo } from "@/components/duet/google-logos";
import type { DuetIconName } from "@/components/duet/icons";
import { DuetCard, OutcomePill, Tile } from "@/components/duet/kit";
import { deliveryQueryOptions } from "@/lib/delivery";
import { appConfig } from "@/lib/generated/application-config";
import { connectAccountMutationOptions } from "@/lib/plugins/mutations";
import { recheckSetupMutationOptions } from "@/lib/setup/mutations";
import {
  type NotificationPermissionState,
  refreshNotificationPermission,
  requestNotificationPermission,
  useNotificationPermission,
} from "@/lib/setup/notifications";
import {
  type SetupFix,
  type SetupRow,
  type SetupRowId,
  setupChecklistQueryOptions,
} from "@/lib/setup/queries";

const ICONS: Record<SetupRowId, DuetIconName> = {
  intelligence: "bulb",
  model: "waveform",
  google: "lock",
  gmail: "mail",
  notifications: "inbox",
  computer: "globe",
  apps: "plus",
  chat: "chat",
};

const PRODUCT = appConfig.brand.productName;

/**
 * What this deployment has, and what still needs setting up: one row each, Ready or Needs setup.
 *
 * Onboarding ends on it and Settings opens it again. The rows, their sentences and their fixes are
 * the server's (see `lib/setup/queries.ts`): this draws them, and holds the two things only a browser
 * can do, which are starting a connection and checking again.
 *
 * NOTHING HERE BLOCKS ANYTHING. A required gap is drawn plainly, in red, and the page around it still
 * lets the person carry on: they cannot set a server's environment from a browser, and keeping them
 * out of the app would not set it either.
 *
 * DRAWN IN THE DUET CARD ON BOTH SCREENS, INCLUDING SETTINGS, which otherwise lays its rows out with
 * `PageRows`. It is one list in two places, and drawing it twice would be two lists to keep in step.
 */
export function SetupChecklist({
  returnTo,
  openPage,
  leaveFor = (url) => window.location.assign(url),
  notice,
}: {
  /** Which screen a connection's consent comes back to: onboarding's checklist, or Settings › Setup. */
  returnTo: "onboarding" | "settings-setup";
  /** Opens one of the app's own screens. Onboarding finishes first, since it cannot be left open. */
  openPage: (path: string) => void;
  /** Where the browser goes to approve a connection: the vendor's own page. */
  leaveFor?: (url: string) => void;
  /** Said above the list, such as a connection that came back failed. */
  notice?: string;
}) {
  const queryClient = useQueryClient();
  const checklist = useQuery(setupChecklistQueryOptions());
  const recheck = useMutation(recheckSetupMutationOptions(queryClient));
  const notifications = useNotificationsRow();
  const [dismissed, setDismissed] = useState<SetupRowId[]>([]);
  const [problem, setProblem] = useState<string | null>(null);
  const connect = useMutation({
    ...connectAccountMutationOptions(returnTo),
    onError: (error: Error) => setProblem(error.message),
    onSuccess: (url) => {
      if (url === null) {
        setProblem("Couldn't start connecting. Try again.");
        return;
      }
      leaveFor(url);
    },
  });

  /*
   * Check again asks the server to ask Intelligence and the model provider again, which a plain
   * refetch would not: those two answers are kept from the last time they were asked. A checklist
   * that could not be read at all is read again first.
   */
  const checking = checklist.isFetching || recheck.isPending;
  const checkAgain = (
    <button
      className="type-label h-9 self-center rounded-full px-4 font-semibold text-duet-ink-2 outline-none transition-colors hover:bg-duet-tile hover:text-duet-ink focus-visible:ring-3 focus-visible:ring-duet-violet/40 disabled:opacity-50"
      disabled={checking}
      onClick={() => {
        setProblem(null);
        refreshNotificationPermission();
        void notifications.refetch();
        if (checklist.error) void checklist.refetch();
        else recheck.mutate();
      }}
      type="button"
    >
      {checking ? "Checking…" : "Check again"}
    </button>
  );

  const said =
    problem ??
    (recheck.error ? "Couldn't check again. Try again." : null) ??
    notice;
  const rows = checklist.data
    ? withNotifications(checklist.data.rows, notifications.row)
    : [];

  return (
    <div className="flex w-full flex-col gap-3">
      {said ? (
        <p className="type-sub px-1 text-duet-red" role="alert">
          {said}
        </p>
      ) : null}
      {checklist.isPending ? null : checklist.error ? (
        <>
          <p className="type-sub px-1 text-duet-red" role="alert">
            Couldn't check your setup. Check again, or carry on and look later
            in Settings.
          </p>
          {checkAgain}
        </>
      ) : (
        <>
          <p className="type-sub px-1 text-duet-ink-2" role="status">
            {summaryOf(rows)}
          </p>
          <DuetCard>
            <ul aria-label="Setup">
              {rows.map((row) => (
                <SetupItem
                  connecting={connect.isPending}
                  dismissed={dismissed.includes(row.id)}
                  key={row.id}
                  onConnect={(serverId) => {
                    setProblem(null);
                    connect.mutate(serverId);
                  }}
                  onDismiss={() =>
                    setDismissed((current) => [...current, row.id])
                  }
                  openPage={openPage}
                  row={row}
                />
              ))}
            </ul>
          </DuetCard>
          {checkAgain}
        </>
      )}
    </div>
  );
}

/** One line over the card, so the state of the whole list is said before its rows are read. */
function summaryOf(rows: SetupRow[]): string {
  const gaps = rows.filter((row) => row.status === "needs_setup");
  const unchecked = rows.filter((row) => row.status === "not_checked").length;
  const notChecked =
    unchecked === 0
      ? null
      : unchecked === 1
        ? "1 thing isn't checked yet."
        : `${unchecked} things aren't checked yet.`;
  if (gaps.length === 0) return notChecked ?? "Everything is set up.";
  const required = gaps.filter((row) => row.required).length;
  const things =
    gaps.length === 1 ? "1 thing needs" : `${gaps.length} things need`;
  const needs =
    required > 0
      ? `${things} setup, and ${required === 1 ? "1 is" : `${required} are`} required.`
      : `${things} setup. ${PRODUCT} works without ${gaps.length === 1 ? "it" : "them"}.`;
  return notChecked ? `${needs} ${notChecked}` : needs;
}

/** The notifications row goes with the reader's other own row, after Gmail. */
function withNotifications(rows: SetupRow[], notifications: SetupRow) {
  const at = rows.findIndex((row) => row.id === "gmail");
  return at === -1
    ? [...rows, notifications]
    : [...rows.slice(0, at + 1), notifications, ...rows.slice(at + 1)];
}

/**
 * The one row the browser decides: whether OpenDuet can tell this person something needs them.
 *
 * Ready when this browser allows notifications, or when a phone of theirs is registered for push
 * (`GET /api/delivery`). Otherwise its fix is the Get notified step's button again. Blocked and
 * unsupported say so, since no button here can change either.
 */
function useNotificationsRow(): { row: SetupRow; refetch: () => unknown } {
  const permission = useNotificationPermission();
  const delivery = useQuery({
    ...deliveryQueryOptions(),
    refetchInterval: false,
    retry: false,
  });
  const phone =
    delivery.data?.devices.some((device) => device.enabled) === true;
  return {
    row: notificationsRow(permission, phone),
    refetch: delivery.refetch,
  };
}

export function notificationsRow(
  permission: NotificationPermissionState,
  phone: boolean,
): SetupRow {
  const row = {
    id: "notifications" as const,
    scope: "person" as const,
    title: "Notifications",
    required: false,
  };
  if (permission === "granted" || phone)
    return {
      ...row,
      status: "ready",
      ready: true,
      detail:
        permission === "granted"
          ? `${PRODUCT} tells you in this browser when it needs your input.`
          : `${PRODUCT} tells you on your phone when it needs your input.`,
      fix: null,
    };
  return {
    ...row,
    status: "needs_setup",
    ready: false,
    detail:
      permission === "denied"
        ? "Blocked for this site. Allow notifications in your browser's site settings."
        : permission === "unsupported"
          ? "This browser can't show notifications."
          : "Without them, you see what needs you only when you look.",
    fix: permission === "default" ? { kind: "notify" } : null,
  };
}

function SetupItem({
  row,
  dismissed,
  connecting,
  onConnect,
  onDismiss,
  openPage,
}: {
  row: SetupRow;
  dismissed: boolean;
  connecting: boolean;
  onConnect: (serverId: string) => void;
  onDismiss: () => void;
  openPage: (path: string) => void;
}) {
  const tone =
    row.status === "ready"
      ? "green"
      : row.status === "not_checked" || !row.required
        ? "amber"
        : "red";
  return (
    <li
      // The hairline between rows, lined up with the text after the tile as the kit's `Rule` is.
      className="relative flex gap-[13px] px-4 py-3.5 [&+&]:before:absolute [&+&]:before:top-0 [&+&]:before:right-0 [&+&]:before:left-[65px] [&+&]:before:h-px [&+&]:before:bg-duet-hair-2"
      data-ready={row.ready ? "" : undefined}
      data-setup-row={row.id}
      data-status={row.status}
    >
      {row.id === "gmail" ? (
        // The apps' own marks, so the row reads as Gmail and Calendar at a glance.
        <span
          className="flex h-9 w-9 shrink-0 items-center justify-center gap-0.5"
          data-tile="gmail"
        >
          <GmailLogo size={17} />
          <GoogleCalendarLogo size={17} />
        </span>
      ) : (
        <Tile icon={ICONS[row.id]} size={36} tone={tone} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="type-row font-semibold text-duet-ink [overflow-wrap:anywhere]">
              {row.title}
            </h3>
            {row.required ? (
              <p className="type-label text-duet-ink-3">Required</p>
            ) : null}
          </div>
          <OutcomePill icon={row.ready ? "check" : null} tone={tone}>
            {row.status === "ready"
              ? "Ready"
              : row.status === "not_checked"
                ? "Not checked"
                : "Needs setup"}
          </OutcomePill>
        </div>
        <p className="type-sub mt-1 text-duet-ink-2 [overflow-wrap:anywhere]">
          {row.detail}
        </p>
        {!row.ready && row.fix ? (
          <Fix
            connecting={connecting}
            dismissed={dismissed}
            fix={row.fix}
            onConnect={onConnect}
            onDismiss={onDismiss}
            openPage={openPage}
          />
        ) : null}
      </div>
    </li>
  );
}

const LINK =
  "font-semibold text-duet-violet underline-offset-2 outline-none hover:underline focus-visible:underline";

/** How to close one gap: a page, the variables to set, or a connection to make here and now. */
function Fix({
  fix,
  dismissed,
  connecting,
  onConnect,
  onDismiss,
  openPage,
}: {
  fix: SetupFix;
  dismissed: boolean;
  connecting: boolean;
  onConnect: (serverId: string) => void;
  onDismiss: () => void;
  openPage: (path: string) => void;
}) {
  const page = (target: { label: string; path: string }) => (
    <a
      className={LINK}
      href={target.path}
      onClick={(event) => {
        event.preventDefault();
        openPage(target.path);
      }}
    >
      {target.label}
    </a>
  );
  const guide = (url: string) => (
    <a className={LINK} href={url} rel="noopener noreferrer" target="_blank">
      Setup guide
    </a>
  );

  if (fix.kind === "connect") {
    if (dismissed) {
      return (
        <p className="type-sub mt-2 text-duet-ink-3">
          You can connect it later in Connections.
        </p>
      );
    }
    return (
      <div className="mt-3 flex gap-2">
        <button
          className="type-label h-9 rounded-full bg-duet-black px-4 font-semibold text-duet-on-black outline-none transition-[filter,transform,opacity] hover:brightness-125 focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:scale-[0.97] disabled:opacity-50"
          disabled={connecting}
          onClick={() => onConnect(fix.serverId)}
          type="button"
        >
          {connecting ? "Connecting…" : "Connect"}
        </button>
        <button
          className="type-label h-9 rounded-full px-4 font-semibold text-duet-ink shadow-[inset_0_0_0_1px_var(--duet-hair)] outline-none transition-colors hover:bg-duet-tile focus-visible:ring-3 focus-visible:ring-duet-violet/40"
          onClick={onDismiss}
          type="button"
        >
          Not now
        </button>
      </div>
    );
  }

  if (fix.kind === "notify") {
    return (
      <div className="mt-3 flex gap-2">
        <button
          className="type-label h-9 rounded-full bg-duet-black px-4 font-semibold text-duet-on-black outline-none transition-[filter,transform,opacity] hover:brightness-125 focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:scale-[0.97]"
          onClick={() => void requestNotificationPermission()}
          type="button"
        >
          Turn on
        </button>
      </div>
    );
  }

  if (fix.kind === "page") {
    return (
      <p className="type-sub mt-2 text-duet-ink-2">
        Open {page(fix)}. {fix.docsUrl ? guide(fix.docsUrl) : null}
      </p>
    );
  }

  return (
    <p className="type-sub mt-2 text-duet-ink-2">
      Set{" "}
      {fix.names.map((name, at) => (
        <Fragment key={name}>
          {at > 0 ? (at === fix.names.length - 1 ? " and " : ", ") : null}
          <code className="rounded-md bg-duet-tile px-1.5 py-0.5 font-mono text-[0.85em] text-duet-ink [overflow-wrap:anywhere]">
            {name}
          </code>
        </Fragment>
      ))}
      , then restart {PRODUCT}.
      {fix.page ? <> Or add one in {page(fix.page)}.</> : null}{" "}
      {guide(fix.docsUrl)}
    </p>
  );
}
