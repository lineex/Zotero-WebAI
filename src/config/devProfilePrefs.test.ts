import { describe, expect, it } from "vitest";

import { buildDevProfilePrefs } from "./devProfilePrefs";

describe("buildDevProfilePrefs", () => {
  it("maps MCP environment values into Zotero-WebAI plugin prefs", () => {
    expect(
      buildDevProfilePrefs({
        env: {
          DS_COPILOT_EVIDENCE_ENABLED: "1",
          DS_COPILOT_EVIDENCE_PROVIDER: "mcp-http",
          ZOTERO_WEBAI_MCP_AUTH_TOKEN: "token-dev",
          ZOTERO_WEBAI_MCP_ENDPOINT: "http://127.0.0.1:23120/mcp",
          ZOTERO_WEBAI_MCP_TOOL_ARGUMENTS_TEMPLATE:
            "{\"query\":\"{{query}}\"}",
          ZOTERO_WEBAI_MCP_TOOL_NAME: "web_search",
        },
        prefsPrefix: "extensions.zotero.zotero-ai-assistant",
      }),
    ).toEqual({
      "extensions.zotero.zotero-ai-assistant.evidenceEnabled": true,
      "extensions.zotero.zotero-ai-assistant.evidenceProviderMode":
        "mcp-http",
      "extensions.zotero.zotero-ai-assistant.mcpAuthToken": "token-dev",
      "extensions.zotero.zotero-ai-assistant.mcpEndpoint":
        "http://127.0.0.1:23120/mcp",
      "extensions.zotero.zotero-ai-assistant.mcpToolArgumentsTemplate":
        "{\"query\":\"{{query}}\"}",
      "extensions.zotero.zotero-ai-assistant.mcpToolName": "web_search",
    });
  });

  it("falls back to the new default provider when no evidence env is set", () => {
    expect(
      buildDevProfilePrefs({
        env: {},
        prefsPrefix: "extensions.zotero.zotero-ai-assistant",
      }),
    ).toEqual({});
  });
});
