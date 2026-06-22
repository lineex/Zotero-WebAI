import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addCustomSlashCard,
  commitSlashCardEdit,
  createSlashSettingsState,
  registerPreferencesPane,
  restoreBuiltInSlashCard,
  serializeSlashSettingsState,
  validateSlashCardDraft,
  type PreferencesPaneDeps,
} from "./preferencesPane";
import { EventBus } from "../utils/eventBus";
import { getSidebarPresetsForScope } from "../services/presets";

class FakeEventTarget {
  listeners = new Map<string, Set<(...args: any[]) => void>>();

  addEventListener(type: string, listener: (...args: any[]) => void) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (...args: any[]) => void) {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: Record<string, unknown> = {}) {
    this.listeners.get(type)?.forEach((listener) =>
      listener({
        preventDefault: vi.fn(),
        type,
        ...event,
      }),
    );
  }

  getListenerCount(type: string) {
    return this.listeners.get(type)?.size ?? 0;
  }
}

class FakeField extends FakeEventTarget {
  attributes: Record<string, string> = {};
  children: FakeField[] = [];
  disabled = false;
  style = { display: "" };
  textContent = "";
  value = "";

  appendChild(child: FakeField) {
    this.children.push(child);
    return child;
  }

  getAttribute(name: string) {
    return this.attributes[name] ?? null;
  }

  querySelector(selector: string) {
    return (this.querySelectorAll(selector)[0] as Element | undefined) ?? null;
  }

  querySelectorAll(selector: string) {
    const results: FakeField[] = [];
    const attrMatch = selector.match(/^\[([^=\]]+)(?:="([^"]*)")?\]$/);
    const walk = (node: FakeField) => {
      if (attrMatch) {
        const [, attr, expected] = attrMatch;
        const actual = node.getAttribute(attr);
        if (actual !== null && (expected === undefined || actual === expected)) {
          results.push(node);
        }
      }
      node.children.forEach(walk);
    };
    this.children.forEach(walk);
    return results as unknown as NodeListOf<Element>;
  }

  removeAttribute(name: string) {
    if (name === "disabled") {
      this.disabled = false;
    }
    delete this.attributes[name];
  }

  replaceChildren(...nodes: FakeField[]) {
    this.children = [...nodes];
  }

  setAttribute(name: string, value: string) {
    if (name === "disabled") {
      this.disabled = true;
    }
    this.attributes[name] = value;
  }
}

class FakeButton extends FakeField {}

class FakeLink extends FakeField {
  href = "";
}

class FakeStatusElement {
  dataset: Record<string, string> = {};
  textContent = "";
}

class FakeRootElement {
  dataset: Record<string, string> = {};
}

class FakeContainer {
  children: FakeField[] = [];
  textContent = "";

  appendChild(child: FakeField) {
    this.children.push(child);
    return child;
  }

  querySelector(selector: string) {
    return (this.querySelectorAll(selector)[0] as Element | undefined) ?? null;
  }

  querySelectorAll(selector: string) {
    const root = new FakeField();
    root.children = this.children;
    return root.querySelectorAll(selector);
  }

  replaceChildren(...nodes: FakeField[]) {
    this.children = [...nodes];
  }
}

class FakeDocument {
  l10n = {
    formatValue: vi.fn(async (id: string) => `l10n:${id}`),
  };

  constructor(private readonly elements: Record<string, unknown>) {}

  createElementNS(_namespace: string, tag: string) {
    const field = new FakeField();
    field.setAttribute("data-tag", tag);
    return field as unknown as HTMLElement;
  }

  getElementById(id: string) {
    return (this.elements[id] as HTMLElement | null) ?? null;
  }
}

class FakeWindow {
  constructor(public document: FakeDocument) {}
}

describe("slash settings state", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  it("treats every saved slash card as a custom skill", () => {
    const state = createSlashSettingsState(
      JSON.stringify([
        {
          id: "summarize",
          label: "Summary Lite",
          promptPrefix: "Focus on experiments and results.",
          slashCommand: "summary-lite",
        },
        {
          id: "future-work",
          label: "Future Work",
          promptPrefix: "Suggest next studies.",
          slashCommand: "future",
        },
      ]),
    );

    expect(state.builtins).toHaveLength(0);
    expect(state.custom).toHaveLength(2);
    expect(state.custom.map((card) => card.id)).toEqual([
      "summarize",
      "future-work",
    ]);
  });

  it("serializes only custom skill cards", () => {
    const editedState = {
      builtins: [
        {
          id: "summarize",
          kind: "builtin" as const,
          promptPrefix: "Focus on experiments and results.",
          slashCommand: "Summary Lite",
          title: "Summary Lite",
        },
      ],
      custom: [
        {
          id: "future-work",
          isNew: false,
          kind: "custom" as const,
          promptPrefix: "Suggest next studies.",
          slashCommand: "Future Work",
          title: "Future Work",
        },
      ],
    };

    const serialized = serializeSlashSettingsState(editedState);

    expect(serialized).not.toContain('"id": "summarize"');
    expect(serialized).toContain('"id": "future-work"');
    expect(serialized).not.toContain('"id": "explain"');
  });

  it("adds custom cards until the configured cap", () => {
    let state = createSlashSettingsState("");
    for (let index = 0; index < 12; index += 1) {
      state = addCustomSlashCard(state);
    }

    expect(state.custom).toHaveLength(10);
  });

  it("validates duplicate titles across custom cards", () => {
    const state = createSlashSettingsState(
      JSON.stringify([
        {
          id: "future-work",
          label: "Future Work",
          promptPrefix: "Suggest next studies.",
        },
      ]),
    );
    const duplicate = validateSlashCardDraft(state, {
      id: "next-studies",
      kind: "custom",
      promptPrefix: "Suggest next studies.",
      slashCommand: "Future Work",
      title: "Future Work",
    });

    expect(duplicate).toBe("This title is already in use");
  });

  it("discards a blank new custom card when the user blurs away", () => {
    const state = addCustomSlashCard(createSlashSettingsState(""));
    const blankId = state.custom[0]?.id;
    if (!blankId) {
      throw new Error("Expected a blank custom card");
    }

    const result = commitSlashCardEdit(
      state,
      { id: blankId, kind: "custom" },
      {
        promptPrefix: "",
        slashCommand: "",
        title: "",
      },
    );

    expect(result.saved).toBe(false);
    expect(result.state.custom).toHaveLength(0);
  });

  it("keeps built-in restore as a no-op in custom-only settings", () => {
    const state = createSlashSettingsState(
      JSON.stringify([
        {
          id: "summarize",
          label: "Summary Lite",
          promptPrefix: "Focus on experiments and results.",
          slashCommand: "summary-lite",
        },
      ]),
    );

    const restored = restoreBuiltInSlashCard(state, "summarize");

    expect(restored).toBe(state);
    expect(restored.custom[0]).toMatchObject({
      id: "summarize",
      title: "Summary Lite",
    });
  });

  it("keeps sidebar recommendations limited to built-in commands", () => {
    let state = addCustomSlashCard(createSlashSettingsState(""));
    const cardId = state.custom[0]?.id;
    if (!cardId) {
      throw new Error("Expected a custom card");
    }

    const committed = commitSlashCardEdit(
      state,
      { id: cardId, kind: "custom" },
      {
        promptPrefix: "Suggest three concrete next studies.",
        slashCommand: "future-work",
        title: "Future Work",
      },
    );

    const serialized = serializeSlashSettingsState(committed.state);
    expect(getSidebarPresetsForScope("paper", serialized).map((preset) => preset.id)).toEqual([
      "summarize",
      "explain",
      "core-contribution",
      "method",
      "limitations",
      "verify-claim",
      "background",
      "related-work",
    ]);
  });
});

describe("registerPreferencesPane", () => {
  let deps: PreferencesPaneDeps;
  let evidenceProviderField: FakeField;
  let evidenceStatus: FakeStatusElement;
  let evidenceValidateButton: FakeButton;
  let exportDebugLogButton: FakeButton;
  let mcpAuthTokenField: FakeField;
  let mcpEndpointField: FakeField;
  let mcpSettingsRow: FakeField;
  let saveButton: FakeButton;
  let slashAddButton: FakeButton;
  let slashCustom: FakeContainer;
  let slashLimitStatus: FakeStatusElement;
  let status: FakeStatusElement;

  beforeEach(() => {
    EventBus.dispose();
    vi.stubGlobal("Zotero", {
      Prefs: {
        get: vi.fn(() => ""),
      },
    });
    evidenceProviderField = new FakeField();
    evidenceStatus = new FakeStatusElement();
    evidenceValidateButton = new FakeButton();
    exportDebugLogButton = new FakeButton();
    mcpAuthTokenField = new FakeField();
    mcpEndpointField = new FakeField();
    mcpSettingsRow = new FakeField();
    saveButton = new FakeButton();
    slashAddButton = new FakeButton();
    slashCustom = new FakeContainer();
    slashLimitStatus = new FakeStatusElement();
    status = new FakeStatusElement();

    deps = {
      exportDebugLog: vi.fn(async () => "/tmp/zotero-webai-debug.jsonl"),
      getSettings: vi.fn(() => ({
        customPresets: "",
        evidenceEnabled: false,
        evidenceProviderMode: "mcp-http" as const,
        keyboardShortcut: "I",
        maxContextBudget: 8192,
        mcpAuthToken: "",
        mcpEndpoint: "http://127.0.0.1:23120/mcp",
        mcpToolArgumentsTemplate: "{\"q\":\"{{query}}\",\"limit\":1000,\"mode\":\"preview\"}",
        mcpToolName: "search_library",
      })),
      saveSettings: vi.fn(),
      validateEvidenceSettings: vi.fn(async () => ({ valid: true })),
    };
  });

  function createWindow() {
    const document = new FakeDocument({
      "zotero-ai-assistant-prefs": new FakeRootElement(),
      "zotero-ai-assistant-pref-custom-presets": new FakeField(),
      "zotero-ai-assistant-pref-evidence-provider": evidenceProviderField,
      "zotero-ai-assistant-pref-evidence-status": evidenceStatus,
      "zotero-ai-assistant-pref-evidence-validate": evidenceValidateButton,
      "zotero-ai-assistant-pref-export-debug-log": exportDebugLogButton,
      "zotero-ai-assistant-pref-mcp-auth-token": mcpAuthTokenField,
      "zotero-ai-assistant-pref-mcp-endpoint": mcpEndpointField,
      "zotero-ai-assistant-pref-mcp-settings": mcpSettingsRow,
      "zotero-ai-assistant-pref-save": saveButton,
      "zotero-ai-assistant-pref-slash-add": slashAddButton,
      "zotero-ai-assistant-pref-slash-custom": slashCustom,
      "zotero-ai-assistant-pref-slash-limit-status": slashLimitStatus,
      "zotero-ai-assistant-pref-status": status,
    });

    return new FakeWindow(
      document as unknown as FakeDocument,
    ) as unknown as Window;
  }

  it("hydrates slash storage and evidence provider values on load", () => {
    registerPreferencesPane(createWindow(), deps);

    expect(deps.getSettings).toHaveBeenCalledTimes(1);
    expect(evidenceProviderField.value).toBe("mcp-http");
    expect(mcpEndpointField.value).toBe("http://127.0.0.1:23120/mcp");
    expect(slashCustom.querySelectorAll('[data-slash-card="true"]')).toHaveLength(
      0,
    );
  });

  it("binds listeners only once when the pane is reopened", () => {
    const win = createWindow();
    registerPreferencesPane(win, deps);
    registerPreferencesPane(win, deps);

    expect(saveButton.getListenerCount("command")).toBe(1);
    expect(exportDebugLogButton.getListenerCount("command")).toBe(1);
    expect(evidenceProviderField.getListenerCount("change")).toBe(1);
    expect(evidenceProviderField.getListenerCount("command")).toBe(1);
    expect(evidenceValidateButton.getListenerCount("command")).toBe(1);
  });

  it("shows slash limit help and keeps add enabled while under the cap", () => {
    registerPreferencesPane(createWindow(), deps);

    expect(slashLimitStatus.textContent).toBe(
      "You can add up to 10 custom skills",
    );
    expect(slashAddButton.disabled).toBe(false);
  });

  it("adds only one custom slash card when Zotero fires command then click", async () => {
    registerPreferencesPane(createWindow(), deps);

    slashAddButton.dispatch("command");
    slashAddButton.dispatch("click");
    await Promise.resolve();
    await Promise.resolve();

    expect(slashCustom.querySelectorAll('[data-slash-card="true"]').length).toBe(1);
  });

  it("hides MCP settings while the built-in web verification provider is selected", async () => {
    registerPreferencesPane(createWindow(), deps);

    evidenceProviderField.value = "mcp-web-search";
    evidenceProviderField.dispatch("command");
    await Promise.resolve();
    await Promise.resolve();

    expect(mcpSettingsRow.style.display).toBe("none");
    expect(deps.saveSettings).toHaveBeenLastCalledWith({
      customPresets: "",
      evidenceProviderMode: "mcp-web-search",
      mcpAuthToken: "",
      mcpEndpoint: "http://127.0.0.1:23120/mcp",
      mcpToolArgumentsTemplate: "{\"q\":\"{{query}}\",\"limit\":1000,\"mode\":\"preview\"}",
      mcpToolName: "search_library",
    });
  });

  it("shows and saves MCP settings when the MCP provider is selected", async () => {
    registerPreferencesPane(createWindow(), deps);

    evidenceProviderField.value = "mcp-http";
    mcpEndpointField.value = "http://127.0.0.1:23120/mcp";
    mcpAuthTokenField.value = "token-next";
    evidenceProviderField.dispatch("command");
    await Promise.resolve();
    await Promise.resolve();

    expect(mcpSettingsRow.style.display).toBe("");
    expect(deps.saveSettings).toHaveBeenLastCalledWith({
      customPresets: "",
      evidenceProviderMode: "mcp-http",
      mcpAuthToken: "token-next",
      mcpEndpoint: "http://127.0.0.1:23120/mcp",
      mcpToolArgumentsTemplate: "{\"q\":\"{{query}}\",\"limit\":1000,\"mode\":\"preview\"}",
      mcpToolName: "search_library",
    });
  });

  it("validates MCP settings with unsaved values", async () => {
    registerPreferencesPane(createWindow(), deps);

    evidenceProviderField.value = "mcp-http";
    mcpEndpointField.value = "http://127.0.0.1:23120/mcp";
    mcpAuthTokenField.value = "token-next";
    evidenceValidateButton.dispatch("command");
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.validateEvidenceSettings).toHaveBeenCalledWith({
      customPresets: "",
      evidenceProviderMode: "mcp-http",
      mcpAuthToken: "token-next",
      mcpEndpoint: "http://127.0.0.1:23120/mcp",
      mcpToolArgumentsTemplate: "{\"q\":\"{{query}}\",\"limit\":1000,\"mode\":\"preview\"}",
      mcpToolName: "search_library",
    });
    expect(evidenceStatus.textContent).toBe(
      "Evidence provider settings look good",
    );
  });

  it("exports the structured debug log from the preferences pane", async () => {
    vi.stubGlobal("PathUtils", { tempDir: "/tmp" });
    registerPreferencesPane(createWindow(), deps);

    exportDebugLogButton.dispatch("command");
    await Promise.resolve();
    await Promise.resolve();

    expect(deps.exportDebugLog).toHaveBeenCalledWith(
      expect.stringMatching(/zotero-webai-debug-\d+\.jsonl$/),
    );
    expect(status.dataset.variant).toBe("success");
    expect(status.textContent).toContain("Debug log exported to");
  });
});
