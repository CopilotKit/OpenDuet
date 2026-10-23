import {
  IconBolt,
  IconBox,
  IconCalendarRepeat,
  IconChevronRight,
  IconLogout,
  IconPlug,
  IconPlus,
  IconSettings,
  IconShieldCheck,
  IconShieldLock,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, type LinkOptions, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useId, useRef, useState } from "react";
import { ConversationRoster } from "@/components/app-sidebar/conversation-roster";
import { BotsNavBadge } from "@/components/bot-profile/attention";
import { DuetIcon } from "@/components/duet/icons";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { signOutMutationOptions } from "@/lib/auth/mutations";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import { appConfig } from "@/lib/generated/application-config";
import { cn } from "@/lib/utils";

type Page = {
  label: string;
  to: LinkOptions["to"];
  icon: ReactNode;
  badge?: ReactNode;
};

/**
 * The pages OpenBot's sidebar used to list, other than Settings. A person sets their Bots up here
 * and comes back rarely, so these wait under Manage, closed until somebody opens it.
 */
const MANAGE_PAGES: Page[] = [
  { label: "Bots", to: "/bots", icon: <IconBolt />, badge: <BotsNavBadge /> },
  { label: "Connections", to: "/connections", icon: <IconPlug /> },
  { label: "Capabilities", to: "/capabilities", icon: <IconBox /> },
  { label: "Routines", to: "/routines", icon: <IconCalendarRepeat /> },
  {
    label: "Approval rules",
    to: "/settings/approvals",
    icon: <IconShieldCheck />,
  },
];

/** Whether Manage was left open, kept in this browser between visits. */
export const MANAGE_STORAGE_KEY = "openbot.menu-manage";
/** Whether Earlier conversations was left open, kept the same way. */
export const EARLIER_STORAGE_KEY = "openbot.menu-earlier";

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

const ROW =
  "flex h-11 w-full items-center gap-3 rounded-xl px-3 text-[15px] font-medium text-duet-ink hover:bg-duet-tile focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40 [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-duet-ink-2";

/**
 * The menu behind the header's left disc, in the order a person reaches for it: Chat, then Earlier
 * conversations, then the pages that set things up. Chat is the one thread; work bigger than a quick
 * answer runs as a task and opens from Tasks, so every other conversation waits under Earlier
 * conversations, closed by default, with a way to start a new one inside it. The pages that set
 * things up sit under Manage, closed by default, with Settings on its own at the foot.
 *
 * Opened, the roster takes whatever height is left and scrolls by itself, so the rows above and
 * below it stay put. Admin only for admins; Sign out only where signing out means something (a
 * local, single-person install signs straight back in).
 */
export function MenuSheet({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { data: user } = useQuery(currentUserQueryOptions());
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  const signOut = useMutation(signOutMutationOptions(queryClient));
  const scrollRoot = useRef<HTMLDivElement>(null);
  const manage = useRememberedGroup(MANAGE_STORAGE_KEY);
  const earlier = useRememberedGroup(EARLIER_STORAGE_KEY);
  const close = () => onOpenChange(false);

  return (
    <Sheet onOpenChange={onOpenChange} open={open}>
      <SheetContent
        className="duet-face w-[340px] gap-0 bg-duet-surface p-0 sm:max-w-[340px]"
        side="left"
      >
        <SheetHeader className="px-5 pt-5 pb-3">
          <SheetTitle className="type-title font-semibold text-duet-ink">
            {appConfig.brand.productName}
          </SheetTitle>
          <SheetDescription className="truncate text-duet-ink-3 text-sm">
            {user?.name || user?.email}
          </SheetDescription>
        </SheetHeader>
        {/*
         * The whole menu scrolls only when the screen is too short for the roster's minimum. On any
         * phone it is not, and the roster is the one thing that moves.
         */}
        <nav
          aria-label="Menu"
          className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-4"
        >
          {/* Exact, as on the tab bar, so Chat is marked current on Chat alone. */}
          <Link
            activeOptions={{ exact: true }}
            activeProps={{ className: "bg-duet-tile" }}
            className={ROW}
            onClick={close}
            to="/"
          >
            <DuetIcon name="chat" />
            Chat
          </Link>
          <h2 className="mt-1">
            <button
              aria-controls={earlier.id}
              aria-expanded={earlier.open}
              className={ROW}
              onClick={earlier.toggle}
              type="button"
            >
              <IconChevronRight
                className={cn(
                  "transition-transform motion-reduce:transition-none",
                  earlier.open && "rotate-90",
                )}
              />
              Earlier conversations
            </button>
          </h2>
          {/*
           * Closed, the group is its row alone. Open, the roster takes the height that is left, so
           * the rows around it stay put.
           */}
          <div
            className="flex min-h-40 flex-1 flex-col"
            hidden={!earlier.open}
            id={earlier.id}
          >
            <Link
              activeProps={{ className: "bg-duet-tile" }}
              className={ROW}
              onClick={close}
              to="/start"
            >
              <IconPlus />
              New conversation
            </Link>
            <div
              className="mt-1 min-h-0 flex-1 overflow-y-auto overscroll-contain"
              ref={scrollRoot}
            >
              {/* Opening a conversation changes the page, and the shell closes the menu when it does. */}
              {earlier.open ? (
                <ConversationRoster scrollRoot={scrollRoot} />
              ) : null}
            </div>
          </div>
          <div
            className={cn(
              "mt-2 flex shrink-0 flex-col border-duet-hair border-t pt-2",
              // At the foot either way: open, the roster above fills the height; closed, this does.
              earlier.open ? undefined : "mt-auto",
            )}
          >
            <h2>
              <button
                aria-controls={manage.id}
                aria-expanded={manage.open}
                className={ROW}
                onClick={manage.toggle}
                type="button"
              >
                <IconChevronRight
                  className={cn(
                    "transition-transform motion-reduce:transition-none",
                    manage.open && "rotate-90",
                  )}
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
                  {page.icon}
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
                  <IconShieldLock />
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
              <IconSettings />
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
                <IconLogout />
                Sign out
              </button>
            ) : null}
          </div>
        </nav>
      </SheetContent>
    </Sheet>
  );
}
