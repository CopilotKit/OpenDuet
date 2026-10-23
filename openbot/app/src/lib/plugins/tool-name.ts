import { SHOW_APP_ACCESS_TOOL } from "@openbot/shared/connect-prompt";
import {
  RESEARCH_ROLE_LABELS,
  researchRoleOfTool,
} from "@openbot/shared/research";

/**
 * A tool call, named the way the person watching would name it.
 *
 * The model is offered `mcp__notes__search_notes`, because a tool name has to be unique across every
 * server a Bot holds and has to survive two vendors both calling something `search`. None of that is
 * the reader's problem, and putting it on screen tells them how the thing is built rather than what
 * their Bot just did.
 *
 * Anything that is not a prefixed MCP name is left exactly as it is: a component the app registered
 * already has a name somebody chose.
 */
export type ToolName = {
  /** What was done, for the line itself. */
  label: string;
  /** Which server it was done against, muted beside the label. Absent for anything not MCP. */
  detail?: string;
};

/**
 * How a step stands, for the words it is named in: still running ("Searching your email"), done
 * ("Searched your email"), or neither (`"plain"`: "Search your email"), for a step that was refused
 * or failed, so the line never says something happened that did not.
 */
export type ToolState = boolean | "plain";

export function readToolName(
  name: string,
  running: ToolState = false,
): ToolName {
  const own = ownToolLabel(name, running === true);
  if (own) return { label: running === "plain" ? humanise(name) : own };
  const parts = name.split("__");
  // Not an MCP name and not one of this deployment's: still never the bare identifier.
  if (parts.length < 3 || parts[0] !== "mcp") return { label: humanise(name) };

  const [, rawServer, ...rest] = parts;
  const server = rawServer ?? "";
  const tool = rest.join("__");
  /*
   * The person's own mail and calendar, named for what happened to them. The server key
   * (`google-workspace`) is how this deployment reaches Google and means nothing to the reader, so
   * these lines carry no detail beside them.
   */
  const personal = PERSONAL_TOOLS[tool];
  if (personal)
    return {
      label:
        running === "plain"
          ? personal.plain
          : running
            ? personal.running
            : personal.done,
    };
  const broker = brokeredApp(server);
  /*
   * Research is named for what it did, not for who did it. `web_search_exa` would read "Web search
   * exa", which tells the person which vendor this deployment buys search from and nothing about
   * their answer. Which provider is granted is an administrator's fact, on the Bot's access page.
   */
  const role = researchRoleOfTool(server, tool);
  if (role)
    return {
      label:
        running === true
          ? role === "search"
            ? STEP_PHRASES.searchWeb
            : STEP_PHRASES.readWeb
          : RESEARCH_ROLE_LABELS[role],
    };
  const label = humanise(tool);

  /*
   * The server is dropped when the action already names it as the thing acted upon. Vendors name a
   * tool after the thing it acts on, so `mcp__notes__search_notes` would otherwise read "Search
   * notes notes" and `mcp__routines__create_routine` "Create routine routines", both of which look
   * like a bug rather than a label. A server key can itself be more than one word — `google-drive`,
   * `google_drive` — so it is split into words the same way `humanise` splits the tool name, each
   * singularised, and looked for as a contiguous run inside the label's words. Whole words in an
   * unbroken sequence, never a substring test: that is what let "Create routine routines" through in
   * the first place.
   *
   * `humanise` always puts the verb first, and that leading word is excluded from the search:
   * `mcp__posts__post_message` singularises its server to "post", which is also the tool's own verb,
   * so without this exclusion "Post message" would lose its "posts" attribution over a coincidence
   * with the verb rather than a naming of the server. Same shape for `mcp__lists__list_files`
   * against "List". Only the words after the verb describe what the action was taken on, so only
   * those are eligible to match the server.
   *
   * This does not, and cannot, catch every collision: `mcp__news__get_new_items` singularises "news"
   * to "new", which genuinely is the second word of "Get new items", so the server is still dropped
   * there. English plural heuristics cannot tell that "new" apart from the "new" in "news" — that is
   * a known limit of this rule, not a bug to chase with a word list.
   */
  const labelWords = label.toLowerCase().split(" ").map(singular);
  /*
   * A BROKERED APP IS SEARCHED FOR IN THE WHOLE LABEL, VERB INCLUDED. The verb exclusion above
   * exists for a server whose name collides with a verb by accident, and a broker's apps cannot
   * produce that collision: Composio publishes `<APP>_<VERB>_<NOUN>`, so the app always leads and
   * is never the verb. Excluding the first word here would put "googlecalendar" beside a label
   * that opens with the word.
   */
  const wordsActedOn = broker ? labelWords : labelWords.slice(1);
  const serverWords = wordsOf(broker ?? server).map(singular);
  const named = containsPhrase(wordsActedOn, serverWords);
  return named ? { label } : { label, detail: broker ?? server };
}

/**
 * The tools every Bot holds that this deployment wrote itself, named in words somebody chose.
 *
 * These are not MCP names, so nothing above rewrites them, and the bare identifier is what a line
 * would otherwise say: "show_app_access", shimmering, while the Bot works out what an app is for the
 * person. Named twice, for the moment and for afterwards, because only these lines are drawn while
 * running AND left on screen once done.
 *
 * The morning brief draws a card of its own, but the pill under the header's orb names it while it
 * runs, and its own line reads the words from here so the two cannot drift apart.
 */
const OWN_TOOLS: Record<string, { running: string; done: string }> = {
  [SHOW_APP_ACCESS_TOOL]: {
    running: "Checking your apps",
    done: "Checked your apps",
  },
  morning_brief: {
    running: "Reading your mail and calendar",
    done: "Read your mail and calendar",
  },
  // server/src/openduet/tasks.ts. Drawn as a plain line, so without these it read "add_tasks".
  add_tasks: {
    running: "Adding to your Tasks",
    done: "Added to your Tasks",
  },
  make_page: {
    running: "Putting it together",
    done: "Put it together",
  },
  // server/src/openduet/offers.ts. Drawn as the task's card once done; this is the moment before.
  offer_task: {
    running: "Adding a task",
    done: "Added a task",
  },
  // server/src/openduet/tasks.ts. Drawn as the started task's card once done.
  start_task: {
    running: "Starting a task",
    done: "Started a task",
  },
  // server/src/memory. Drawn as plain lines, so without these they read "recall_personal_memory".
  recall_personal_memory: {
    running: "Checking memory",
    done: "Checked memory",
  },
  remember_personal_fact: {
    running: "Saving to memory",
    done: "Saved to memory",
  },
};

/**
 * The person's own mail and calendar (server/src/plugins/google-workspace-rest.ts), in words about
 * them. Same shape as `OWN_TOOLS`: the running form is a phrase from the pill's vocabulary below, so
 * a line and the pill say the same thing at the same moment.
 */
const PERSONAL_TOOLS: Record<
  string,
  { running: string; done: string; plain: string; waiting?: string }
> = {
  gmail_search_messages: {
    running: "Searching your email",
    done: "Searched your email",
    plain: "Search your email",
  },
  gmail_read_message: {
    running: "Reading your email",
    done: "Read your email",
    plain: "Read your email",
  },
  calendar_list_events: {
    running: "Checking your calendar",
    done: "Checked your calendar",
    plain: "Check your calendar",
  },
  // A send waits on the person's answer before it runs, and says so rather than "sent".
  gmail_send_reply: {
    running: "Sending your email",
    done: "Sent your email",
    plain: "Send your email",
    waiting: "Waiting for your OK to send your email",
  },
};

/**
 * What the pill under the header's orb may say (parity-spec, Chat 1): a plain phrase about the
 * person and their things, in the present, with no ellipsis. Never a tool's identifier, never a
 * server key, never a past tense while the step is still going.
 *
 * These are the spec's phrases. The deployment's own tools add theirs (`OWN_TOOLS`, running forms:
 * "Reading your mail and calendar", "Adding to your Tasks"), so the pill and the tool's own line say
 * the same thing at the same moment.
 */
export const STEP_PHRASES = {
  thinking: "Thinking it through",
  searchEmail: "Searching your email",
  readEmail: "Reading your email",
  calendar: "Checking your calendar",
  searchWeb: "Searching the web",
  readWeb: "Reading a web page",
  browser: "Working in your browser",
  sendEmail: "Sending your email",
  startTask: "Starting a task",
  memory: "Checking memory",
  working: "Working on it",
} as const;

/**
 * Tools the pill does not name, because they are not work the person is waiting on: the reply chips
 * under an answer, and an interface drawn for the person to read or fill in (`askForm`,
 * `showBarChart`). While one runs the pill says whatever the turn was doing before it.
 */
const UNNAMED_TOOLS = new Set(["suggest_replies", "ask_person"]);

/**
 * The pill's phrase for a running tool call, or null for one it does not name.
 *
 * Read from what the tool does to the person's things, not from its name: the mail and calendar the
 * person connected, the web, their browser, their memory. Anything not recognised is "Working on it",
 * never its identifier humanised, since "Calendar list events" is still an identifier.
 */
export function stepPhrase(name: string): string | null {
  if (UNNAMED_TOOLS.has(name)) return null;
  // A gallery interface: `askForm`, `askChoice`, `showBarChart`, `showTable`.
  if (/^(ask|show)[A-Z]/.test(name)) return null;
  const own = ownToolLabel(name, true);
  if (own) return own;
  if (name.startsWith("computer_")) return STEP_PHRASES.browser;

  const parts = name.split("__");
  const isMcp = parts.length >= 3 && parts[0] === "mcp";
  const server = isMcp ? (parts[1] ?? "") : "";
  const tool = isMcp ? parts.slice(2).join("__") : name;
  const role = isMcp ? researchRoleOfTool(server, tool) : null;
  if (role === "search") return STEP_PHRASES.searchWeb;
  if (role === "fetch") return STEP_PHRASES.readWeb;

  const words = new Set(wordsOf(`${server} ${tool}`));
  const has = (...any: string[]) => any.some((word) => words.has(word));
  if (has("memory", "memories", "remember", "recall"))
    return STEP_PHRASES.memory;
  if (has("calendar", "event", "events")) return STEP_PHRASES.calendar;
  if (has("gmail", "mail", "email", "emails", "inbox")) {
    if (has("send", "reply", "forward", "draft")) return STEP_PHRASES.sendEmail;
    if (has("search", "list", "fetch", "find", "query"))
      return STEP_PHRASES.searchEmail;
    return STEP_PHRASES.readEmail;
  }
  if (has("search") && has("web")) return STEP_PHRASES.searchWeb;
  return STEP_PHRASES.working;
}

/**
 * A step named for what happened to the person's own things: their mail and calendar, or one of this
 * deployment's tools. Null for anything else, which a summary counts rather than names.
 */
export function personToolLabel(
  name: string,
  state: "running" | "done" | "waiting" = "done",
): string | null {
  const own = OWN_TOOLS[name];
  if (own) return state === "waiting" ? null : own[state];
  const parts = name.split("__");
  if (parts.length < 3 || parts[0] !== "mcp") return null;
  const personal = PERSONAL_TOOLS[parts.slice(2).join("__")];
  if (!personal) return null;
  return state === "waiting" ? (personal.waiting ?? null) : personal[state];
}

/** One of this deployment's own tools in words, or null for any other name. */
export function ownToolLabel(name: string, running = false): string | null {
  const own = OWN_TOOLS[name];
  if (!own) return null;
  return running ? own.running : own.done;
}

/**
 * The app behind a brokered server key, or null for a server this deployment dials itself.
 *
 * A brokered server is keyed `<broker>-<app>` — `composio-gmail` — because the broker is how the
 * credential is held and two brokers could both offer Gmail. Neither of those is the reader's
 * business: they asked their Bot about their email, not about which company holds the grant. This
 * is the same argument the research relabelling above makes, and the answer is the same — which
 * broker a deployment buys through is an administrator's fact, on the Bot's access page.
 *
 * Only the prefix is removed, never the app. "Gmail" is what was acted upon and stays legible.
 */
function brokeredApp(server: string): string | null {
  const prefix = "composio-";
  if (!server.startsWith(prefix)) return null;
  const app = server.slice(prefix.length);
  return app.length > 0 ? app : null;
}

/**
 * `routines` and `routine` are the same word for this purpose.
 *
 * A vendor names the server for the collection and the tool for the one item —
 * `mcp__routines__create_routine` — so the exact-substring test that stops "Search notes notes" lets
 * "Create routine routines" straight through, and it reads as a typo rather than as a label.
 *
 * Dropping one trailing `s` from each side before comparing is the whole of the difference between
 * those two cases. This is not a stemmer and must not grow into one: the only thing it has to catch
 * is one vendor writing the same noun twice, once plural and once not.
 */
function singular(word: string): string {
  return word.endsWith("s") ? word.slice(0, -1) : word;
}

/**
 * `search_notes` as "Search notes".
 *
 * Vendors write tool names in snake_case, camelCase or a mixture, and the only thing they agree on
 * is that the first word is a verb. Splitting on both and sentence-casing the result gets a phrase
 * that reads as an action without anybody maintaining a table of names.
 */
export function humanise(tool: string): string {
  const words = wordsOf(tool).join(" ");
  if (words.length === 0) return tool;
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * `google-drive`, `google_drive` and `googleDrive` all split to the same `["google", "drive"]`.
 *
 * The same splitting `humanise` does for a tool name, pulled out so a server key can be broken into
 * words too rather than compared as one opaque token.
 */
function wordsOf(text: string): string[] {
  return text
    .replace(/[_-]+/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .trim()
    .toLowerCase()
    .split(" ")
    .filter((word) => word.length > 0);
}

/**
 * Whether `needle` occurs in `haystack` as a run of whole words, in order and unbroken.
 *
 * This is the whole-word alternative to a substring test: `["routine"]` must line up with a word
 * in `["create", "routine"]`, not merely appear inside one of its letters.
 */
function containsPhrase(haystack: string[], needle: string[]): boolean {
  if (needle.length === 0) return false;
  for (let start = 0; start + needle.length <= haystack.length; start++) {
    if (needle.every((word, offset) => haystack[start + offset] === word))
      return true;
  }
  return false;
}
