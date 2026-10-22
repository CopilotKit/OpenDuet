import { appConfig } from "@/lib/generated/application-config";
import { defaultAgentProfile } from "./default-agent";
import type { AgentProfile } from "./queries";

/**
 * Whether this is the product's own Bot: the one that shares the tenant's id.
 *
 * `examples/openduet/agents.yaml` declares `openduet` for tenant `openduet`. The id comes from the
 * tenant package at build time, so a fork that renames its tenant and its Bot together gets the same
 * Bot back, under its own name. It is the Bot drawn as the mic orb and the one the tabs are about.
 */
export function isTenantBot(
  agentId: string,
  tenantId: string = appConfig.brand.tenantId,
): boolean {
  return agentId === tenantId;
}

/**
 * The Bot the Chat, Tasks and Activity tabs are about.
 *
 * The tenant's own Bot (see `isTenantBot`). A fork that renames its tenant without such a Bot falls
 * back to the deployment's default Bot, so the tabs never point at a Bot this deployment does not
 * have.
 */
export function primaryBot(
  agents: readonly AgentProfile[] | undefined,
): AgentProfile | undefined {
  return (
    agents?.find((agent) => isTenantBot(agent.id)) ??
    defaultAgentProfile(agents)
  );
}
