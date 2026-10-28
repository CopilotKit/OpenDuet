# Public-web research

OpenBot ships three public-web research providers in the plugin catalogue: **Parallel**, **Exa** and **Firecrawl**. Each one gives a Bot a search tool, which finds sources for a query, and a fetch tool, which reads pages by URL. A Bot holding both tools from one provider is told how to research with them. None of this uses the Bot's browser, and no existing Bot gets new access automatically.

| Catalogue entry           | Search tool        | Fetch tool         | Credential                                           |
| ------------------------- | ------------------ | ------------------ | ---------------------------------------------------- |
| Parallel Search           | `web_search`       | `web_fetch`        | None; provider-managed limits for light use          |
| Parallel Search (API key) | `web_search`       | `web_fetch`        | Deployment API key, sent as a Bearer token           |
| Exa Search                | `web_search_exa`   | `web_fetch_exa`    | None; free, rate-limited                             |
| Exa Search (API key)      | `web_search_exa`   | `web_fetch_exa`    | Deployment API key, sent in Exa's `x-api-key` header |
| Firecrawl                 | `firecrawl_search` | `firecrawl_scrape` | None; free access offers search, scrape and parse    |
| Firecrawl (API key)       | `firecrawl_search` | `firecrawl_scrape` | Deployment API key, sent as a Bearer token           |

## Enable research

1. As an administrator, open **Plugins** at `/admin/plugins`, choose a provider from the table above, and turn on **Enable for this deployment**. For the keyed entries, enter the provider's API key in **Access token**; it is stored in the server-side credential vault.
2. Press **Refresh tools**, then **Grant tools…** to grant that provider's search and fetch tools to the Bots that should research the public web. A separate research Bot without mail or private-document tools is the safer starting point. The shipped fintech package calls this Bot **Research Desk**. Read [Controls and data](#controls-and-data) before combining research and private-account tools on one Bot.
3. Ask the Bot to research a topic. It searches, reads selected sources and cites their URLs. Run `/research-public-web` to select the example skill explicitly if your deployment has many tools.

For production or higher limits, use a keyed entry and remove the grants on the free one. If a Bot holds a vendor's free and keyed entries, it is told about the keyed one.

### OpenDuet

The OpenDuet Bot holds the `research-public-web` skill. It still needs an administrator to enable a research connector and grant its tools. OpenDuet also reads mail and calendar data when those tools are granted, so review the controls below before giving its primary Bot public-web access. A separate research Bot can hold the same skill and only public-web tools.

For example, select **Parallel Search** in Plugins, enable it, refresh its tools, and grant `web_search` and `web_fetch` to the chosen research Bot. It needs no API key for light use, subject to provider limits. **Parallel Search (API key)** uses a deployment key entered under **Access token**. Exa and Firecrawl use the same setup flow with the tool names in the table.

Ask OpenDuet:

> /research-public-web Compare three public project-management tools for a small team, check their current pricing, and make a brief with source links.

Longer research runs as a task. The Bot is instructed to put clickable source URLs beside the claims in the saved page on the Make tab, while keeping the Chat reply short. The Chat word limit and rule against source notes do not apply to the page's content. If tools are missing, check that the connector is enabled, its tools are refreshed, and both tools are granted to the Bot doing the work.

## Skills declare roles, not providers

A skill names the research tools it needs as `@research/search` and `@research/fetch`, instead of one provider's tool names. Each role matches that role's tool on every research provider in the catalogue, intersected as always with what the Bot was granted. The shipped `research-public-web` skill does this, so it works with whichever provider a deployment connects. A role declaration grants nothing.

## Controls and data

In a conversation, research calls are labelled for what they did, "Search the web" and "Read web pages", whichever provider made them, and the Bot does not name the provider unless asked. Which provider a Bot holds is shown on its access page.

A Bot holding more than one provider is told about each and uses the one the person asks for. Administrators can revoke tools, remove a connector or grant another provider. Every call goes through `PluginStore.callTool`, with the usual grants, action policies and audit records; no raw MCP server is added to the agent configuration.

Each research provider names its reviewed read tools in `readTools` in the catalogue. Any other tool it advertises counts as a write until reviewed. This also applies to Parallel: only `web_search` and `web_fetch` count as reads.

The provider receives model-selected objectives, search queries, requested public URLs and, for Parallel, a conversation session identifier. Whole conversations are not sent automatically, but the model can copy private text into any of those fields. Failures stay visible and are not silently retried through another provider.

**A read tool can send data out.** Research reads do not pause for **Allow once**, and the shipped action policy allows calls unless an administrator adds restrictions. If the same Bot can read mail or private documents, a malicious instruction in that content could cause it to send private text in a search query or a fetched URL. Fetching an attacker-controlled URL can send text in its path or query to that site's operator through the provider. The instruction to treat outside content as information helps, but it is not an enforced data boundary.

For a safer setup, use a separate research Bot with only public-web tools, like the fintech package's **Research Desk**. Do not grant it mail, calendar or private-document tools, and do not pass private content to it in requests or handoffs.

An administrator can also add a deny rule under **Boundaries** (`/admin/boundaries`). For example, this policy refuses calls to all six research catalogue entries when a routine starts the run:

```json
{
  "mode": "enforce",
  "deny": [
    "initiator.kind == \"routine\" && mcp.server in [\"parallel\", \"parallel-authenticated\", \"exa\", \"exa-authenticated\", \"firecrawl\", \"firecrawl-authenticated\"]"
  ],
  "allow": ["true"]
}
```

Add the deny expression to your existing policy rather than replacing other restrictions. A saved policy takes precedence over `AGENT_COMPUTER_POLICY`; that variable supplies the initial policy when no saved policy exists. This example blocks scheduled research, including both search and fetch. It does not prevent disclosure in a person-started run or a handoff, and it does not restrict other outbound tools such as the browser. Isolation and grants still matter.

## Adding a provider

A provider is a catalogue entry in `server/src/plugins/catalogue.ts`, plus its two tools in `RESEARCH_TOOLS` in `shared/research.ts` (`{ search, fetch, notes? }`, keyed by the entry's key). The table is shared because the app labels these tools too. Add `readTools` to the entry when its write tools cannot be listed exhaustively. A vendor that reads its key from its own header names it in `auth: { kind: "deployment-bearer", header }`. The Bot guidance, the skill roles and the transcript labels pick the new entry up with no other change.

Provider documentation: [Parallel](https://docs.parallel.ai/integrations/mcp/search-mcp), [Exa](https://exa.ai/docs/reference/exa-mcp), [Firecrawl](https://docs.firecrawl.dev/mcp-server).
