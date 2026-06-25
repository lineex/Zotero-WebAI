# Zotero WebAI-Web AI Assistant Plugin for Zotero

[中文](README.zh-CN.md).

Zotero WebAI is a Zotero 9 reading workspace that embeds DeepSeek Web, Z.ai Web, and ChatGPT Web beside the current Zotero library item or PDF reader. It requires no model API key: sign in inside the embedded web page and use the Zotero-side chat box to send Zotero context, slash commands, custom skills, and real MCP tool results into the web chat.

## Features

- A small button on the right side of Zotero's tab bar opens an adaptive right sidebar.
- Works in the library and PDF reader, using the current item, selected passage, imported PDF, or collection context.
- Embedded DeepSeek Web, Z.ai Web, and ChatGPT Web login with an external-browser fallback.
- Coding-client style slash commands in the chat box.
- `/pdf` attaches the current PDF or Zotero item full text to the next prompt.
- `/websearch` runs the built-in web search and attaches readable results.
- `/zotero-mcp` loads the local `zotero-mcp` tool catalog, lets the web model choose tool names and arguments, executes real `tools/call` requests locally, then inserts the tool result back into the web chat.
- Custom Skills in settings; type `/` in the chat box to select a Skill.
- Up to 1000 custom Skills.
- Results panel for MCP outputs, Skill prompts/results, PDF-assisted answers, web-search answers, and captured web answers.
- No DeepSeek/Z.ai/ChatGPT API configuration.

## Usage

1. Install the generated `.xpi` in Zotero 9 from `Tools -> Add-ons -> Install Add-on From File...`.
2. Start `zotero-mcp` locally if you want `/zotero-mcp` tools available.
3. Open a PDF or select a library item.
4. Click the Zotero WebAI button on the right side of the tab bar.
5. Sign in to DeepSeek Web, Z.ai Web, or ChatGPT Web in the sidebar.
6. Type `/` in the Zotero WebAI chat box to choose `/pdf`, `/websearch`, `/zotero-mcp`, or a custom Skill.
7. Send a prompt. Zotero WebAI inserts the prompt, tries to submit it, captures the web answer, and records command results in the Results panel.

## Slash Commands

- `/pdf`: explicitly attaches the current PDF or item full text. Ordinary prompts do not dump the full paper text.
- `/websearch`: explicitly runs the built-in web search for the prompt. The toolbar Web Search toggle and search-like wording can still trigger web search as a convenience.
- `/zotero-mcp`: explicitly loads `tools/list` from the configured MCP endpoint. The web model may then emit a `ZOTERO_WEBAI_MCP_REQUEST` block; Zotero WebAI executes the requested `tools/call` locally and inserts the real result back into the same web chat.
- Custom Skills: add up to 1000 skills in settings and call them with `/`.

## MCP

Zotero WebAI defaults to the local Streamable HTTP endpoint used by `zotero-mcp`.

MCP is not injected into every ordinary prompt. Type `/zotero-mcp` when a conversation needs Zotero MCP tools. Zotero WebAI then embeds the `tools/list` catalog for that prompt, including each tool schema, so the web model can choose schema-valid tool names and arguments. Zotero WebAI detects the emitted MCP request block, calls the local MCP server with `tools/call`, shows the normalized result in the Results panel, and inserts the result back into the web chat so the model can continue answering.

Every tool returned by `tools/list` is available for model-selected MCP calls during a `/zotero-mcp` conversation.

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
{"q":"{{query}}","limit":1000,"mode":"complete","relevanceScoring":true,"sort":"relevance"}
```

## Support

Development takes time, attention, and tokens. If Zotero WebAI helps your reading workflow, you can buy me a coffee.

<img src="docs/reward-code.png" alt="Buy me a coffee reward code" width="260" />

## Build

```bash
npm install
npm run build
```

The XPI is emitted under `.scaffold/build/`.

Build outputs are intentionally not tracked in this repository. Download packaged `.xpi` files from GitHub Releases.
