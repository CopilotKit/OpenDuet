import { IconX } from "@tabler/icons-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button, buttonVariants } from "@/components/ui/button";
import { deploymentCapabilitiesQueryOptions } from "@/lib/deployment/queries";
import {
  dismissSelfHostBannerMutationOptions,
  useUserPreferences,
} from "@/lib/settings/message-list";
import { appConfig } from "@/lib/generated/application-config";
import { cn } from "@/lib/utils";

/** `ref` tells CopilotKit the visit came from inside a running OpenDuet, not from the README. */
export const SELF_HOST_URL =
  "https://www.copilotkit.ai/talk-to-an-engineer?ref=openduet_app";

/**
 * A slim bar offering help self-hosting this product, until this person closes it.
 *
 * Hidden until both answers are in, so it never flashes on and then off: the deployment has to say
 * the banner is on (a fork running OpenBot for its own people turns it off), and this person's
 * preferences have to say they have not closed it.
 */
export function SelfHostBanner() {
  const queryClient = useQueryClient();
  const { data: capabilities } = useQuery(deploymentCapabilitiesQueryOptions());
  const { data: preferences, userId } = useUserPreferences();
  const dismiss = useMutation(
    dismissSelfHostBannerMutationOptions(queryClient, userId),
  );

  if (!capabilities?.selfHostBanner) return null;
  if (!preferences || preferences.selfHostBannerDismissed) return null;

  return (
    <aside
      aria-label={`Self-host ${appConfig.brand.productName}`}
      className="duet-face type-caption flex shrink-0 flex-wrap items-center gap-x-2 border-duet-hair-2 border-b bg-duet-card px-4 py-0.5 text-duet-ink-2"
    >
      {/*
       * Packed from the left rather than pushing Dismiss to the far right: on localhost CopilotKit's
       * dev inspector floats over the top-right corner, which is where somebody trying OpenBot first
       * sees this, and a Dismiss under it cannot be clicked.
       *
       * Wraps rather than truncates, so a phone reads the whole sentence. The link and Dismiss stay
       * together and drop to the next line as one, which keeps Dismiss on the left there too.
       */}
      <p>Self-host {appConfig.brand.productName} for your organization.</p>
      <span className="flex items-center gap-2">
        {/* An anchor, not Button: Base UI gives a rendered anchor role="button", and this is a link. */}
        <a
          // Foreground, not the link variant's primary, which is a mid grey on the dark bar.
          className={cn(
            buttonVariants({ size: "sm", variant: "link" }),
            // 44px tall to tap, as every control is (parity-spec 2.11).
            "type-caption min-h-11 px-0 font-semibold text-duet-ink underline",
          )}
          href={SELF_HOST_URL}
          rel="noopener noreferrer"
          target="_blank"
        >
          Talk to an engineer
        </a>
        <Button
          aria-label="Dismiss"
          onClick={() => dismiss.mutate()}
          className="size-11 text-duet-ink-3 hover:text-duet-ink"
          size="icon"
          variant="ghost"
        >
          <IconX />
        </Button>
      </span>
    </aside>
  );
}
