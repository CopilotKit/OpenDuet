import { MicOrb } from "@/components/duet/mic-orb";
import type { OrbColour } from "@/components/duet/mic-orb-draw";
import { isTenantBot } from "@/lib/agents/primary-bot";

/** The orb's colours another Bot can wear: every one but Ocean, which is the tenant's own Bot's. */
const OTHER_COLOURS: readonly OrbColour[] = ["ember", "lime", "graphite"];

/**
 * The same colour for the same Bot, every time and everywhere it is drawn.
 *
 * FNV-1a rather than a running `* 31`: short ids that differ only near their end, `your-agent` and
 * `support-desk`, all landed on one colour with the simpler hash, and a roster of Bots in one colour
 * says nothing about which is which.
 */
export function orbColourFor(id: string): OrbColour {
  let hash = 0x811c9dc5;
  for (const char of id) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return OTHER_COLOURS[hash % OTHER_COLOURS.length] ?? "ember";
}

/**
 * A Bot's face: the mic orb, still, its glow left unclipped. The tenant's own Bot wears Ocean; every
 * other Bot wears one of the orb's other colours, picked from its id, so a roster reads as one
 * family of Duets. It used to be an abstract gradient disc, which on the onboarding roster sat beside
 * OpenDuet's orb as something from another product.
 */
export function AbstractAvatar({
  id,
  name,
  size = 40,
}: {
  /** The Bot's id: whether this is the tenant's own Bot, and which colour any other Bot wears. */
  id: string;
  name: string;
  /**
   * Kept for callers. The colour follows `id` instead, so a Bot is the same colour here as in the
   * conversation list (`ChannelAvatar`), which only has its id.
   */
  seed?: string;
  size?: number;
}) {
  const own = isTenantBot(id);
  return (
    <span
      role="img"
      aria-label={name}
      className="inline-flex shrink-0"
      style={{ height: size, width: size }}
    >
      {/* The drawing carries its own role; hidden so the coworker is announced once, by name. */}
      <span aria-hidden="true" className="contents">
        <MicOrb colour={own ? "ocean" : orbColourFor(id)} size={size} still />
      </span>
    </span>
  );
}
