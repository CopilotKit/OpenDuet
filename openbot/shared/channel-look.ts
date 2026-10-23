/**
 * How an OpenDuet channel looks: one of 24 line icons, stroked in one of nine colours.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES. The server keeps each set with a check constraint on
 * `openduet_channels` and refuses anything outside it, and the app draws exactly these: the icon
 * grid and the nine dots in the New channel sheet, the icon in the drawer, the tag on a task. A
 * second list in either place would be a contract with two authors. The sets follow the parity
 * spec's 1.4: 24 everyday subjects and nine colours.
 *
 * The names are what is stored. What each name draws is the app's: a glyph and a colour token
 * (app/src/components/duet/channel-look.tsx), so a theme can change the colour without a migration.
 */

/** Everyday subjects, in the order the grid draws them: three rows of eight. */
export const CHANNEL_ICONS = [
  "check",
  "calendar",
  "mail",
  "dollar",
  "chart",
  "globe",
  "pin",
  "home",
  "cube",
  "video",
  "folder",
  "pencil",
  "search",
  "heart",
  "people",
  "briefcase",
  "book",
  "plane",
  "car",
  "food",
  "bag",
  "gift",
  "sprout",
  "music",
] as const;

export type ChannelIcon = (typeof CHANNEL_ICONS)[number];

/** Nine colours, in the order the dots draw them. */
export const CHANNEL_COLOURS = [
  "berry",
  "blush",
  "peach",
  "amber",
  "sage",
  "green",
  "sky",
  "blue",
  "lavender",
] as const;

export type ChannelColour = (typeof CHANNEL_COLOURS)[number];

/** The look the New channel sheet starts on: mail, in the third colour. */
export const NEW_CHANNEL_ICON: ChannelIcon = "mail";
export const NEW_CHANNEL_COLOUR: ChannelColour = "peach";

/** The generic icon a conversation nobody has dressed is drawn with. */
export const DEFAULT_CHANNEL_ICON: ChannelIcon = "folder";

/** The longest name a channel takes. */
export const MAX_CHANNEL_NAME = 40;
/** The longest purpose. The drawer shows its first line. */
export const MAX_CHANNEL_PURPOSE = 500;

export function isChannelIcon(value: unknown): value is ChannelIcon {
  return (
    typeof value === "string" &&
    (CHANNEL_ICONS as readonly string[]).includes(value)
  );
}

export function isChannelColour(value: unknown): value is ChannelColour {
  return (
    typeof value === "string" &&
    (CHANNEL_COLOURS as readonly string[]).includes(value)
  );
}

/**
 * The colour a conversation nobody has dressed is drawn in, picked from its id.
 *
 * STABLE, so the same conversation is the same colour on every screen and every visit, and the
 * colour a task's tag carries matches the disc in the drawer. FNV-1a over the id's UTF-16 units,
 * which is small, has no dependency, and spreads ids that share a long prefix (`channel_…`).
 */
export function defaultChannelColour(channelId: string): ChannelColour {
  let hash = 0x811c9dc5;
  for (let index = 0; index < channelId.length; index += 1) {
    hash ^= channelId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return CHANNEL_COLOURS[hash % CHANNEL_COLOURS.length] ?? NEW_CHANNEL_COLOUR;
}

/** A channel's look: what was chosen for it, or the default for one nobody has dressed. */
export function channelLook(
  channelId: string,
  chosen: { icon: string; colour: string } | null | undefined,
): { icon: ChannelIcon; colour: ChannelColour } {
  return {
    icon: isChannelIcon(chosen?.icon) ? chosen.icon : DEFAULT_CHANNEL_ICON,
    colour: isChannelColour(chosen?.colour)
      ? chosen.colour
      : defaultChannelColour(channelId),
  };
}
