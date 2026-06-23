pref("extensions.zotero.zotero-webai.customPresets", "");
pref("extensions.zotero.zotero-webai.maxContextBudget", 4000);
pref("extensions.zotero.zotero-webai.sidebarVisible", true);
pref("extensions.zotero.zotero-webai.evidenceEnabled", false);
pref(
  "extensions.zotero.zotero-webai.evidenceProviderMode",
  "mcp-http",
);
pref("extensions.zotero.zotero-webai.mcpEndpoint", "http://127.0.0.1:23120/mcp");
pref("extensions.zotero.zotero-webai.mcpToolName", "search_library");
pref(
  "extensions.zotero.zotero-webai.mcpToolArgumentsTemplate",
  "{\"q\":\"{{query}}\",\"limit\":1000,\"mode\":\"complete\",\"relevanceScoring\":true,\"sort\":\"relevance\"}",
);
pref("extensions.zotero.zotero-webai.mcpAuthToken", "");
