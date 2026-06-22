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
            "{\"q\":\"{{query}}\",\"limit\":1000,\"mode\":\"preview\"}",
          ZOTERO_WEBAI_MCP_TOOL_NAME: "search_library",
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
        "{\"q\":\"{{query}}\",\"limit\":1000,\"mode\":\"preview\"}",
      "extensions.zotero.zotero-ai-assistant.mcpToolName": "search_library",
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
