import preferencesSource from "../../addon/content/preferences.xhtml?raw";

import { describe, expect, it } from "vitest";

describe("preferences.xhtml", () => {
  it("stays a Zotero preference fragment instead of a full XML document", () => {
    const source = preferencesSource.trimStart();

    expect(source.startsWith("<?xml")).toBe(false);
    expect(source.startsWith("<vbox")).toBe(true);
  });

  it("does not expose model credential or model settings", () => {
    const legacyCredentialId = [
      "zotero-ai-assistant-pref",
      "api",
      "key",
    ].join("-");

    expect(preferencesSource).not.toContain(legacyCredentialId);
    expect(preferencesSource).not.toContain(
      "zotero-ai-assistant-pref-validate",
    );
    expect(preferencesSource).not.toContain(["DeepSeek", "API"].join(" "));
  });

  it("keeps model tuning internal while exposing hidden structured slash storage", () => {
    expect(preferencesSource).not.toContain("zotero-ai-assistant-pref-model");
    expect(preferencesSource).not.toContain(
      "zotero-ai-assistant-pref-max-context",
    );
    expect(preferencesSource).toContain(
      'id="zotero-ai-assistant-pref-custom-presets"',
    );
  });

  it("places Commands and Prompts after web verification settings", () => {
    const evidenceIndex = preferencesSource.indexOf(
      'data-l10n-id="ai-assistant-pref-evidence-description"',
    );
    const commandsIndex = preferencesSource.indexOf(
      'data-l10n-id="ai-assistant-pref-commands-title"',
    );

    expect(evidenceIndex).toBeGreaterThanOrEqual(0);
    expect(commandsIndex).toBeGreaterThan(evidenceIndex);
  });

  it("renders a dedicated slash section without JSON command controls", () => {
    expect(preferencesSource).toContain(
      'data-l10n-id="ai-assistant-pref-slash-title"',
    );
    expect(preferencesSource).toContain(
      'id="zotero-ai-assistant-pref-slash-builtins"',
    );
    expect(preferencesSource).toContain(
      'id="zotero-ai-assistant-pref-slash-custom"',
    );
    expect(preferencesSource).toContain(
      'id="zotero-ai-assistant-pref-slash-add"',
    );
    expect(preferencesSource).not.toContain(
      'id="zotero-ai-assistant-pref-custom-presets-import"',
    );
    expect(preferencesSource).not.toContain(
      'id="zotero-ai-assistant-pref-custom-presets-copy-ai-prompt"',
    );
    expect(preferencesSource).not.toContain(
      'id="zotero-ai-assistant-pref-custom-presets-docs-link"',
    );
  });

  it("loads the live pane through the configured Zotero addon instance", () => {
    expect(preferencesSource).toContain(
      "Zotero.ZoteroWebAI.hooks.onPrefsEvent",
    );
    expect(preferencesSource).not.toContain("Zotero.__addonInstance__");
  });

  it("keeps raw slash storage hidden instead of exposing a JSON editor", () => {
    const storageId = 'id="zotero-ai-assistant-pref-custom-presets"';
    const storageIdIndex = preferencesSource.indexOf(storageId);
    const storageStart = preferencesSource.lastIndexOf(
      "<html:textarea",
      storageIdIndex,
    );
    const storageEnd = preferencesSource.indexOf(
      "</html:textarea>",
      storageIdIndex,
    );
    const storageEditor = preferencesSource.slice(storageStart, storageEnd);

    expect(storageEditor).toContain("display: none");
    expect(preferencesSource).not.toContain(
      'id="zotero-ai-assistant-pref-custom-presets-import-editor"',
    );
  });

  it("uses an explicit select control for choosing the evidence provider", () => {
    expect(preferencesSource).toMatch(
      /<html:select[\s\S]*id="zotero-ai-assistant-pref-evidence-provider"/,
    );
    expect(preferencesSource).toContain('value="mcp-web-search"');
    expect(preferencesSource).toContain('value="mcp-http"');
    expect(preferencesSource).not.toContain(
      `value="${["ta", "vily"].join("")}"`,
    );
    expect(preferencesSource).not.toContain("<radiogroup");
  });

  it("keeps the preferences panel free of third-party API signup links", () => {
    const removedProvider = ["ta", "vily"].join("");

    expect(preferencesSource).not.toContain("platform.deepseek.com");
    expect(preferencesSource).not.toContain(`app.${removedProvider}.com`);
    expect(preferencesSource).not.toContain(
      `zotero-ai-assistant-pref-${removedProvider}`,
    );
  });

  it("renders MCP HTTP as its own settings panel", () => {
    expect(preferencesSource).toContain(
      'id="zotero-ai-assistant-pref-mcp-settings"',
    );
    expect(preferencesSource).toContain(
      'id="zotero-ai-assistant-pref-mcp-endpoint"',
    );
    expect(preferencesSource).toContain(
      'id="zotero-ai-assistant-pref-mcp-tool-name"',
    );
    expect(preferencesSource).toContain(
      'id="zotero-ai-assistant-pref-mcp-tool-arguments-template"',
    );
    expect(preferencesSource).toContain(
      'id="zotero-ai-assistant-pref-mcp-auth-token"',
    );
    expect(preferencesSource).toContain(
      'id="zotero-ai-assistant-pref-evidence-validate"',
    );
    expect(preferencesSource).toContain(
      'id="zotero-ai-assistant-pref-evidence-status"',
    );
  });

  it("includes a debug log export action for user issue reports", () => {
    expect(preferencesSource).toContain(
      'id="zotero-ai-assistant-pref-export-debug-log"',
    );
    expect(preferencesSource).toContain(
      'data-l10n-id="ai-assistant-pref-export-debug-log"',
    );
  });
});
