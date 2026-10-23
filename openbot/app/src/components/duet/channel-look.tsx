import {
  IconBook,
  IconBriefcase,
  IconCalendar,
  IconCar,
  IconChartBar,
  IconCube,
  IconCurrencyDollar,
  IconFolder,
  IconGift,
  IconHeart,
  IconHome,
  IconMail,
  IconMapPin,
  IconMusic,
  IconPencil,
  IconPlane,
  IconSearch,
  IconSeedling,
  IconShoppingBag,
  IconSquareCheck,
  IconToolsKitchen2,
  IconUsers,
  IconVideo,
  IconWorld,
  type TablerIcon,
} from "@tabler/icons-react";
import type { ChannelColour, ChannelIcon } from "@/lib/duet-channels/queries";
import { cn } from "@/lib/utils";

/*
 * How a channel is drawn: one of 24 line icons, stroked in its colour. The names come from
 * shared/channel-look.ts, which the server stores and checks; what each name draws is decided here.
 */

/** The glyph for each icon name, all line icons on one stroke weight. */
export const CHANNEL_GLYPHS: Record<ChannelIcon, TablerIcon> = {
  check: IconSquareCheck,
  calendar: IconCalendar,
  mail: IconMail,
  dollar: IconCurrencyDollar,
  chart: IconChartBar,
  globe: IconWorld,
  pin: IconMapPin,
  home: IconHome,
  cube: IconCube,
  video: IconVideo,
  folder: IconFolder,
  pencil: IconPencil,
  search: IconSearch,
  heart: IconHeart,
  people: IconUsers,
  briefcase: IconBriefcase,
  book: IconBook,
  plane: IconPlane,
  car: IconCar,
  food: IconToolsKitchen2,
  bag: IconShoppingBag,
  gift: IconGift,
  sprout: IconSeedling,
  music: IconMusic,
};

/** What each icon name is called, for a screen reader and the grid's radios. */
export const CHANNEL_ICON_LABELS: Record<ChannelIcon, string> = {
  check: "Checklist",
  calendar: "Calendar",
  mail: "Mail",
  dollar: "Money",
  chart: "Chart",
  globe: "Globe",
  pin: "Place",
  home: "Home",
  cube: "Box",
  video: "Video",
  folder: "Folder",
  pencil: "Pencil",
  search: "Search",
  heart: "Heart",
  people: "People",
  briefcase: "Briefcase",
  book: "Book",
  plane: "Plane",
  car: "Car",
  food: "Food",
  bag: "Shopping",
  gift: "Gift",
  sprout: "Sprout",
  music: "Music",
};

/** What each colour is called, for the dots' names. */
export const CHANNEL_COLOUR_LABELS: Record<ChannelColour, string> = {
  berry: "Berry",
  blush: "Blush",
  peach: "Peach",
  amber: "Amber",
  sage: "Sage",
  green: "Green",
  sky: "Sky",
  blue: "Blue",
  lavender: "Lavender",
};

/** The colour's CSS value, from the theme's tokens, so light and dark each get their own. */
export function channelColour(colour: ChannelColour): string {
  return `var(--duet-ch-${colour})`;
}

/** A channel's icon, stroked in its colour. Decorative: the name beside it says which channel. */
export function ChannelGlyph({
  icon,
  colour,
  size = 24,
  stroke = 1.9,
  className,
}: {
  icon: ChannelIcon;
  colour: ChannelColour;
  size?: number;
  stroke?: number;
  className?: string;
}) {
  const Glyph = CHANNEL_GLYPHS[icon];
  return (
    <span
      aria-hidden
      className={cn("inline-grid shrink-0 place-items-center", className)}
      data-channel-colour={colour}
      data-channel-icon={icon}
      style={{ color: channelColour(colour), width: size, height: size }}
    >
      <Glyph size={size} stroke={stroke} />
    </span>
  );
}

/**
 * The tag a task wears for the channel it was asked for in: its icon and its name, both in the
 * channel's colour. Nothing for a task asked for in Everything.
 */
export function ChannelTag({
  channel,
  className,
}: {
  channel: { name: string; icon: ChannelIcon; colour: ChannelColour } | null;
  className?: string;
}) {
  if (!channel) return null;
  return (
    <span
      className={cn(
        "inline-flex min-w-0 max-w-full items-center gap-1.5 font-medium text-[13px] leading-4",
        className,
      )}
      data-channel-tag={channel.colour}
      style={{ color: channelColour(channel.colour) }}
    >
      <ChannelGlyph
        colour={channel.colour}
        icon={channel.icon}
        size={12}
        stroke={2.2}
      />
      <span className="truncate">{channel.name}</span>
    </span>
  );
}
