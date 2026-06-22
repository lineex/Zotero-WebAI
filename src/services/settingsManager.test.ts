import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const prefState = new Map<string, unknown>();

const prefMocks = vi.hoisted(() => {
  const getPref = vi.fn((key: string) => prefState.get(key));
  const setPref = vi.fn((key: string, value: unknown) => {
    prefState.set(key, value);
  });

  return { getPref, setPref };
});

vi.mock("../utils/prefs", () => ({
  getPref: prefMocks.getPref,
  setPref: prefMocks.setPref,
}));

import {
  buildCustomCommandAIPrompt,
  getSettings,
  mergeEditableCustomPresets,
  parseEditableCustomPresets,
  saveSettings,
  stringifyEditableCustomPresets,
  validateEvidenceSettings,
} from "./settingsManager";

describe("settingsManager", () => {
  beforeEach(() => {
    prefState.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    vi.useFakeTimers();
    prefMocks.getPref.mockImplementation((key: string) => prefState.get(key));
    prefMocks.setPref.mockImplementation((key: string, value: unknown) => {
      prefState.set(key, value);
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("defaults to WebAI settings without API chat configuration", () => {
    expect(getSettings()).toMatchObject({
      customPresets: "",
      evidenceEnabled: false,
      evidenceProviderMode: "mcp-http",
      keyboardShortcut: "I",
      maxContextBudget: 4000,
      mcpAuthToken: "",
      mcpEndpoint: "http://127.0.0.1:23120/mcp",
      mcpToolArgumentsTemplate: '{"query":"{{query}}","max_results":5}',
      mcpToolName: "web_search",
    });
    expect(getSettings()).not.toHaveProperty("apiKey");
    expect(getSettings()).not.toHaveProperty("model");
    expect(getSettings()).not.toHaveProperty("baseURL");
  });

  it("normalizes the legacy builtin-search provider to the new default mode", () => {
    prefState.set("evidenceProviderMode", "builtin-search");

    expect(getSettings().evidenceProviderMode).toBe("mcp-http");
  });

  it("normalizes removed API-backed providers to the web-only default mode", () => {
    prefState.set("evidenceProviderMode", "removed-provider");

    expect(getSettings().evidenceProviderMode).toBe("mcp-http");
  });

  it("persists evidence provider settings and MCP details", () => {
    saveSettings({
      evidenceEnabled: true,
      evidenceProviderMode: "mcp-http",
      mcpAuthToken: "token",
      mcpEndpoint: "http://127.0.0.1:23120/mcp",
      mcpToolArgumentsTemplate: '{"query":"{{query}}","max_results":3}',
      mcpToolName: "web_search",
    });

    expect(getSettings()).toMatchObject({
      evidenceEnabled: true,
      evidenceProviderMode: "mcp-http",
      mcpAuthToken: "token",
      mcpEndpoint: "http://127.0.0.1:23120/mcp",
      mcpToolArgumentsTemplate: '{"query":"{{query}}","max_results":3}',
      mcpToolName: "web_search",
    });
  });

  it("validates MCP settings locally", async () => {
    await expect(
      validateEvidenceSettings({
        evidenceProviderMode: "mcp-http",
        mcpEndpoint: "http://127.0.0.1:23120/mcp",
        mcpToolArgumentsTemplate: '{"query":"{{query}}","max_results":5}',
        mcpToolName: "web_search",
      }),
    ).resolves.toEqual({ valid: true });
  });

  it("rejects invalid MCP argument templates", async () => {
    await expect(
      validateEvidenceSettings({
        evidenceProviderMode: "mcp-http",
        mcpEndpoint: "http://127.0.0.1:23120/mcp",
        mcpToolArgumentsTemplate: '{"query":',
        mcpToolName: "web_search",
      }),
    ).resolves.toMatchObject({
      valid: false,
      error: expect.stringContaining("Invalid MCP arguments template"),
    });
  });

  it("keeps hidden preset tombstones when serializing editable custom presets", () => {
    const serialized = stringifyEditableCustomPresets([
      {
        aliasesText: "",
        description: "Hide summarize",
        enabled: false,
        evidenceHint: false,
        group: "reading",
        hidden: true,
        id: "summarize",
        label: "Summarize",
        promptPrefix: "Please summarize this paper.",
        slashCommand: "summarize",
        showInSidebar: false,
        scopeHint: ["paper", "pdf"],
      },
    ]);

    expect(serialized).toContain('"id": "summarize"');
    expect(serialized).toContain('"hidden": true');
  });

  it("builds an AI command JSON prompt that does not end with sentence punctuation", () => {
    const prompt = buildCustomCommandAIPrompt();

    expect(prompt).toContain("JSON array");
    expect(prompt).toContain("promptPrefix");
    expect(prompt.endsWith(".")).toBe(false);
  });

  it("merges imported commands into existing commands by id", () => {
    const existing = parseEditableCustomPresets(
      JSON.stringify([
        {
          id: "future-work",
          label: "Future Work",
          promptPrefix: "Suggest next steps",
          aliases: ["future"],
        },
      ]),
    );
    const imported = parseEditableCustomPresets(
      JSON.stringify([
        {
          id: "future-work",
          label: "Future Work Updated",
          promptPrefix: "Suggest three concrete next studies",
        },
        {
          id: "replication-risk",
          label: "Replication Risk",
          promptPrefix: "Assess replication risks",
        },
      ]),
    );

    const merged = mergeEditableCustomPresets(existing, imported);

    expect(merged.map((preset) => preset.id)).toEqual([
      "future-work",
      "replication-risk",
    ]);
    expect(merged[0]).toMatchObject({
      label: "Future Work Updated",
    });
  });

  it("normalizes a visible slash command separate from the stable id", () => {
    const parsed = parseEditableCustomPresets(
      JSON.stringify([
        {
          id: "future-work",
          slashCommand: "future",
          label: "Future Work",
          promptPrefix: "Summarize the follow-up questions worth pursuing",
        },
      ]),
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: "future-work",
      slashCommand: "future",
    });
  });

  it("migrates legacy editable records that do not have slashCommand", () => {
    const parsed = parseEditableCustomPresets(
      JSON.stringify([
        {
          id: "legacy-summary",
          label: "Legacy Summary",
          promptPrefix: "Legacy prompt",
        },
      ]),
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]).toMatchObject({
      id: "legacy-summary",
      slashCommand: "legacy-summary",
    });
  });

  it("treats the default MCP verification mode as locally valid", async () => {
    await expect(validateEvidenceSettings()).resolves.toEqual({ valid: true });
  });
});
