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
    expect(webWorkspaceSource).toContain(
      "输入消息，或输入 / 选择自定义 Skill",
    );
    expect(webWorkspaceSource).toContain("Open settings to add custom skills");
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
