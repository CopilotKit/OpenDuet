import { describe, expect, test } from "bun:test";
import {
  CHANNEL_COLOURS,
  CHANNEL_ICONS,
  channelLook,
  DEFAULT_CHANNEL_ICON,
  defaultChannelColour,
  isChannelColour,
  isChannelIcon,
  NEW_CHANNEL_COLOUR,
  NEW_CHANNEL_ICON,
} from "./channel-look";

describe("the sets", () => {
  test("nine colours and three rows of eight icons, each name once", () => {
    expect(CHANNEL_COLOURS).toHaveLength(9);
    expect(new Set(CHANNEL_COLOURS).size).toBe(9);
    expect(CHANNEL_ICONS).toHaveLength(24);
    expect(new Set(CHANNEL_ICONS).size).toBe(24);
    expect(CHANNEL_ICONS).toContain(DEFAULT_CHANNEL_ICON);
    expect(CHANNEL_ICONS).toContain(NEW_CHANNEL_ICON);
    // A new channel starts on the third colour.
    expect(CHANNEL_COLOURS.indexOf(NEW_CHANNEL_COLOUR)).toBe(2);
  });

  test("only the names in each set pass", () => {
    expect(isChannelIcon("plane")).toBe(true);
    expect(isChannelIcon("Plane")).toBe(false);
    expect(isChannelIcon(undefined)).toBe(false);
    expect(isChannelColour("sage")).toBe(true);
    expect(isChannelColour("#00ffff")).toBe(false);
  });
});

describe("the default look", () => {
  test("is the same colour for the same conversation, every time", () => {
    const id = "channel_8f14e45f-ceea-467f-a8b4-3c1a2d0e9b71";
    const first = defaultChannelColour(id);
    for (let index = 0; index < 5; index += 1)
      expect(defaultChannelColour(id)).toBe(first);
    expect(channelLook(id, null)).toEqual({
      icon: DEFAULT_CHANNEL_ICON,
      colour: first,
    });
  });

  test("spreads conversations across the colours rather than painting them all one", () => {
    const seen = new Set(
      Array.from({ length: 60 }, (_, index) =>
        defaultChannelColour(`channel_${index}-${index * 7919}`),
      ),
    );
    expect(seen.size).toBeGreaterThanOrEqual(6);
  });

  test("a chosen look wins, and a stored name outside the sets falls back", () => {
    expect(channelLook("c1", { icon: "plane", colour: "berry" })).toEqual({
      icon: "plane",
      colour: "berry",
    });
    expect(channelLook("c1", { icon: "spaceship", colour: "mauve" })).toEqual({
      icon: DEFAULT_CHANNEL_ICON,
      colour: defaultChannelColour("c1"),
    });
  });
});
