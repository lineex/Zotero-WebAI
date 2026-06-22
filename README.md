# Zotero-WebAI

Zotero-WebAI is a Zotero 9 reading workspace that embeds DeepSeek Web and Z.ai Web beside the current Zotero library item or PDF reader. It provides Web login, skills, MCP tools, PDF/selection/image input, and Zotero note handoff.

No model key is required. Sign in inside the embedded DeepSeek Web or Z.ai Web page, copy the generated prompt into the web chat, then save useful answers back as Zotero child notes.

## Features

- Tab-bar button on the right side of Zotero's tab strip opens the Zotero-WebAI right sidebar.
- Reader and library right sidebar adapts to the current PDF, paper, selection, or collection.
- Embedded DeepSeek Web and Z.ai Web login with external-open fallback.
- Skill workflow for summary, explanation, methods, limitations, evidence, image analysis, notes, and custom prompts.
- PDF import into Zotero, selected-text prompt handoff, image prompt input, and note saving.
- MCP Streamable HTTP tool support for optional local or remote tool calls.
- No DeepSeek/Z.ai model API configuration.

## Usage

1. Install the generated `.xpi` in Zotero 9 from `Tools -> Add-ons -> Install Add-on From File...`.
2. Open a PDF or select a library item.
3. Click the small Zotero-WebAI button on the right side of the tab bar.
4. Sign in to DeepSeek Web or Z.ai Web in the sidebar.
5. Choose a skill and input mode, copy the generated prompt, and paste it into the embedded web chat.
6. Paste useful web-chat output into the note box and save it as a Zotero note.

## MCP

Open Zotero-WebAI settings and switch the evidence provider to `MCP HTTP tool`.

Default endpoint example:

```text
http://127.0.0.1:3000/mcp
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
