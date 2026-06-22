# Zotero-WebAI

Zotero-WebAI is a Zotero 9 reading workspace that embeds DeepSeek Web and Z.ai Web beside the current Zotero library item or PDF reader. It provides Web login, custom slash skills, and default MCP HTTP tooling.

No model key is required. Sign in inside the embedded DeepSeek Web or Z.ai Web page, type your message in the Zotero-WebAI chat box, and use `/` to apply your custom skills.

## Features

- Tab-bar button on the right side of Zotero's tab strip opens the Zotero-WebAI right sidebar.
- Reader and library right sidebar adapts to the current PDF, paper, selection, or collection.
- Embedded DeepSeek Web and Z.ai Web login with external-open fallback.
- Custom Skill manager in settings.
- Slash menu in the chat box: type `/` to choose a custom Skill and insert a Zotero-context prompt into the embedded web chat.
- MCP Streamable HTTP defaults to `http://127.0.0.1:23120/mcp` and is automatically added to outgoing chat prompts when the local MCP server is available.
- No DeepSeek/Z.ai model API configuration.

## Usage

1. Install the generated `.xpi` in Zotero 9 from `Tools -> Add-ons -> Install Add-on From File...`.
2. Open a PDF or select a library item.
3. Click the small Zotero-WebAI button on the right side of the tab bar.
4. Sign in to DeepSeek Web or Z.ai Web in the sidebar.
5. Open Zotero-WebAI settings and add custom Skills.
6. Type `/` in the Zotero-WebAI chat box to choose a Skill, then send the generated prompt into the embedded web chat.

## MCP

Zotero-WebAI defaults to the local streamable HTTP MCP endpoint used by `zotero-mcp`.
When MCP is selected in settings, Zotero-WebAI embeds the full `tools/list` catalog, including each tool schema, into the prompt inserted into DeepSeek Web or Z.ai Web. The web model decides whether a Zotero MCP tool is needed and chooses the tool name and schema-valid arguments. Zotero-WebAI then executes the emitted MCP request block automatically and inserts the tool result back into the web chat. If the local MCP server is not running, the chat prompt still sends with Zotero context only.

The settings pane only asks for the endpoint and optional bearer token. A read-only initial prefetch uses `search_library` with `limit: 1000` as the default context helper, while every tool returned by `tools/list` remains available for model-selected MCP calls.

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
npm test
npm run build
npm run verify:xpi
```

The XPI is emitted under `.scaffold/build/`.
