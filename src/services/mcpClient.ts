import type { Settings } from "./settingsManager";

export interface MCPToolSummary {
  description?: string;
  name: string;
}

export interface MCPToolResultItem {
  content?: string;
  source?: string;
  title?: string;
  url?: string;
  year?: string;
}

interface MCPClientConfig {
  authToken?: string;
  endpoint: string;
  timeoutMs?: number;
}

interface MCPRequestContext {
  endpoint: string;
  headers: Record<string, string>;
  nextId: number;
  sessionId?: string;
  timeoutMs: number;
}

type MCPJsonRpcResponse = {
  error?: {
    code?: number;
    message?: string;
  };
  id?: number | string;
  result?: unknown;
};

export async function listMCPTools(
  settings: Pick<Settings, "mcpAuthToken" | "mcpEndpoint">,
): Promise<MCPToolSummary[]> {
  const context = await initializeMCP({
    authToken: settings.mcpAuthToken,
    endpoint: settings.mcpEndpoint || "",
  });
  const result = await sendMCPRequest(context, "tools/list", {});
  return normalizeToolList(result);
}

export async function callMCPTool(
  settings: Pick<
    Settings,
    | "mcpAuthToken"
    | "mcpEndpoint"
    | "mcpToolArgumentsTemplate"
    | "mcpToolName"
  >,
  query: string,
): Promise<MCPToolResultItem[]> {
  const toolName = settings.mcpToolName?.trim();
  if (!toolName) {
    throw new Error("MCP tool name is required");
  }

  const context = await initializeMCP({
    authToken: settings.mcpAuthToken,
    endpoint: settings.mcpEndpoint || "",
  });
  const result = await sendMCPRequest(context, "tools/call", {
    name: toolName,
    arguments: buildToolArguments(
      settings.mcpToolArgumentsTemplate || "",
      query,
    ),
  });
  return normalizeToolResult(result, toolName);
}

function buildToolArguments(template: string, query: string): unknown {
  const source = template.trim() || '{"query":"{{query}}","max_results":5}';
  return JSON.parse(
    source.replace(/\{\{\s*query\s*\}\}/g, () => JSON.stringify(query).slice(1, -1)),
  );
}

async function initializeMCP(config: MCPClientConfig): Promise<MCPRequestContext> {
  const endpoint = config.endpoint.trim();
  if (!endpoint) {
    throw new Error("MCP endpoint is required");
  }

  const context: MCPRequestContext = {
    endpoint,
    headers: buildMCPHeaders(config.authToken),
    nextId: 1,
    timeoutMs: config.timeoutMs || 10000,
  };
  await sendMCPRequest(context, "initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: {
      name: "Zotero-WebAI",
      version: "0.9.7",
    },
  });
  await sendMCPNotification(context, "notifications/initialized");
  return context;
}

function buildMCPHeaders(authToken?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json, text/event-stream",
    "Content-Type": "application/json",
  };
  if (authToken?.trim()) {
    headers.Authorization = `Bearer ${authToken.trim()}`;
  }
  return headers;
}

async function sendMCPNotification(
  context: MCPRequestContext,
  method: string,
): Promise<void> {
  await postMCPPayload(context, {
    jsonrpc: "2.0",
    method,
  });
}

async function sendMCPRequest(
  context: MCPRequestContext,
  method: string,
  params: unknown,
): Promise<unknown> {
  const response = await postMCPPayload(context, {
    jsonrpc: "2.0",
    id: context.nextId++,
    method,
    params,
  });
  if (response.error) {
    throw new Error(
      response.error.message || `MCP error ${response.error.code || ""}`.trim(),
    );
  }
  return response.result;
}

async function postMCPPayload(
  context: MCPRequestContext,
  payload: Record<string, unknown>,
): Promise<MCPJsonRpcResponse> {
  const headers = { ...context.headers };
  if (context.sessionId) {
    headers["Mcp-Session-Id"] = context.sessionId;
  }

  const response = await fetchWithTimeout(
    context.endpoint,
    {
      body: JSON.stringify(payload),
      headers,
      method: "POST",
    },
    context.timeoutMs,
  );
  const sessionId = response.headers?.get?.("Mcp-Session-Id");
  if (sessionId) {
    context.sessionId = sessionId;
  }
  if (!response.ok) {
    throw new Error(`MCP HTTP ${response.status}: ${await response.text()}`);
  }

  const contentType = response.headers?.get?.("content-type") || "";
  const text = await response.text();
  return contentType.includes("text/event-stream")
    ? parseSSEResponse(text)
    : parseJsonResponse(text);
}

function parseJsonResponse(text: string): MCPJsonRpcResponse {
  if (!text.trim()) {
    return {};
  }
  return JSON.parse(text) as MCPJsonRpcResponse;
}

function parseSSEResponse(text: string): MCPJsonRpcResponse {
  const events = text
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .split("\n\n")
    .map((event) =>
      event
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).trimStart())
        .join("\n")
        .trim(),
    )
    .filter(Boolean);
  if (events.length === 0) {
    return {};
  }
  return JSON.parse(events[events.length - 1]) as MCPJsonRpcResponse;
}

function normalizeToolList(result: unknown): MCPToolSummary[] {
  const tools = (result as { tools?: unknown[] } | null)?.tools;
  if (!Array.isArray(tools)) {
    return [];
  }
  return tools
    .map((tool) => {
      const record = tool as Record<string, unknown>;
      return {
        description: String(record.description || ""),
        name: String(record.name || ""),
      };
    })
    .filter((tool) => tool.name);
}

function normalizeToolResult(
  result: unknown,
  toolName: string,
): MCPToolResultItem[] {
  const record = (result || {}) as Record<string, unknown>;
  const structured = record.structuredContent;
  const structuredItems = normalizeStructuredItems(structured);
  if (structuredItems.length > 0) {
    return structuredItems;
  }

  const text = extractContentText(record.content);
  const parsedTextItems = parseTextItems(text);
  if (parsedTextItems.length > 0) {
    return parsedTextItems;
  }

  return text
    ? [
        {
          content: text,
          source: toolName,
          title: "MCP tool result",
        },
      ]
    : [];
}

function normalizeStructuredItems(value: unknown): MCPToolResultItem[] {
  if (!value || typeof value !== "object") {
    return [];
  }
  const record = value as Record<string, unknown>;
  const candidates = Array.isArray(value)
    ? value
    : Array.isArray(record.results)
      ? record.results
      : Array.isArray(record.items)
        ? record.items
        : [];
  return candidates
    .map(normalizeResultRecord)
    .filter((item): item is MCPToolResultItem => item !== null);
}

function parseTextItems(text: string): MCPToolResultItem[] {
  if (!text.trim()) {
    return [];
  }
  try {
    return normalizeStructuredItems(JSON.parse(text));
  } catch {
    return [];
  }
}

function normalizeResultRecord(value: unknown): MCPToolResultItem | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const record = value as Record<string, unknown>;
  return {
    content: String(record.content || record.snippet || record.text || ""),
    source: String(record.source || record.provider || "MCP"),
    title: String(record.title || record.name || "MCP result"),
    url: String(record.url || record.link || ""),
    year: String(record.year || record.date || ""),
  };
}

function extractContentText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .map((part) => {
      const record = part as Record<string, unknown>;
      return typeof record.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n\n");
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const AbortControllerCtor = (globalThis as any).AbortController;
  const controller =
    typeof AbortControllerCtor === "function"
      ? new AbortControllerCtor()
      : null;
  const timeoutHost = resolveTimeoutHost();
  let timeoutId: unknown = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = timeoutHost.setTimeout(() => {
      controller?.abort?.();
      reject(new Error(`Timed out after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([
      fetch(input, {
        ...init,
        signal: controller?.signal,
      }),
      timeoutPromise,
    ]);
  } finally {
    if (timeoutId != null) {
      timeoutHost.clearTimeout(timeoutId);
    }
  }
}

function resolveTimeoutHost(): {
  clearTimeout: (timerId: unknown) => void;
  setTimeout: (callback: () => void, timeoutMs: number) => unknown;
} {
  const globalSetTimeout = (globalThis as any).setTimeout;
  const globalClearTimeout = (globalThis as any).clearTimeout;
  if (typeof globalSetTimeout === "function" && typeof globalClearTimeout === "function") {
    return {
      clearTimeout: (timerId) => globalClearTimeout(timerId),
      setTimeout: (callback, timeoutMs) => globalSetTimeout(callback, timeoutMs),
    };
  }

  const win = Zotero.getMainWindow?.() as
    | {
        clearTimeout?: (timerId: unknown) => void;
        setTimeout?: (callback: () => void, timeoutMs: number) => unknown;
      }
    | undefined;

  return {
    clearTimeout: (timerId) => win?.clearTimeout?.(timerId),
    setTimeout: (callback, timeoutMs) => {
      if (typeof win?.setTimeout === "function") {
        return win.setTimeout(callback, timeoutMs);
      }
      callback();
      return timeoutMs;
    },
  };
}
