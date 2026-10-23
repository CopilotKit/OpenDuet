import { useQuery } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  type LinkOptions,
} from "@tanstack/react-router";
import React from "react";
import { DuetIcon, type DuetIconName } from "@/components/duet/icons";
import { Row, Segmented } from "@/components/duet/kit";
import {
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { StandingInstructions } from "@/components/settings/standing-instructions";
import { useTheme } from "@/components/theme-provider";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { Separator } from "@/components/ui/separator";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { appConfig } from "@/lib/generated/application-config";
import { formatHotkey, HOTKEYS } from "@/lib/hotkeys/hotkeys";
import type { ThemePreference } from "@/lib/theme";

export const Route = createFileRoute("/_authed/settings/")({
  component: RouteComponent,
});

const APPEARANCE: readonly { value: ThemePreference; label: string }[] = [
  { value: "system", label: "Match phone" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** Every place a person sets something up, one row each, in the order they reach for them. */
const PLACES: readonly {
  label: string;
  icon: DuetIconName;
  to: LinkOptions["to"];
  adminOnly?: boolean;
}[] = [
  { label: "Bots", icon: "bolt", to: "/bots" },
  { label: "Connections", icon: "plug", to: "/connections" },
  { label: "Capabilities", icon: "box", to: "/capabilities" },
  { label: "Routines", icon: "repeat", to: "/routines" },
  { label: "Approval rules", icon: "shieldCheck", to: "/settings/approvals" },
  { label: "Notifications", icon: "bell", to: "/settings/notifications" },
  { label: "Passwords", icon: "key", to: "/settings/passwords" },
  { label: "Admin", icon: "shieldLock", to: "/admin", adminOnly: true },
];

/**
 * Settings, as one page of rows (parity-spec 1.2 and 2.9): how the app looks, then every place a
 * person sets something up, then the instructions every Bot follows. It opens from the avatar disc,
 * under the app's page chrome.
 *
 * What a person never needed is gone: the components gallery and the message list's emphasis in the
 * old sidebar were developer surfaces, and keyboard shortcuts only show where there is a keyboard.
 */
function RouteComponent() {
  const { preference, setPreference } = useTheme();
  const { data: user } = useQuery(currentUserQueryOptions());
  const product = appConfig.brand.productName;

  return (
    <PageShell
      description={`How ${product} looks and works for you.`}
      title="Settings"
    >
      <PageSection title="Appearance">
        <div className="mt-3">
          <Segmented
            label="Appearance"
            onChange={setPreference}
            options={APPEARANCE}
            value={preference}
          />
        </div>
      </PageSection>
      <nav aria-label="Settings" className="mt-8 flex flex-col gap-0.5">
        {PLACES.filter(
          (place) => !place.adminOnly || user?.role === "admin",
        ).map((place) => (
          <Row
            chevron
            key={place.label}
            leading={<DuetIcon name={place.icon} size={22} />}
            link={({ className, children }) => (
              <Link className={className} to={place.to}>
                {children}
              </Link>
            )}
            size="nav"
            title={place.label}
          />
        ))}
      </nav>
      <StandingInstructions />
      {/*
       * Only where there is a keyboard. Drawn from the same registry the listeners match against, so
       * this list is what the keys actually do. Read-only: they are not rebindable.
       */}
      <PageSection className="hidden md:block" title="Keyboard shortcuts">
        <PageRows>
          {HOTKEYS.map((hotkey, index) => (
            <React.Fragment key={hotkey.id}>
              <Item size="sm">
                <ItemContent>
                  <ItemTitle>{hotkey.label}</ItemTitle>
                  <ItemDescription>{hotkey.description}</ItemDescription>
                </ItemContent>
                <ItemActions>
                  <span className="flex gap-1">
                    {formatHotkey(hotkey.combo).map((part) => (
                      <kbd
                        className="rounded-md border bg-muted px-1.5 py-0.5 font-sans text-xs text-muted-foreground"
                        key={part}
                      >
                        {part}
                      </kbd>
                    ))}
                  </span>
                </ItemActions>
              </Item>
              {index !== HOTKEYS.length - 1 && <Separator />}
            </React.Fragment>
          ))}
        </PageRows>
      </PageSection>
    </PageShell>
  );
}
