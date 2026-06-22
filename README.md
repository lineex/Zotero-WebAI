# Zotero-WebAI

Zotero-WebAI is a Zotero 9 reading workspace that embeds DeepSeek Web and Z.ai Web beside the current Zotero library item or PDF reader. It provides Web login, custom slash skills, and default MCP HTTP tooling.

No model key is required. Sign in inside the embedded DeepSeek Web or Z.ai Web page, type your message in the Zotero-WebAI chat box, and use `/` to apply your custom skills.

## Features

- Tab-bar button on the right side of Zotero's tab strip opens the Zotero-WebAI right sidebar.
- Reader and library right sidebar adapts to the current PDF, paper, selection, or collection.
- Embedded DeepSeek Web and Z.ai Web login with external-open fallback.
- Custom Skill manager in settings.
- Slash menu in the chat box: type `/` to choose a custom Skill and send/copy a Zotero-context prompt.
- MCP Streamable HTTP defaults to `http://127.0.0.1:23120/mcp`.
- No DeepSeek/Z.ai model API configuration.

## Usage

1. Install the generated `.xpi` in Zotero 9 from `Tools -> Add-ons -> Install Add-on From File...`.
2. Open a PDF or select a library item.
3. Click the small Zotero-WebAI button on the right side of the tab bar.
4. Sign in to DeepSeek Web or Z.ai Web in the sidebar.
5. Open Zotero-WebAI settings and add custom Skills.
6. Type `/` in the Zotero-WebAI chat box to choose a Skill, then send/copy the generated prompt into the embedded web chat.

## MCP

Zotero-WebAI defaults to the local streamable HTTP MCP endpoint used by `zotero-mcp`.

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
{"query":"{{query}}","max_results":5}
```

## Build

```bash
npm install
npm test
npm run build
npm run verify:xpi
```

The XPI is emitted under `.scaffold/build/`.
