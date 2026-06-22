# Zotero WebAI

[English README](README.md)

Zotero WebAI 是一个面向 Zotero 9 的阅读侧边栏插件，可以在当前文献、PDF 阅读器旁边内嵌 DeepSeek Web 和 Z.ai Web。插件不需要模型 API Key，用户直接在内嵌网页中登录，并通过 Zotero 侧边栏把文献上下文、自定义 Skill 和 MCP 工具真实结果送入网页对话。

## 功能

- 在 Zotero 标签页栏右侧显示 Zotero WebAI 小按钮，点击后打开右侧自适应侧边栏。
- 支持文献库和 PDF 阅读器上下文，自动带入当前条目、PDF 正文、选中文本、导入 PDF 或集合信息。
- 内嵌 DeepSeek Web 与 Z.ai Web 登录页面，并保留外部浏览器打开入口。
- 设置页支持新增自定义 Skill，在对话框输入 `/` 即可选择。
- 最多可以添加 1000 个自定义 Skill。
- 真实 MCP 联动 `zotero-mcp`：插件读取 `tools/list`，让网页模型决定工具名和参数，再由插件本地执行 `tools/call`，并把真实返回结果插回网页对话。
- Results 面板显示 MCP 输出、Skill 提示与结果、网页回答捕获内容和 MCP 原始 payload。
- 不包含 DeepSeek/Z.ai API 配置。

## 使用

1. 从 GitHub Releases 下载 `.xpi`。
2. 在 Zotero 9 中打开 `Tools -> Add-ons -> Install Add-on From File...` 安装。
3. 如需 MCP 工具，请先在本机启动 `zotero-mcp`。
4. 打开 PDF 或选择一条文献。
5. 点击标签页栏右侧的 Zotero WebAI 按钮。
6. 在侧边栏中登录 DeepSeek Web 或 Z.ai Web。
7. 在设置中新增自定义 Skill，在对话框输入 `/` 调出并使用。
8. 发送问题后，插件会尝试自动提交网页对话、捕获网页回答，并在 Results 面板记录 MCP 与 Skill 的真实结果。

## MCP

Zotero WebAI 默认适配 `zotero-mcp` 的本地 Streamable HTTP 服务。

启用 MCP 后，插件会把 `tools/list` 返回的工具名称、说明和 input schema 自动嵌入到发给 DeepSeek Web 或 Z.ai Web 的提示词中。网页模型自行判断是否需要调用 MCP 工具，并决定工具名和参数；插件检测到模型输出的 MCP 请求块后，会调用本地 MCP 服务器的 `tools/call`，把规范化结果和原始结果显示在 Results 面板，并把结果插回网页对话，让模型继续回答。

默认初始上下文会使用只读的 `search_library`，参数限制为 `limit: 1000`。同时，`tools/list` 返回的所有工具仍可由网页模型按需选择。

默认 MCP 配置：

```json
{
  "mcpServers": {
    "zotero-mcp": {
      "type": "streamableHttp",
      "url": "http://127.0.0.1:23120/mcp",
      "headers": {
        "Content-Type": "application/json"
      }
    }
  }
}
```

默认工具参数模板：

```json
{"q":"{{query}}","limit":1000,"mode":"preview"}
```

## 构建

```bash
npm install
npm run build
```

生成的 XPI 位于 `.scaffold/build/`。

构建产物不会提交到源码仓库，发布版 `.xpi` 单独放在 GitHub Releases。
