import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildMCPToolArgumentsTemplate,
  callMCPToolByName,
  listMCPTools,
} from "./mcpClient";

const MCP_ENDPOINT = "http://127.0.0.1:23120/mcp";

function createJsonResponse(payload: unknown): Response {
  return {
    headers: {
      get: () => "application/json",
    },
    ok: true,
    status: 200,
    text: async () => JSON.stringify(payload),
  } as unknown as Response;
}

function readMCPPayload(init?: RequestInit): Record<string, unknown> {
  return JSON.parse(String(init?.body || "{}")) as Record<string, unknown>;
}

describe("mcpClient", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps every tools/list entry and preserves inputSchema", async () => {
    const searchSchema = {
      properties: {
        limit: { type: "integer" },
        mode: { type: "string" },
        q: { type: "string" },
      },
      type: "object",
    };
    const writeSchema = {
      properties: {
        itemKey: { type: "string" },
        note: { type: "string" },
      },
      type: "object",
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = readMCPPayload(init);
      if (payload.method === "tools/list") {
        return createJsonResponse({
          result: {
            tools: [
              {
                description: "Search Zotero library",
                inputSchema: searchSchema,
                name: "search_library",
              },
              {
                description: "Update a Zotero note",
                inputSchema: writeSchema,
                name: "update_note",
              },
            ],
          },
        });
      }
      return createJsonResponse({ result: {} });
    });
    vi.stubGlobal("fetch", fetchMock);

    const tools = await listMCPTools({ mcpEndpoint: MCP_ENDPOINT });

    expect(tools).toEqual([
      {
        description: "Search Zotero library",
        inputSchema: searchSchema,
        name: "search_library",
      },
      {
        description: "Update a Zotero note",
        inputSchema: writeSchema,
        name: "update_note",
      },
    ]);
  });

  it("builds the schema-aware fallback argument template with limit 1000", () => {
    expect(
      buildMCPToolArgumentsTemplate({
        inputSchema: {
          properties: {
            limit: { type: "integer" },
            mode: { type: "string" },
            q: { type: "string" },
          },
          type: "object",
        },
      }),
    ).toBe('{"q":"{{query}}","limit":1000,"mode":"preview"}');
  });

  it("sends model-selected tool arguments unchanged", async () => {
    const calls: Record<string, unknown>[] = [];
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const payload = readMCPPayload(init);
      calls.push(payload);
      if (payload.method === "tools/call") {
        return createJsonResponse({
          result: {
            content: [
              {
                text: "Updated Zotero note",
                type: "text",
              },
            ],
          },
        });
      }
      return createJsonResponse({ result: {} });
    });
    vi.stubGlobal("fetch", fetchMock);

    const args = {
      itemKey: "ABCD1234",
      limit: 1000,
      nested: { keep: true },
      note: "Use this exact payload",
    };
    const result = await callMCPToolByName(
      { mcpEndpoint: MCP_ENDPOINT },
      "update_note",
      args,
    );

    const toolCall = calls.find((payload) => payload.method === "tools/call");
    expect(toolCall).toMatchObject({
      params: {
        arguments: args,
        name: "update_note",
      },
    });
    expect(result).toEqual([
      {
        content: "Updated Zotero note",
        source: "update_note",
        title: "MCP tool result",
      },
    ]);
  });
});
