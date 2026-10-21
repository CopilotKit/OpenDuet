import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { ComponentProps } from "react";
import { DuetIcon, KiteMark } from "@/components/duet/icons";
import { currentUserQueryOptions } from "@/lib/auth/queries";
import { appConfig } from "@/lib/generated/application-config";
import { cn } from "@/lib/utils";

const DISC =
  "grid shrink-0 place-items-center rounded-full bg-duet-card text-duet-ink shadow-duet-float transition-transform focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-duet-violet/40 active:scale-95";

/** The person's initial, from their name, or their email when they have none. */
export function initialOf(user: { name?: string | null; email: string }) {
  const source = user.name?.trim() || user.email;
  return (source.match(/\p{L}|\p{N}/u)?.[0] ?? "?").toUpperCase();
}

/**
 * The film's header: three discs over the content, the menu on the left, the mark in the centre
 * (back to Chat), the person's initial on the right (their settings).
 *
 * `floating` lays it over a screen that scrolls under it, behind a fade, as on Chat, Inbox and
 * Activity. Otherwise it is a bar in the page's flow, for the screens the menu opens.
 */
export function ShellHeader({
  floating,
  menuOpen,
  onMenu,
}: {
  floating: boolean;
  menuOpen: boolean;
  onMenu: () => void;
}) {
  const { data: user } = useQuery(currentUserQueryOptions());
  const side = floating ? 46 : 40;
  const centre = floating ? 62 : 48;
  return (
    <header
      className={cn(
        "duet-face z-20 flex items-start justify-between px-4",
        floating
          ? "pointer-events-none absolute inset-x-0 top-0 h-32 bg-[linear-gradient(var(--duet-surface)_52%,transparent)] pt-3"
          : "relative h-16 shrink-0 items-center border-border border-b bg-background",
      )}
    >
      <Disc
        aria-expanded={menuOpen}
        aria-label="Menu"
        className={floating ? "mt-2" : undefined}
        onClick={onMenu}
        size={side}
      >
        <DuetIcon name="menu" size={21} />
      </Disc>
      <Link
        aria-label={`${appConfig.brand.productName} chat`}
        className={cn(DISC, "pointer-events-auto")}
        style={{ width: centre, height: centre }}
        to="/"
      >
        <KiteMark id="shell-mark" optical size={centre * 0.55} />
      </Link>
      <Link
        aria-label="Your settings"
        className={cn(DISC, "pointer-events-auto", floating && "mt-2")}
        style={{ width: side, height: side }}
        to="/settings"
      >
        <span className="font-semibold text-[18px] leading-5">
          {user ? initialOf(user) : null}
        </span>
      </Link>
    </header>
  );
}

function Disc({
  size,
  className,
  ...props
}: ComponentProps<"button"> & { size: number }) {
  return (
    <button
      className={cn(DISC, "pointer-events-auto", className)}
      style={{ width: size, height: size }}
      type="button"
      {...props}
    />
  );
}
