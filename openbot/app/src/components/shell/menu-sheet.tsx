import {
  IconBolt,
  IconBox,
  IconCalendarRepeat,
  IconLogout,
  IconPlug,
  IconPlus,
  IconSettings,
  IconShieldCheck,
  IconShieldLock,
} from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, type LinkOptions, useNavigate } from "@tanstack/react-router";
import { type ReactNode, useRef } from "react";
import { ConversationRoster } from "@/components/app-sidebar/conversation-roster";
import { BotsNavBadge } from "@/components/bot-profile/attention";
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

type Page = {
  label: string;
  to: LinkOptions["to"];
  icon: ReactNode;
  badge?: ReactNode;
};

/** OpenBot's own pages, which the sidebar used to list. Nothing it held is more than two taps away. */
export const MENU_PAGES: Page[] = [
  { label: "New conversation", to: "/start", icon: <IconPlus /> },
  { label: "Bots", to: "/bots", icon: <IconBolt />, badge: <BotsNavBadge /> },
  { label: "Connections", to: "/connections", icon: <IconPlug /> },
  { label: "Capabilities", to: "/capabilities", icon: <IconBox /> },
  { label: "Routines", to: "/routines", icon: <IconCalendarRepeat /> },
  {
    label: "Approval rules",
    to: "/settings/approvals",
    icon: <IconShieldCheck />,
  },
  { label: "Settings", to: "/settings", icon: <IconSettings /> },
];

const ROW =
  "flex h-11 w-full items-center gap-3 rounded-xl px-3 text-[15px] font-medium text-duet-ink hover:bg-duet-tile focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40 [&_svg]:size-5 [&_svg]:shrink-0 [&_svg]:text-duet-ink-2";

/**
 * The menu behind the header's left disc: every page OpenBot had in its sidebar, then every
 * conversation. Admin only for admins; Sign out only where signing out means something (a local,
 * single-person install signs straight back in).
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
        <div
          className="min-h-0 flex-1 overflow-y-auto px-3 pb-4"
          ref={scrollRoot}
        >
          <nav aria-label="Pages" className="flex flex-col">
            {MENU_PAGES.map((page) => (
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
          </nav>
          <h2 className="type-label mt-5 mb-2 px-3 font-semibold text-duet-ink-2">
            Conversations
          </h2>
          {/* Opening a conversation changes the page, and the shell closes the menu when it does. */}
          <ConversationRoster scrollRoot={scrollRoot} />
        </div>
      </SheetContent>
    </Sheet>
  );
}
