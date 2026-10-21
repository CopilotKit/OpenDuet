import { appConfig } from "@/lib/generated/application-config";
import { defaultAgentProfile } from "./default-agent";
import type { AgentProfile } from "./queries";

/**
 * The Bot the Chat, Inbox and Activity tabs are about.
 *
 * The product's own Bot shares the tenant's id (`examples/openduet/agents.yaml` declares `openduet`
 * for tenant `openduet`). A fork that renames its tenant without such a Bot falls back to the
 * deployment's default Bot, so the tabs never point at a Bot this deployment does not have.
 */
export function primaryBot(
  agents: readonly AgentProfile[] | undefined,
): AgentProfile | undefined {
  return (
    agents?.find((agent) => agent.id === appConfig.brand.tenantId) ??
    defaultAgentProfile(agents)
  );
}
