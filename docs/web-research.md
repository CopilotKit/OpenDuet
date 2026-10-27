# Public-web research

OpenDuet can search the public web, read selected pages and make a brief with source links using the Parallel Search connector already included in OpenBot. It does not need the Bot's browser or a separate agent process.

The OpenDuet Bot holds the `research-public-web` skill. An administrator must still enable a research connector and grant its tools before the Bot can use it.

## Set up Parallel Search

1. As an administrator, open **Plugins** at `/admin/plugins` and select **Parallel Search** from the catalogue.
2. Turn on **Enable for this deployment**, then press **Refresh tools**. The connector uses `https://search.parallel.ai/mcp` and needs no API key for light use, subject to provider limits.
3. Press **Grant tools…**, select the **OpenDuet** Bot, and grant both `web_search` and `web_fetch`. These find public sources and read their contents.
4. In Chat, invoke `/research-public-web` with a request such as:

   > Compare three public project-management tools for a small team, check their current pricing, and make a brief with source links.

OpenDuet can run longer research as a task and put its brief on the Make tab. The skill asks it to search, read selected sources, cite URLs, and report missing evidence or provider errors.

For higher limits, use **Parallel Search (API key)** from the catalogue. Enter the deployment's Parallel API key in that connector's token field, refresh its tools, and grant both tools to OpenDuet. Remove the grants on the anonymous entry if they are no longer needed. The key stays in the server-side credential vault.

## Controls and data

The connector receives the research objective, search queries, requested public URLs and a conversation session identifier. The skill tells the Bot to send only what the research needs, not whole conversations or private documents.

Assigning the skill does not grant tool access. Calls use OpenBot's existing grant checks, action policies and audit records. Administrators can revoke access or connect another supported research provider. The skill declares the `@research/search` and `@research/fetch` roles, so it works with the provider whose tools the Bot holds.

If research tools are missing, check that the connector is enabled, its tools have been refreshed, and both tools are granted to **OpenDuet**. A provider error or limit should be reported in the answer rather than treated as evidence that no sources exist.

See [OpenBot's research guide](../openbot/docs/web-research.md) for other providers and [Parallel's Search MCP documentation](https://docs.parallel.ai/integrations/mcp/search-mcp) for service details.
