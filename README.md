# Zotero WebAI

Chinese README: [README.zh-CN.md](README.zh-CN.md).

Zotero WebAI is a Zotero 9 reading workspace that embeds DeepSeek Web and Z.ai Web beside the current Zotero library item or PDF reader. It requires no model API key: sign in inside the embedded web page and use the Zotero-side chat box to send Zotero context, custom skills, and MCP-backed tool results into the web chat.

## Features

- A small button on the right side of Zotero's tab bar opens an adaptive right sidebar.
- Works in the library and PDF reader, using the current item, PDF text, selected passage, imported PDF, or collection context.
- Embedded DeepSeek Web and Z.ai Web login with an external-browser fallback.
- Custom Skills in settings; type `/` in the chat box to select a Skill.
- Up to 1000 custom Skills.
- Real MCP bridge for `zotero-mcp`: Zotero WebAI reads `tools/list`, lets the web model decide tool names and arguments, executes `tools/call` locally, then inserts the real result back into the web chat.
- Results panel for MCP outputs, Skill prompts/results, captured web answers, and raw MCP payloads.
- No DeepSeek/Z.ai API configuration.

## Usage

1. Install the generated `.xpi` in Zotero 9 from `Tools -> Add-ons -> Install Add-on From File...`.
2. Start `zotero-mcp` locally if you want MCP tools available.
3. Open a PDF or select a library item.
4. Click the Zotero WebAI button on the right side of the tab bar.
5. Sign in to DeepSeek Web or Z.ai Web in the sidebar.
6. Add custom Skills in settings, then type `/` in the Zotero WebAI chat box to select one.
7. Send a prompt. Zotero WebAI inserts the prompt, tries to submit it, captures the web answer, and records MCP/Skill results in the Results panel.

## MCP

Zotero WebAI defaults to the local Streamable HTTP endpoint used by `zotero-mcp`.

When MCP is enabled, Zotero WebAI embeds the full `tools/list` catalog, including each tool schema, into the prompt inserted into DeepSeek Web or Z.ai Web. The web model decides whether a Zotero MCP tool is needed and chooses the tool name and schema-valid arguments. Zotero WebAI detects the emitted MCP request block, calls the local MCP server with `tools/call`, shows the normalized and raw result in the Results panel, and inserts the result back into the web chat so the model can continue answering.

A read-only initial prefetch uses `search_library` with `limit: 1000` as the default context helper. Every tool returned by `tools/list` remains available for model-selected MCP calls.

Default MCP server setting:

```json
{
  "mcpServers": {
    "zotero-mcp": {
      "type": "streamableHttp",
      "url": "http://127.0.0.1:23120/mcp",
      "headers": {
        "Content-Type": "application/json"
      }
    }
  }
}
```

Default tool argument template:

```json
{"q":"{{query}}","limit":1000,"mode":"preview"}
```

## Build

```bash
npm install
npm run build
```

The XPI is emitted under `.scaffold/build/`.

Build outputs are intentionally not tracked in this repository. Download packaged `.xpi` files from GitHub Releases.
