import { useRenderTool } from "@copilotkit/react-core/v2";
import { Link, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import { ChannelTagOf } from "@/components/duet/channel-tag";
import { TaskCard } from "@/components/duet/task-card";
import { START_TASK_TOOL } from "@/lib/channels/task-brief";
import { readToolName } from "@/lib/plugins/tool-name";
import { asText, REFUSAL_MARKER } from "@/lib/plugins/tool-result";
import { useTask } from "@/lib/tasks/use-task";

/*
 * Draws the server's `start_task` tool (server/src/openduet/tasks.ts) as the card under the Bot's
 * "On it": the task's title, where it stands, and a chevron that opens it. The work happens in the
 * task's own conversation, so this card is all Chat shows of it. The pill is read from the person's
 * tasks and kept live (lib/tasks/queries.ts), so it moves from Working to Ready for review while the
 * card sits in the thread. The transcript moves it to the end of its turn, under the Bot's words
 * (`repliesLast` in chat-messages.ts).
 */

export { START_TASK_TOOL };

const parameters = z.object({ title: z.string().optional() });

const startedSchema = z.object({
  taskId: z.string().min(1),
  channelId: z.string().min(1),
  title: z.string(),
});
export type StartedTask = z.infer<typeof startedSchema>;

/** The tool's result, or null for a refusal or anything that is not a started task. */
export function readStartedTask(result: unknown): StartedTask | null {
  if (typeof result !== "string" || asText(result).startsWith(REFUSAL_MARKER))
    return null;
  try {
    let value: unknown = JSON.parse(result);
    // A server tool's text can arrive JSON-encoded once more on the way through the runtime.
    if (typeof value === "string") value = JSON.parse(value);
    const parsed = startedSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** The card for one started task, opening the task's page. */
export function ChatTaskCard({ started }: { started: StartedTask }) {
  const router = useRouter({ warn: false });
  const { task, status } = useTask(started.taskId);
  return (
    <TaskCard
      link={({ className, children }) =>
        router ? (
          <Link
            className={className}
            params={{ taskId: started.taskId }}
            to="/tasks/$taskId"
          >
            {children}
          </Link>
        ) : (
          // A conversation drawn on its own, as tests do, has no router to open the task with.
          <a
            className={className}
            href={`/tasks/${encodeURIComponent(started.taskId)}`}
          >
            {children}
          </a>
        )
      }
      channel={<ChannelTagOf channelId={task?.fromChannelId} />}
      status={status}
      title={task?.title ?? started.title}
    />
  );
}

export function TaskCardTool() {
  useRenderTool({
    name: START_TASK_TOOL,
    parameters,
    render: ({ result, status }) => {
      if (status !== "complete" && result === undefined)
        return (
          <ToolLine label={readToolName(START_TASK_TOOL, true).label} running />
        );
      const started = readStartedTask(result);
      // Nothing for a refusal: the Bot is told what to fix and tries again.
      return started ? <ChatTaskCard started={started} /> : null;
    },
  });
  return null;
}
