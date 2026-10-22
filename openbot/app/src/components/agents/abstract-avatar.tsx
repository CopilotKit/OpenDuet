import Avatar from "boring-avatars";
import { MicOrb } from "@/components/duet/mic-orb";
import { isTenantBot } from "@/lib/agents/primary-bot";
import { cn } from "@/lib/utils";

/**
 * A Bot's face. The tenant's own Bot is the mic orb, still, its glow left unclipped; every other Bot
 * is the abstract disc drawn from its seed.
 */
export function AbstractAvatar({
  id,
  name,
  seed,
  size = 40,
}: {
  /** The Bot's id, which decides whether this is the tenant's own Bot. */
  id: string;
  name: string;
  seed: string;
  size?: number;
}) {
  const own = isTenantBot(id);
  return (
    <span
      role="img"
      aria-label={name}
      className={cn(
        "inline-flex shrink-0",
        !own && "overflow-hidden rounded-full",
      )}
      style={{ height: size, width: size }}
    >
      {/* The drawing carries its own role; hidden so the coworker is announced once, by name. */}
      <span aria-hidden="true" className="contents">
        {own ? (
          <MicOrb size={size} still />
        ) : (
          <Avatar name={seed} size={size} />
        )}
      </span>
    </span>
  );
}
