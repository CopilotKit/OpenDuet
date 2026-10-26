import { useRenderTool } from "@copilotkit/react-core/v2";
import { Link, useRouter } from "@tanstack/react-router";
import { z } from "zod";
import { ToolLine } from "@/components/channels/tool-line";
import {
  BuildIn,
  BuildInProvider,
  useArrivedLive,
} from "@/components/duet/build-in";
import { TaskLink } from "@/components/duet/task-card";
import { START_TASK_TOOL } from "@/lib/channels/task-brief";
import { readToolName } from "@/lib/plugins/tool-name";
import { asText, REFUSAL_MARKER } from "@/lib/plugins/tool-result";
import { useTask } from "@/lib/tasks/use-task";

/*
 * Draws the server's `start_task` tool (server/src/openduet/tasks.ts) as one line under the Bot's
 * "On it": the task's live glyph and its title, opening its page. The work happens in the task's own
 * conversation, so this line is all Chat shows of it. The transcript moves it to the end of its
 * turn, under the Bot's words (`repliesLast` in chat-messages.ts).
 */

export { START_TASK_TOOL };

const parameters = z.object({ title: z.string().optional() });

const startedSchema = z.object({
  taskId: z.string().min(1),
  thumbnail: z.string().nullable().optional(),
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

/**
 * The line for one started task, under the Bot's "On it": its live glyph and title, opening the
 * task's page. The glyph is read from the person's tasks and kept live (lib/tasks/queries.ts), so it
 * moves from Working to Ready for review, or to Failed, while the line sits in the thread.
 */
export function ChatTaskCard({ started }: { started: StartedTask }) {
  const router = useRouter({ warn: false });
  const { task, status } = useTask(started.taskId);
  return (
    <TaskLink
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
      status={status}
      title={task?.title ?? started.title}
      thumbnail={task?.thumbnail ?? started.thumbnail}
    />
  );
}

export function TaskCardTool() {
  useRenderTool({
    name: START_TASK_TOOL,
    parameters,
    render: ({ result, status }) => (
      <TaskToolView
        result={result}
        running={status !== "complete" && result === undefined}
      />
    ),
  });
  return null;
}

/** The tool's line while it starts the task, then the task's line, rising in if it arrived live. */
function TaskToolView({
  result,
  running,
}: {
  result: unknown;
  running: boolean;
}) {
  const live = useArrivedLive(running);
  if (running)
    return (
      <ToolLine label={readToolName(START_TASK_TOOL, true).label} running />
    );
  const started = readStartedTask(result);
  // Nothing for a refusal: the Bot is told what to fix and tries again.
  if (!started) return null;
  return (
    <BuildInProvider value={live}>
      <BuildIn order={0}>
        <ChatTaskCard started={started} />
      </BuildIn>
    </BuildInProvider>
  );
}
