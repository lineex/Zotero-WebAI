import enPreferences from "../../addon/locale/en-US/preferences.ftl?raw";
import zhPreferences from "../../addon/locale/zh-CN/preferences.ftl?raw";

import { describe, expect, it } from "vitest";

describe("preferences locale copy", () => {
  it("describes embedded web login without model API keys", () => {
    expect(enPreferences).toContain(
      "Zotero-WebAI uses embedded DeepSeek Web and Z.ai Web login",
    );
    expect(zhPreferences).toContain(
      "内嵌 DeepSeek Web 和 Z.ai Web 登录，不需要模型密钥",
    );
  });

  it("labels skills and prompts independently", () => {
    expect(enPreferences).toContain(
      "ai-assistant-pref-commands-title = Skills and Prompts",
    );
    expect(zhPreferences).toContain(
      "ai-assistant-pref-commands-title = Skill 与提示词",
    );
  });

  it("adds dedicated slash skill section labels", () => {
    expect(enPreferences).toContain(
      "ai-assistant-pref-slash-title = Slash Skills",
    );
    expect(zhPreferences).toContain(
      "ai-assistant-pref-slash-title = Slash Skill",
    );
    expect(enPreferences).not.toContain(
      "ai-assistant-pref-slash-builtins-title",
    );
    expect(zhPreferences).not.toContain(
      "ai-assistant-pref-slash-builtins-title",
    );
    expect(enPreferences).toContain(
      "ai-assistant-pref-slash-custom-title = My skills",
    );
    expect(zhPreferences).toContain(
      "ai-assistant-pref-slash-custom-title = 我的 skill",
    );
    expect(enPreferences).not.toContain(
      "ai-assistant-pref-custom-presets-import = Import from JSON",
    );
    expect(zhPreferences).not.toContain(
      "ai-assistant-pref-custom-presets-import",
    );
  });

  it("labels custom slash add and limit copy", () => {
    expect(enPreferences).toContain("ai-assistant-pref-slash-add = Add skill");
    expect(zhPreferences).toContain("ai-assistant-pref-slash-add = 新增 skill");
    expect(enPreferences).toContain(
      "ai-assistant-pref-slash-limit = You can add up to 10 custom skills",
    );
    expect(zhPreferences).toContain(
      "ai-assistant-pref-slash-limit = 最多只能添加 10 个自定义 skill",
    );
  });

  it("describes slash settings as title-and-prompt editing only", () => {
    expect(enPreferences).toContain(
      "ai-assistant-pref-slash-help = Create custom skills by setting a title and prompt text. The chat box shows them when you type /.",
    );
    expect(zhPreferences).toContain(
      "ai-assistant-pref-slash-help = 只创建自定义 skill：填写标题和提示词后，在对话框输入 / 即可选择。",
    );
  });

  it("makes evidence providers explicit without third-party API-key paths", () => {
    expect(enPreferences).toContain(
      "ai-assistant-pref-evidence-provider-builtin = Default academic verification (no key)",
    );
    expect(zhPreferences).toContain(
      "ai-assistant-pref-evidence-provider-builtin = 默认学术查证（无需密钥）",
    );
    expect(enPreferences).toContain(
      "ai-assistant-pref-evidence-provider-mcp = MCP HTTP tool",
    );
    expect(zhPreferences).toContain(
      "ai-assistant-pref-evidence-provider-mcp = MCP HTTP 工具",
    );
    const removedProvider = ["ta", "vily"].join("");
    expect(enPreferences).not.toContain(removedProvider);
    expect(zhPreferences).not.toContain(capitalize(removedProvider));
  });

  it("explains provider-specific settings", () => {
    expect(enPreferences).toContain(
      "ai-assistant-pref-evidence-provider-help = MCP HTTP is the default path for local Zotero tooling. Use the academic verification fallback only when you do not run an MCP server.",
    );
    expect(zhPreferences).toContain(
      "ai-assistant-pref-evidence-provider-help = MCP HTTP 是默认本地工具路径。只有不运行 MCP 服务时，才切换到默认学术查证回退。",
    );
    expect(enPreferences).toContain(
      "ai-assistant-pref-mcp-settings-title = MCP HTTP tool setup",
    );
    expect(zhPreferences).toContain(
      "ai-assistant-pref-mcp-settings-title = MCP HTTP 工具配置",
    );
  });

  it("labels the debug log export action", () => {
    expect(enPreferences).toContain(
      "ai-assistant-pref-export-debug-log = Export Debug Log",
    );
    expect(zhPreferences).toContain(
      "ai-assistant-pref-export-debug-log = 导出调试日志",
    );
  });
});

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}
