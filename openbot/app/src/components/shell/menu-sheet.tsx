import { IconArchive, IconChevronRight, IconStack2 } from "@tabler/icons-react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Link, type LinkOptions, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useId, useRef, useState } from "react";
import { BotsNavBadge } from "@/components/bot-profile/attention";
import { ChannelGlyph } from "@/components/duet/channel-look";
import { DuetIcon, type DuetIconName } from "@/components/duet/icons";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { useOnScreen } from "@/hooks/use-on-screen";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import {
  conversationTitle,
  firstMessageQueryOptions,
} from "@/lib/channels/conversation-title";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { archiveDuetChannelMutationOptions } from "@/lib/duet-channels/mutations";
import type { DuetChannel } from "@/lib/duet-channels/queries";
import { useDuetChannels } from "@/lib/duet-channels/use-channel";
import { appConfig } from "@/lib/generated/application-config";
import { cn } from "@/lib/utils";
import { queryClient } from "@/query-client";

type Page = {
  label: string;
  to: LinkOptions["to"];
  icon: DuetIconName;
  badge?: ReactNode;
};

/**
 * The pages OpenBot's sidebar used to list, other than Settings. A person sets their Bots up here
 * and comes back rarely, so these wait under Manage, closed until somebody opens it.
 */
const MANAGE_PAGES: Page[] = [
  { label: "Bots", to: "/bots", icon: "bolt", badge: <BotsNavBadge /> },
  { label: "Connections", to: "/connections", icon: "plug" },
  { label: "Capabilities", to: "/capabilities", icon: "box" },
  { label: "Routines", to: "/routines", icon: "repeat" },
  { label: "Approval rules", to: "/settings/approvals", icon: "shieldCheck" },
];

/** Whether Manage was left open, kept in this browser between visits. */
export const MANAGE_STORAGE_KEY = "openbot.menu-manage";
/** Whether Archived was left open, kept the same way. */
export const ARCHIVED_STORAGE_KEY = "openduet.menu-archived";

/** Everything's line under its name. */
export const EVERYTHING_LINE = "All chat context across every channel";

/**
 * Only the exact stored `open` starts a group open. A key never written, or storage this browser will
 * not give us, leaves it closed, which is where it starts for everybody.
 */
function rememberedOpen(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "open";
  } catch {
    return false;
  }
}

function rememberOpen(key: string, open: boolean): void {
  try {
    window.localStorage.setItem(key, open ? "open" : "closed");
  } catch {
    // Storage can be unavailable or full. The group still opens; it just starts closed next time.
  }
}

/** A group in the menu that opens and closes, and remembers which it was in this browser. */
function useRememberedGroup(key: string) {
  const [open, setOpen] = useState(() => rememberedOpen(key));
  const id = useId();
  return {
    open,
    id,
    toggle: () => {
      rememberOpen(key, !open);
      setOpen(!open);
    },
  };
}

/**
 * A row in the menu: a line glyph and the place's name at the drawer's size (parity-spec 1.1, 2.3),
 * at least 48px tall, on the filled capsule when it is where you are.
 */
const ROW =
  "type-nav flex min-h-12 w-full items-center gap-3 rounded-[22px] px-3 font-medium text-duet-ink transition-colors duration-[var(--duet-dur-tap)] hover:bg-duet-tile active:bg-duet-tile focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-accent/40 [&_svg]:shrink-0 [&_svg]:text-duet-ink-2";

/** The glyph at the head of a menu row. */
function RowIcon({ name }: { name: DuetIconName }) {
  return <DuetIcon name={name} size={22} />;
}

/** A row with a disc, a name and a line under it: Everything and each channel. */
const TALL_ROW =
  "flex min-h-[50px] w-full items-center gap-3 rounded-[24px] px-2.5 py-1.5 text-left transition-colors hover:bg-duet-tile focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40";

/**
 * The drawer behind the header's left disc, which is for focus, not history. From the top: the
 * wordmark; Everything, which is Chat, the one thread; the person's channels, each its icon on a
 * disc in its colour, its name and its purpose; New channel; and Archived, folded. The pages that set
 * things up sit under Manage at the foot, closed by default, with Settings on its own under it.
 *
 * The channels take whatever height is left and scroll by themselves, so the rows above and below
 * stay put. New channel is the shell's to open (`onNewChannel`), so its sheet stands on its own
 * rather than over this one. Admin only for admins; Sign out only where signing out means something.
 */
export function MenuSheet({
  open,
  onOpenChange,
  onNewChannel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** New channel was pressed: close the drawer and open the sheet. Absent, the row is not drawn. */
  onNewChannel?: () => void;
}) {
  const navigate = useNavigate();
  const { data: user } = useQuery(currentUserQueryOptions());
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const manage = useRememberedGroup(MANAGE_STORAGE_KEY);
  const archived = useRememberedGroup(ARCHIVED_STORAGE_KEY);
  const { bot, list } = useDuetChannels();
  const unarchive = useMutation(archiveDuetChannelMutationOptions(queryClient));
  const close = () => onOpenChange(false);
  // In the order they were made, so a channel keeps its place however recently it was used.
  const channels = [...(list.data?.channels ?? [])].sort((a, b) =>
    a.createdAt.localeCompare(b.createdAt),
  );
  /*
   * A channel is a conversation made or kept as one: it has a look of its own ("dressed"). Every
   * other conversation is from before channels, and is listed under Archived as one of the
   * "Earlier conversations", titled by what it is about, never as a channel named after the Bot.
   */
  const current = channels.filter(
    (channel) => channel.dressed && channel.archivedAt === null,
  );
  // Newest put away first.
  const away = channels
    .filter((channel) => channel.dressed && channel.archivedAt !== null)
    .sort((a, b) => (b.archivedAt ?? "").localeCompare(a.archivedAt ?? ""));
  // Most recently used first. One where nothing was ever said has nothing to go back to.
  const earlier = channels
    .filter((channel) => !channel.dressed && channel.lastMessageAt !== null)
    .sort((a, b) =>
      (b.lastMessageAt ?? b.createdAt).localeCompare(
        a.lastMessageAt ?? a.createdAt,
      ),
    );

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      {/*
       * No close button (parity-spec 1.1): the drawer closes on the strip of screen beside it, on
       * Escape, and on choosing a row. The X it had was a 26px target.
       */}
      <SheetContent
        className="duet-face w-[340px] gap-0 bg-duet-surface p-0 sm:max-w-[340px]"
        showCloseButton={false}
        side="left"
      >
        <SheetHeader className="px-5 pt-5 pb-3">
          <SheetTitle className="type-display font-semibold text-duet-ink">
            {appConfig.brand.productName}
          </SheetTitle>
          <SheetDescription className="type-sub truncate text-duet-ink-2">
            {user?.name || user?.email}
          </SheetDescription>
        </SheetHeader>
        <nav
          aria-label="Menu"
          className="flex min-h-0 flex-1 flex-col px-3 pb-4"
        >
          {/* Exact, as on the tab bar, so Everything is marked current on Chat alone. */}
          <Link
            activeOptions={{ exact: true }}
            activeProps={{ className: "bg-duet-tile" }}
            className={TALL_ROW}
            onClick={close}
            to="/"
          >
            <span
              aria-hidden
              className="grid size-6 shrink-0 place-items-center text-duet-violet"
            >
              <IconStack2 size={24} stroke={1.9} />
            </span>
            <RowText line={EVERYTHING_LINE} name="Everything" wrap />
          </Link>
          {/*
           * Only the channels scroll (parity-spec 1.1), and Archived's rows once it is open. New
           * channel and Archived stay put right under the channels however many there are, so New
           * channel is never pushed out of reach below a long list.
           */}
          <div className="mt-1 flex min-h-0 flex-1 flex-col">
            <div
              className="min-h-0 shrink overflow-y-auto overscroll-contain"
              data-testid="drawer-channels"
            >
              {bot === undefined || list.isPending ? null : list.error ? (
                <p className="type-sub px-3 py-2 text-duet-red" role="alert">
                  Couldn't load your channels. Reload the page.
                </p>
              ) : current.length > 0 ? (
                /*
                 * Indented under Everything and joined to it by a hairline, which runs down from
                 * Everything's icon: these are the parts of the one thread, not threads beside it.
                 */
                <ul
                  aria-label="Channels"
                  className="ml-[21px] flex flex-col border-duet-ink-3/40 border-l pl-1.5"
                >
                  {current.map((channel) => (
                    <li key={channel.id}>
                      <ChannelLink channel={channel} onOpen={close} />
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            {onNewChannel && bot ? (
              <button
                className={cn(ROW, "mt-1 shrink-0")}
                onClick={onNewChannel}
                type="button"
              >
                <RowIcon name="plus" />
                New channel
              </button>
            ) : null}
            {away.length > 0 || earlier.length > 0 ? (
              <>
                <h2 className="mt-1 shrink-0">
                  <button
                    aria-controls={archived.id}
                    aria-expanded={archived.open}
                    className={ROW}
                    onClick={archived.toggle}
                    type="button"
                  >
                    <IconArchive />
                    Archived
                    <IconChevronRight
                      aria-hidden
                      className={cn(
                        "ml-auto transition-transform motion-reduce:transition-none",
                        archived.open && "rotate-90",
                      )}
                    />
                  </button>
                </h2>
                <div
                  className="min-h-0 shrink overflow-y-auto overscroll-contain"
                  hidden={!archived.open}
                  id={archived.id}
                >
                  <ul aria-label="Archived channels" className="flex flex-col">
                    {away.map((channel) => (
                      <li className="flex items-center gap-1" key={channel.id}>
                        <ChannelLink
                          className="min-w-0 flex-1"
                          channel={channel}
                          onOpen={close}
                        />
                        <button
                          aria-label={`Unarchive ${channel.name}`}
                          className="type-label shrink-0 rounded-full px-3 py-1.5 font-semibold text-duet-ink-2 outline-none transition-colors hover:bg-duet-tile focus-visible:ring-3 focus-visible:ring-duet-violet/40 disabled:opacity-50"
                          disabled={
                            unarchive.isPending &&
                            unarchive.variables?.id === channel.id
                          }
                          onClick={() =>
                            unarchive.mutate({
                              id: channel.id,
                              archived: false,
                            })
                          }
                          type="button"
                        >
                          Unarchive
                        </button>
                      </li>
                    ))}
                  </ul>
                  {earlier.length > 0 && archived.open ? (
                    <>
                      {/* A label, not a heading: the menu keeps one heading level. */}
                      <p
                        aria-hidden
                        className="type-label mt-2 px-3 pb-1 font-medium text-duet-ink-2"
                      >
                        Earlier conversations
                      </p>
                      <ul
                        aria-label="Earlier conversations"
                        className="flex flex-col"
                      >
                        {earlier.map((conversation) => (
                          <li key={conversation.id}>
                            <EarlierLink
                              conversation={conversation}
                              onOpen={close}
                            />
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                </div>
                {unarchive.error ? (
                  <p className="type-label px-3 text-duet-red" role="alert">
                    {unarchive.error.message}
                  </p>
                ) : null}
              </>
            ) : null}
          </div>
          <div className="mt-2 flex shrink-0 flex-col border-duet-hair border-t pt-2">
            <h2>
              <button
                aria-controls={manage.id}
                aria-expanded={manage.open}
                className={ROW}
                onClick={manage.toggle}
                type="button"
              >
                <DuetIcon
                  className={cn(
                    "transition-transform motion-reduce:transition-none",
                    manage.open && "rotate-90",
                  )}
                  name="chevronRight"
                  size={22}
                />
                Manage
                {/* Closed, the group would hide the Bots badge, so the badge rides on Manage instead. */}
                {manage.open ? null : <BotsNavBadge />}
              </button>
            </h2>
            <div className="flex flex-col" hidden={!manage.open} id={manage.id}>
              {MANAGE_PAGES.map((page) => (
                <Link
                  activeProps={{ className: "bg-duet-tile" }}
                  className={ROW}
                  key={page.label}
                  onClick={close}
                  to={page.to}
                >
                  <RowIcon name={page.icon} />
                  {page.label}
                  {page.badge}
                </Link>
              ))}
              {user?.role === "admin" ? (
                <Link
                  activeProps={{ className: "bg-duet-tile" }}
                  className={ROW}
                  onClick={close}
                  to="/admin"
                >
                  <RowIcon name="shieldLock" />
                  Admin
                </Link>
              ) : null}
            </div>
            <Link
              activeProps={{ className: "bg-duet-tile" }}
              className={ROW}
              onClick={close}
              to="/settings"
            >
              <RowIcon name="settings" />
              Settings
            </Link>
            {capabilities?.localEvaluation === false ? (
              <button
                className={ROW}
                disabled={signOut.isPending}
                onClick={async () => {
                  await signOut.mutateAsync();
                  close();
                  await navigate({ to: "/sign" });
                }}
                type="button"
              >
                <RowIcon name="logout" />
                Sign out
              </button>
            ) : null}
          </div>
        </nav>
      </SheetContent>
    </Sheet>
  );
}

/** A name in the row's ink, and one line under it, cut short unless it is Everything's own. */
function RowText({
  name,
  line,
  wrap = false,
}: {
  name: string;
  line: string | null;
  wrap?: boolean;
}) {
  return (
    <span className="min-w-0 flex-1">
      <span className="block truncate font-medium text-[18px] text-duet-ink leading-[22px]">
        {name}
      </span>
      {line ? (
        <span
          className={cn(
            "block text-[13px] text-duet-ink-2 leading-[17px]",
            wrap ? undefined : "truncate",
          )}
        >
          {line}
        </span>
      ) : null}
    </span>
  );
}

/** One channel: its disc, its name and its purpose. A conversation with several Bots opens its group. */
function ChannelLink({
  channel,
  onOpen,
  className,
}: {
  channel: DuetChannel;
  onOpen: () => void;
  className?: string;
}) {
  const body = (
    <>
      <ChannelGlyph colour={channel.colour} icon={channel.icon} size={24} />
      <RowText line={channel.purpose} name={channel.name} />
    </>
  );
  return channel.agentIds.length > 1 ? (
    <Link
      activeProps={{ className: "bg-duet-tile" }}
      className={cn(TALL_ROW, className)}
      onClick={onOpen}
      params={{ channelId: channel.id }}
      to="/group/$channelId"
    >
      {body}
    </Link>
  ) : (
    <Link
      activeProps={{ className: "bg-duet-tile" }}
      className={cn(TALL_ROW, className)}
      onClick={onOpen}
      params={{ channelId: channel.id }}
      to="/channels/$channelId"
    >
      {body}
    </Link>
  );
}

/**
 * A conversation from before channels, under Archived: titled by its summary, else what the person
 * first asked in it, else what was last said (`conversationTitle`), and opened as the conversation
 * it is, at `/channel/<id>`, so opening it does not make it a channel.
 */
function EarlierLink({
  conversation,
  onOpen,
}: {
  conversation: DuetChannel;
  onOpen: () => void;
}) {
  const agentId =
    conversation.agentIds.length === 1 ? conversation.agentIds[0] : undefined;
  const said = conversation.lastMessageAt !== null;
  const row = useRef<HTMLSpanElement>(null);
  const wanted = Boolean(
    !conversation.summary && conversation.threadId && agentId && said,
  );
  const onScreen = useOnScreen(row, wanted);
  const first = useQuery({
    ...firstMessageQueryOptions(
      conversation.threadId ?? "",
      agentId ?? "",
      said,
    ),
    enabled: wanted && onScreen,
  });
  const title = conversationTitle({
    summary: conversation.summary,
    firstMessage: first.data,
    lastMessage: conversation.lastMessage,
  });
  return (
    <Link
      activeProps={{ className: "bg-duet-tile" }}
      className={cn(ROW, "min-h-11 pl-3")}
      onClick={onOpen}
      params={{ channelId: conversation.id }}
      to="/channel/$channelId"
    >
      <span
        className="block min-w-0 flex-1 truncate font-normal text-[16px] text-duet-ink"
        ref={row}
      >
        {title}
      </span>
    </Link>
  );
}
