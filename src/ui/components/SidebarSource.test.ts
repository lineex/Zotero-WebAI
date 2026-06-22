import sidebarSource from "./Sidebar.tsx?raw";
import webWorkspaceSource from "./WebAIWorkspace.tsx?raw";

import { describe, expect, it } from "vitest";

describe("Sidebar WebAI workspace", () => {
  it("renders a branded Zotero-WebAI header and mounts WebAIWorkspace", () => {
    expect(sidebarSource).toContain("headerBrand");
    expect(sidebarSource).toContain("headerBrandIcon");
    expect(sidebarSource).toContain("deepseek-favicon.png");
    expect(sidebarSource).toContain("WebAIWorkspace");
    expect(sidebarSource).toContain("webWorkspacePane");
  });

  it("routes reader selection actions into an incoming web prompt", () => {
    expect(sidebarSource).toContain("readerSelectionAction");
    expect(sidebarSource).toContain("setIncomingPrompt");
    expect(sidebarSource).toContain("Selection explain");
    expect(sidebarSource).toContain("Selection ask");
    expect(sidebarSource).toContain("sourceMode: \"selection\"");
    expect(sidebarSource).toContain("sidebar.readerAction.webPrompt");
    expect(sidebarSource).toContain("sidebar.readerAction.error");
  });

  it("keeps the old API chat thread UI out of the sidebar", () => {
    expect(sidebarSource).not.toContain("ThreadView");
    expect(sidebarSource).not.toContain("Composer");
    expect(sidebarSource).not.toContain("model.suggestedActions");
    expect(sidebarSource).not.toContain("listThreadsForScope");
    expect(sidebarSource).not.toContain("findMostRecentThreadForScope");
  });
});

describe("WebAIWorkspace source", () => {
  it("offers embedded DeepSeek Web and Z.ai Web services", () => {
    expect(webWorkspaceSource).toContain("https://chat.deepseek.com/");
    expect(webWorkspaceSource).toContain("https://chat.z.ai/");
    expect(webWorkspaceSource).toContain("DeepSeek Web");
    expect(webWorkspaceSource).toContain("Z.ai Web");
    expect(webWorkspaceSource).toContain("createWebFrame");
    expect(webWorkspaceSource).toContain("Open External");
  });

  it("supports custom slash skills in the WebAI composer", () => {
    expect(webWorkspaceSource).toContain("parseCustomPresets");
    expect(webWorkspaceSource).toContain("buildCustomSkills");
    expect(webWorkspaceSource).toContain("getSlashQuery");
    expect(webWorkspaceSource).toContain("filterSlashSkills");
    expect(webWorkspaceSource).toContain("resolveSkillFromMessage");
    expect(webWorkspaceSource).toContain("insertPromptIntoWebChat");
    expect(webWorkspaceSource).toContain("findWebChatComposer");
    expect(webWorkspaceSource).toContain(
      "输入消息，或输入 / 选择自定义 Skill",
    );
    expect(webWorkspaceSource).toContain("Open settings to add custom skills");
  });

  it("integrates generated prompts into the web chat instead of showing a copied-prompt panel", () => {
    expect(webWorkspaceSource).toContain("Prompt inserted into");
    expect(webWorkspaceSource).toContain("with clipboard fallback");
    expect(webWorkspaceSource).not.toContain("Hide copied prompt");
    expect(webWorkspaceSource).not.toContain("Show copied prompt");
    expect(webWorkspaceSource).not.toContain("copiedPrompt");
    expect(webWorkspaceSource).not.toContain("generatedPrompt");
  });

  it("adds default MCP context into the generated web-chat prompt", () => {
    expect(webWorkspaceSource).toContain("listMCPTools");
    expect(webWorkspaceSource).toContain("callMCPToolByName");
    expect(webWorkspaceSource).toContain("callMCPToolWithFallback");
    expect(webWorkspaceSource).toContain("fetchMCPContextForConversation");
    expect(webWorkspaceSource).toContain("shouldUseMCPInConversation");
    expect(webWorkspaceSource).toContain("buildMCPConversationQuery");
    expect(webWorkspaceSource).toContain("formatMCPPromptContext");
    expect(webWorkspaceSource).toContain("ZOTERO_WEBAI_MCP_REQUEST");
    expect(webWorkspaceSource).toContain("Available Zotero MCP tools");
    expect(webWorkspaceSource).toContain("MCP context:");
    expect(webWorkspaceSource).toContain("MCP unavailable; using Zotero context only.");
    expect(webWorkspaceSource).toContain("mcp-http");
    expect(webWorkspaceSource).not.toContain("\"/mcp\"");
    expect(webWorkspaceSource).not.toContain("'/mcp'");
  });

  it("keeps removed PDF/image/MCP/note controls out of the composer", () => {
    expect(webWorkspaceSource).not.toContain("Copy PDF Prompt");
    expect(webWorkspaceSource).not.toContain("Copy Selection");
    expect(webWorkspaceSource).not.toContain("Copy Imported PDF");
    expect(webWorkspaceSource).not.toContain("Copy Image Prompt");
    expect(webWorkspaceSource).not.toContain("handleImportPDF");
    expect(webWorkspaceSource).not.toContain("handleImageInput");
    expect(webWorkspaceSource).not.toContain("handleMCPFetch");
    expect(webWorkspaceSource).not.toContain("saveDraftNote");
    expect(webWorkspaceSource).not.toContain("FilePickerHelper");
  });

  it("keeps model API configuration out of the web workspace", () => {
    expect(webWorkspaceSource).not.toContain(["api", "Key"].join(""));
    expect(webWorkspaceSource).not.toContain("baseURL");
    expect(webWorkspaceSource).not.toContain("openAICompatibleProvider");
  });
});
