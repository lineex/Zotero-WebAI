interface BuildDevProfilePrefsOptions {
  env?: Record<string, string | undefined>;
  prefsPrefix: string;
}

const DEFAULT_EVIDENCE_PROVIDER_MODE = "mcp-web-search";

function normalizeBooleanPref(
  value: string | undefined,
): boolean | undefined {
  if (value == null || value === "") {
    return undefined;
  }

  return value === "1" || value.toLowerCase() === "true";
}

function normalizeEvidenceProviderPref(
  value: string | undefined,
): typeof DEFAULT_EVIDENCE_PROVIDER_MODE | "mcp-http" | undefined {
  if (!value) {
    return undefined;
  }

  return value === "mcp-http" ? "mcp-http" : DEFAULT_EVIDENCE_PROVIDER_MODE;
}

export function buildDevProfilePrefs({
  env = ((globalThis as unknown as {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env ?? {}) as Record<string, string | undefined>,
  prefsPrefix,
}: BuildDevProfilePrefsOptions): Record<string, string | boolean> {
  const prefs: Record<string, string | boolean> = {};

  const setPref = (key: string, value: string | boolean | undefined) => {
    if (value === undefined || value === "") {
      return;
    }
    prefs[`${prefsPrefix}.${key}`] = value;
  };

  setPref(
    "evidenceEnabled",
    normalizeBooleanPref(env.DS_COPILOT_EVIDENCE_ENABLED),
  );
  setPref(
    "evidenceProviderMode",
    normalizeEvidenceProviderPref(env.DS_COPILOT_EVIDENCE_PROVIDER),
  );
  setPref("mcpEndpoint", env.ZOTERO_WEBAI_MCP_ENDPOINT || env.MCP_ENDPOINT);
  setPref("mcpToolName", env.ZOTERO_WEBAI_MCP_TOOL_NAME || env.MCP_TOOL_NAME);
  setPref(
    "mcpToolArgumentsTemplate",
    env.ZOTERO_WEBAI_MCP_TOOL_ARGUMENTS_TEMPLATE ||
      env.MCP_TOOL_ARGUMENTS_TEMPLATE,
  );
  setPref(
    "mcpAuthToken",
    env.ZOTERO_WEBAI_MCP_AUTH_TOKEN || env.MCP_AUTH_TOKEN,
  );

  return prefs;
}
