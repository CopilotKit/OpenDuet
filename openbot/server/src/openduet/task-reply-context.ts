import {
  attachmentUrl,
  classifyAttachment,
  type AttachmentPart,
} from "@openbot/shared/attachments";
import type { TaskReplyContext } from "@openbot/shared/task-reply";
import {
  newInlineBudget,
  resolveAttachmentParts,
  type StoredAttachment,
} from "../channels/attachment-parts";
import type { ProactiveScope } from "../proactive/engine";
import { ProactiveRefusedError } from "../proactive/types";

/** Uses the same per-actor/thread file checks and Bot grants as ordinary chat. */
export function createTaskReplyContext(deps: {
  load(scope: ProactiveScope, id: string): Promise<StoredAttachment | null>;
  markSent(scope: ProactiveScope, ids: readonly string[]): Promise<void>;
  skillsFor(
    agentId: string,
  ): Promise<{ skills: { slug: string; instructions: string }[] }>;
}) {
  async function resolve(scope: ProactiveScope, input: TaskReplyContext) {
    const skillIds = [...new Set(input.skillIds ?? [])];
    const granted = skillIds.length
      ? (await deps.skillsFor(scope.agentId)).skills
      : [];
    const skillInstructions = skillIds.map((id) => {
      const skill = granted.find((entry) => entry.slug === id);
      if (!skill)
        throw new ProactiveRefusedError(
          "A selected skill is no longer available to this Bot. Remove it and send again.",
        );
      return skill.instructions;
    });
    const attachments: AttachmentPart[] = [];
    // Resolve through the ordinary hydration checks, including the inline budget, before accepting.
    // Only canonical references survive this call; bytes never enter the durable work payload.
    const ids = [...new Set(input.attachmentIds ?? [])];
    await resolveAttachmentParts(
      ids.map((id) => ({
        type: "document",
        source: { type: "url", value: attachmentUrl(id) },
      })),
      async (id) => {
        const stored = await deps.load(scope, id);
        if (!stored)
          throw new ProactiveRefusedError(
            "An attachment is no longer available in this conversation. Attach it again.",
          );
        attachments.push({
          type:
            classifyAttachment(stored.mimeType) === "image"
              ? "image"
              : "document",
          source: {
            type: "url",
            value: attachmentUrl(id),
            mimeType: stored.mimeType,
          },
          metadata: { attachmentId: id, filename: stored.name },
        });
        return stored;
      },
      "fail",
      newInlineBudget(),
    );
    return { attachments, skillInstructions };
  }
  return {
    resolve,
    async accept(scope: ProactiveScope, input: TaskReplyContext) {
      await resolve(scope, input);
      // Accepted replies can wait across restarts: the staged-file sweeper must not reclaim them.
      if (input.attachmentIds?.length)
        await deps.markSent(scope, input.attachmentIds);
    },
  };
}
