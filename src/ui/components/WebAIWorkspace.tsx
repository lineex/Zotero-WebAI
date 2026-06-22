import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AssembledContext } from "../../services/contextAssembler";
import {
  callMCPToolByName,
  callMCPToolWithFallback,
  listMCPTools,
  type MCPToolCallOutcome,
  type MCPToolResultItem,
  type MCPToolSummary,
} from "../../services/mcpClient";
import {
  parseCustomPresets,
  type Settings,
} from "../../services/settingsManager";
import type { ScopeContext } from "../../types/scope";
import { getSidebarTheme } from "../theme";
import { typography } from "../typography";

type WebAIServiceId = "deepseek" | "zai";
type PromptSourceMode = "paper" | "selection";

interface WebAIService {
  id: WebAIServiceId;
  label: string;
  url: string;
}

export interface IncomingWebPrompt {
  id: string;
  label: string;
  prompt: string;
  sourceMode?: PromptSourceMode;
}

interface WebAIWorkspaceProps {
  contextSummary: AssembledContext | null;
  customPresets?: string;
  hostWindow: Window;
  incomingPrompt?: IncomingWebPrompt | null;
  onIncomingPromptHandled?: (id: string) => void;
  onScopeRefresh?: () => void;
  settings: Settings;
  scope: ScopeContext | null;
}

interface WebAISkill {
  id: string;
  label: string;
  promptPrefix: string;
  slashCommand: string;
}

interface PromptInsertResult {
  method?: string;
  ok: boolean;
  reason?: string;
}

interface MCPPromptContextResult {
  contextText: string;
  status: string | null;
}

interface WebChatTextResult {
  ok: boolean;
  reason?: string;
  text?: string;
}

interface MCPBridgeRequest {
  arguments: Record<string, unknown>;
  id: string;
  raw: string;
  toolName: string;
}

interface FrameMessageManager {
  addMessageListener?: (
    name: string,
    listener: (message: { data?: PromptInsertResult | WebChatTextResult }) => void,
  ) => void;
  loadFrameScript?: (url: string, allowDelayedLoad: boolean) => void;
  removeMessageListener?: (
    name: string,
    listener: (message: { data?: PromptInsertResult | WebChatTextResult }) => void,
  ) => void;
}

const PROMPT_TEXT_LIMIT = 60000;
const MCP_CONTEXT_TEXT_LIMIT = 12000;
const MCP_ITEM_TEXT_LIMIT = 1800;
const MCP_SCHEMA_TEXT_LIMIT = 2200;
const MCP_TOOL_CATALOG_TEXT_LIMIT = 52000;
const MCP_QUERY_TEXT_LIMIT = 3000;
const MCP_BRIDGE_SCAN_TEXT_LIMIT = 120000;
const MCP_BRIDGE_POLL_MS = 3500;
const SERVICES: WebAIService[] = [
  {
    id: "deepseek",
    label: "DeepSeek Web",
    url: "https://chat.deepseek.com/",
  },
  {
    id: "zai",
    label: "Z.ai Web",
    url: "https://chat.z.ai/",
  },
];

export const WebAIWorkspace: React.FC<WebAIWorkspaceProps> = ({
  contextSummary,
  customPresets = "",
  hostWindow,
  incomingPrompt,
  onIncomingPromptHandled,
  scope,
  settings,
}) => {
  const [service, setService] = useState<WebAIService>(SERVICES[0]);
  const [status, setStatus] = useState(`Loaded ${SERVICES[0].label}`);
  const [isError, setIsError] = useState(false);
  const [message, setMessage] = useState("");
  const [selectedSkillID, setSelectedSkillID] = useState<string | null>(null);
  const frameHostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<Element | null>(null);
  const activeMCPBridgeTokensRef = useRef<Set<string>>(new Set());
  const handledMCPRequestsRef = useRef<Set<string>>(new Set());
  const theme = getSidebarTheme(hostWindow);

  const customSkills = useMemo(
    () => buildCustomSkills(customPresets),
    [customPresets],
  );
  const selectedSkill =
    customSkills.find((skill) => skill.id === selectedSkillID) || null;
  const slashQuery = getSlashQuery(message);
  const slashSuggestions = slashQuery
    ? filterSlashSkills(customSkills, slashQuery.query)
    : [];
  const showSlashMenu = Boolean(slashQuery && slashSuggestions.length > 0);

  useEffect(() => {
    if (selectedSkillID && !customSkills.some((skill) => skill.id === selectedSkillID)) {
      setSelectedSkillID(null);
    }
  }, [customSkills, selectedSkillID]);

  useEffect(() => {
    const host = frameHostRef.current;
    if (!host) {
      return;
    }

    host.replaceChildren();
    const frame = createWebFrame(host.ownerDocument || hostWindow.document, service.url);
    frameRef.current = frame;
    activeMCPBridgeTokensRef.current.clear();
    handledMCPRequestsRef.current.clear();
    host.appendChild(frame);
    setStatus(`Loaded ${service.label}. Sign in, then Send inserts prompts into the web chat.`);
    setIsError(false);

    return () => {
      try {
        frame.remove();
      } catch {
        // Remote browser wrappers can throw during teardown.
      }
      if (frameRef.current === frame) {
        frameRef.current = null;
      }
    };
  }, [hostWindow.document, service]);

  useEffect(() => {
    if (!incomingPrompt) {
      return;
    }

    setMessage(incomingPrompt.prompt);
    setSelectedSkillID(null);
    setStatus(`${incomingPrompt.label} is ready. Send inserts it into ${service.label}.`);
    setIsError(false);
    onIncomingPromptHandled?.(incomingPrompt.id);
  }, [incomingPrompt, onIncomingPromptHandled, service.label]);

  useEffect(() => {
    if (!shouldUseMCPInConversation(settings)) {
      return;
    }

    let cancelled = false;
    let isPolling = false;
    let timerId: unknown = null;
    const timerHost = resolveTimerHost();

    const schedule = () => {
      if (cancelled) {
        return;
      }
      timerId = timerHost.setTimeout(() => {
        void pollForMCPBridgeRequests();
      }, MCP_BRIDGE_POLL_MS);
    };

    const pollForMCPBridgeRequests = async () => {
      if (cancelled || isPolling) {
        schedule();
        return;
      }
      isPolling = true;
      try {
        const requests = await extractMCPBridgeRequestsFromWebChat(
          frameRef.current,
          activeMCPBridgeTokensRef.current,
        );
        for (const request of requests) {
          if (cancelled || handledMCPRequestsRef.current.has(request.id)) {
            continue;
          }
          handledMCPRequestsRef.current.add(request.id);
          await runMCPBridgeRequest({
            deliverPrompt,
            request,
            serviceLabel: service.label,
            settings,
            setStatus,
          });
        }
      } catch (error) {
        ztoolkit.log("MCP bridge polling failed:", error);
      } finally {
        isPolling = false;
        schedule();
      }
    };

    schedule();
    return () => {
      cancelled = true;
      if (timerId != null) {
        timerHost.clearTimeout(timerId);
      }
    };
  }, [service.label, settings]);

  const deliverPrompt = async (prompt: string, statusPrefix?: string | null) => {
    copyTextToClipboard(prompt);
    const result = await insertPromptIntoWebChat(frameRef.current, prompt);
    focusFrame(frameRef.current);
    if (result.ok) {
      setStatus(
        `${statusPrefix ? `${statusPrefix} ` : ""}Prompt inserted into ${service.label}. Review it, then send in the web chat.`,
      );
    } else {
      setStatus(
        `${statusPrefix ? `${statusPrefix} ` : ""}Prompt copied (${prompt.length} characters). If it did not appear in ${service.label}, click the web chat box and paste.`,
      );
    }
    setIsError(false);
  };

  const runAction = async (action: () => Promise<void> | void) => {
    try {
      await action();
    } catch (error) {
      const errorMessage =
        error instanceof Error && error.message ? error.message : String(error);
      setStatus(`Failed: ${errorMessage}`);
      setIsError(true);
      ztoolkit.log("Web AI action failed:", error);
    }
  };

  const chooseSkill = (skill: WebAISkill) => {
    setSelectedSkillID(skill.id);
    setMessage(removeSlashToken(message).trimStart());
    setStatus(`Skill /${skill.slashCommand} selected. Write your question and send.`);
    setIsError(false);
  };

  const sendPrompt = async () => {
    const resolved = resolveSkillFromMessage(message, customSkills, selectedSkill);
    if (resolved.skill && resolved.skill.id !== selectedSkillID) {
      setSelectedSkillID(resolved.skill.id);
    }
    const promptInput = {
      contextSummary,
      message: resolved.message,
      scope,
      selectedSkill: resolved.skill,
    };
    const mcpBridgeToken = shouldUseMCPInConversation(settings)
      ? createMCPBridgeToken()
      : "";
    const basePrompt = buildWorkspacePrompt({
      ...promptInput,
      mcpContext: "",
    });
    const mcpContext = await fetchMCPContextForConversation(settings, {
      ...promptInput,
      mcpBridgeToken,
      setStatus,
    });
    if (mcpBridgeToken && mcpContext.contextText) {
      activeMCPBridgeTokensRef.current.add(mcpBridgeToken);
    }
    const prompt = mcpContext.contextText
      ? buildWorkspacePrompt({
          ...promptInput,
          mcpContext: mcpContext.contextText,
        })
      : basePrompt;
    await deliverPrompt(prompt, mcpContext.status);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void runAction(sendPrompt);
      return;
    }

    if (event.key === "Enter" && showSlashMenu && slashSuggestions[0]) {
      event.preventDefault();
      chooseSkill(slashSuggestions[0]);
    }
  };

  return (
    <section
      style={{
        ...styles.container,
        background: theme.background,
        color: theme.text,
      }}
    >
      <div
        ref={frameHostRef}
        style={{
          ...styles.frameHost,
          background: theme.surfaceBackground,
          borderColor: theme.softBorder,
        }}
      />

      <div style={styles.frameToolbar}>
        <div style={styles.serviceBar}>
          {SERVICES.map((candidate) => (
            <button
              key={candidate.id}
              style={{
                ...styles.serviceButton,
                background:
                  candidate.id === service.id
                    ? theme.badgeBackground
                    : theme.surfaceBackground,
                borderColor:
                  candidate.id === service.id ? theme.badgeBorder : theme.buttonBorder,
                color: candidate.id === service.id ? theme.badgeText : theme.buttonText,
              }}
              onClick={() => setService(candidate)}
              type="button"
            >
              {candidate.label}
            </button>
          ))}
        </div>
        <div style={styles.frameActions}>
          <button
            style={{
              ...styles.miniButton,
              background: theme.surfaceBackground,
              borderColor: theme.buttonBorder,
              color: theme.buttonText,
            }}
            onClick={() =>
              void runAction(() => loadFrameElement(frameRef.current, service.url))
            }
            type="button"
          >
            Reload
          </button>
          <button
            style={{
              ...styles.miniButton,
              background: theme.surfaceBackground,
              borderColor: theme.buttonBorder,
              color: theme.buttonText,
            }}
            onClick={() => openExternalURL(service.url)}
            type="button"
          >
            Open External
          </button>
        </div>
      </div>

      <div
        style={{
          ...styles.composerPanel,
          background: theme.surfaceBackground,
          borderColor: theme.softBorder,
        }}
      >
        {showSlashMenu && (
          <div
            style={{
              ...styles.slashMenu,
              background: theme.surfaceBackground,
              borderColor: theme.softBorder,
            }}
          >
            {slashSuggestions.map((skill) => (
              <button
                key={skill.id}
                style={{
                  ...styles.skillOption,
                  color: theme.text,
                }}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => chooseSkill(skill)}
                type="button"
              >
                <span style={styles.skillOptionTitle}>{skill.label}</span>
                <span style={{ ...styles.skillOptionCommand, color: theme.mutedText }}>
                  /{skill.slashCommand}
                </span>
              </button>
            ))}
          </div>
        )}

        {selectedSkill && (
          <button
            style={{
              ...styles.selectedSkill,
              background: theme.badgeBackground,
              borderColor: theme.badgeBorder,
              color: theme.badgeText,
            }}
            onClick={() => setSelectedSkillID(null)}
            title="Clear selected skill"
            type="button"
          >
            /{selectedSkill.slashCommand} {selectedSkill.label}
          </button>
        )}

        <textarea
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="输入消息，或输入 / 选择自定义 Skill"
          style={{
            ...styles.composerInput,
            background: "transparent",
            color: theme.text,
          }}
          value={message}
        />

        <div style={styles.composerFooter}>
          <div
            style={{
              ...styles.status,
              color: isError ? theme.errorText : theme.mutedText,
            }}
          >
            {customSkills.length
              ? status
              : "Open settings to add custom skills, then type / here."}
          </div>
          <button
            style={{
              ...styles.sendButton,
              background: theme.badgeBackground,
              borderColor: theme.badgeBorder,
              color: theme.badgeText,
            }}
            onClick={() => void runAction(sendPrompt)}
            title="Insert prompt into the web chat, with clipboard fallback"
            type="button"
          >
            Send
          </button>
        </div>
      </div>
    </section>
  );
};

function buildCustomSkills(customPresetsValue: string): WebAISkill[] {
  return parseCustomPresets(customPresetsValue).presets
    .filter((preset) => preset.label?.trim() && preset.promptPrefix?.trim())
    .map((preset) => {
      const label = String(preset.label || preset.id).trim();
      return {
        id: preset.id,
        label,
        promptPrefix: String(preset.promptPrefix || "").trim(),
        slashCommand: normalizeSlashCommand(
          preset.slashCommand || preset.label || preset.id,
        ),
      };
    });
}

function filterSlashSkills(skills: WebAISkill[], query: string): WebAISkill[] {
  const normalized = normalizeSlashCommand(query).toLowerCase();
  if (!normalized) {
    return skills.slice(0, 8);
  }

  return skills
    .filter((skill) =>
      [skill.label, skill.slashCommand, skill.id]
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    )
    .slice(0, 8);
}

function getSlashQuery(value: string): { query: string } | null {
  const match = value.match(/^\s*\/([^\s]*)$/);
  return match ? { query: match[1] || "" } : null;
}

function removeSlashToken(value: string): string {
  return value.replace(/^\s*\/[^\s]*(?:\s+)?/, "");
}

function resolveSkillFromMessage(
  value: string,
  skills: WebAISkill[],
  selectedSkill: WebAISkill | null,
): { message: string; skill: WebAISkill | null } {
  const match = value.match(/^\s*\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return { message: value, skill: selectedSkill };
  }

  const command = normalizeSlashCommand(match[1] || "");
  const matchedSkill =
    skills.find(
      (skill) =>
        skill.slashCommand.toLowerCase() === command.toLowerCase() ||
        skill.id.toLowerCase() === command.toLowerCase() ||
        skill.label.toLowerCase() === command.toLowerCase(),
    ) || selectedSkill;
  return {
    message: match[2] || "",
    skill: matchedSkill,
  };
}

function normalizeSlashCommand(value: string): string {
  return String(value || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\s+/g, "");
}

function createWebFrame(doc: Document, url: string): Element {
  const maybeXULDoc = doc as Document & {
    createXULElement?: (tagName: string) => Element;
  };
  const browser = maybeXULDoc.createXULElement?.("browser");
  if (browser) {
    browser.classList.add("ai-assistant-web-browser");
    browser.setAttribute("type", "content");
    browser.setAttribute("remote", "true");
    browser.setAttribute("maychangeremoteness", "true");
    browser.setAttribute("disableglobalhistory", "true");
    browser.setAttribute("flex", "1");
    loadFrameElement(browser, url);
    return browser;
  }

  const iframe = doc.createElement("iframe");
  iframe.className = "ai-assistant-web-browser";
  iframe.setAttribute(
    "sandbox",
    [
      "allow-downloads",
      "allow-forms",
      "allow-modals",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
      "allow-same-origin",
      "allow-scripts",
      "allow-top-navigation-by-user-activation",
    ].join(" "),
  );
  iframe.setAttribute("referrerpolicy", "no-referrer-when-downgrade");
  iframe.setAttribute("src", url);
  return iframe;
}

function loadFrameElement(frame: Element | null, url: string): void {
  if (!frame) {
    return;
  }

  const maybeBrowser = frame as Element & {
    loadURI?: (uri: string | nsIURI, options?: unknown) => void;
  };

  if (typeof maybeBrowser.loadURI === "function") {
    try {
      maybeBrowser.loadURI(url, {
        triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
      });
      return;
    } catch {
      try {
        maybeBrowser.loadURI(Services.io.newURI(url));
        return;
      } catch (error) {
        ztoolkit.log("Failed to load Web AI browser:", error);
      }
    }
  }

  if ("src" in frame) {
    (frame as HTMLIFrameElement).src = url;
  }
}

function focusFrame(frame: Element | null): void {
  try {
    (frame as HTMLElement | null)?.focus?.();
    (frame as HTMLIFrameElement | null)?.contentWindow?.focus?.();
  } catch {
    // Cross-origin focus may fail. Copying the prompt is the key handoff.
  }
}

async function insertPromptIntoWebChat(
  frame: Element | null,
  prompt: string,
): Promise<PromptInsertResult> {
  if (!frame) {
    return { ok: false, reason: "web-frame-missing" };
  }

  const directResult = insertPromptDirectly(frame, prompt);
  if (directResult.ok) {
    return directResult;
  }

  return insertPromptWithFrameScript(frame, prompt);
}

function insertPromptDirectly(
  frame: Element,
  prompt: string,
): PromptInsertResult {
  try {
    const doc = (frame as HTMLIFrameElement).contentWindow?.document;
    if (!doc) {
      return { ok: false, reason: "content-document-missing" };
    }
    return insertPromptIntoDocument(doc, prompt, "direct-dom");
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error && error.message
          ? error.message
          : "direct-dom-unavailable",
    };
  }
}

function insertPromptWithFrameScript(
  frame: Element,
  prompt: string,
): Promise<PromptInsertResult> {
  const messageManager = getFrameMessageManager(frame);
  const addMessageListener = messageManager?.addMessageListener;
  const loadFrameScript = messageManager?.loadFrameScript;
  const removeMessageListener = messageManager?.removeMessageListener;
  if (
    typeof addMessageListener !== "function" ||
    typeof loadFrameScript !== "function"
  ) {
    return Promise.resolve({ ok: false, reason: "frame-script-unavailable" });
  }

  const messageName = `ZoteroWebAI:PromptInsert:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2)}`;
  const source = buildPromptInsertFrameScript(messageName, prompt);

  return new Promise((resolve) => {
    const timerHost = resolveTimerHost();
    let settled = false;
    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        removeMessageListener?.call(messageManager, messageName, listener);
      } catch {
        // The frame may have navigated while the script was running.
      }
    };
    const listener = (message: { data?: PromptInsertResult | WebChatTextResult }) => {
      const data = (message.data || {
        ok: false,
        reason: "empty-frame-result",
      }) as PromptInsertResult;
      cleanup();
      resolve(data);
    };
    const timeoutId = timerHost.setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: "frame-script-timeout" });
    }, 1500);

    const finish = (result: PromptInsertResult) => {
      timerHost.clearTimeout(timeoutId);
      cleanup();
      resolve(result);
    };

    try {
      addMessageListener.call(messageManager, messageName, listener);
      loadFrameScript.call(
        messageManager,
        `data:application/javascript;charset=utf-8,${encodeURIComponent(source)}`,
        false,
      );
    } catch (error) {
      finish({
        ok: false,
        reason:
          error instanceof Error && error.message
            ? error.message
            : "frame-script-error",
      });
    }
  });
}

async function readWebChatText(
  frame: Element | null,
): Promise<WebChatTextResult> {
  if (!frame) {
    return { ok: false, reason: "web-frame-missing" };
  }

  const directResult = readWebChatTextDirectly(frame);
  if (directResult.ok) {
    return directResult;
  }

  return readWebChatTextWithFrameScript(frame);
}

function readWebChatTextDirectly(frame: Element): WebChatTextResult {
  try {
    const doc = (frame as HTMLIFrameElement).contentWindow?.document;
    if (!doc) {
      return { ok: false, reason: "content-document-missing" };
    }
    return {
      ok: true,
      text: readWebChatTextFromDocument(doc),
    };
  } catch (error) {
    return {
      ok: false,
      reason:
        error instanceof Error && error.message
          ? error.message
          : "direct-dom-unavailable",
    };
  }
}

function readWebChatTextWithFrameScript(
  frame: Element,
): Promise<WebChatTextResult> {
  const messageManager = getFrameMessageManager(frame);
  const addMessageListener = messageManager?.addMessageListener;
  const loadFrameScript = messageManager?.loadFrameScript;
  const removeMessageListener = messageManager?.removeMessageListener;
  if (
    typeof addMessageListener !== "function" ||
    typeof loadFrameScript !== "function"
  ) {
    return Promise.resolve({ ok: false, reason: "frame-script-unavailable" });
  }

  const messageName = `ZoteroWebAI:ChatText:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2)}`;
  const source = buildWebChatTextFrameScript(messageName);

  return new Promise((resolve) => {
    const timerHost = resolveTimerHost();
    let settled = false;
    const cleanup = () => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        removeMessageListener?.call(messageManager, messageName, listener);
      } catch {
        // The frame may have navigated while the script was running.
      }
    };
    const listener = (message: { data?: PromptInsertResult | WebChatTextResult }) => {
      const data = (message.data || {
        ok: false,
        reason: "empty-frame-result",
      }) as WebChatTextResult;
      cleanup();
      resolve(data);
    };
    const timeoutId = timerHost.setTimeout(() => {
      cleanup();
      resolve({ ok: false, reason: "frame-script-timeout" });
    }, 1500);

    const finish = (result: WebChatTextResult) => {
      timerHost.clearTimeout(timeoutId);
      cleanup();
      resolve(result);
    };

    try {
      addMessageListener.call(messageManager, messageName, listener);
      loadFrameScript.call(
        messageManager,
        `data:application/javascript;charset=utf-8,${encodeURIComponent(source)}`,
        false,
      );
    } catch (error) {
      finish({
        ok: false,
        reason:
          error instanceof Error && error.message
            ? error.message
            : "frame-script-error",
      });
    }
  });
}

function getFrameMessageManager(frame: Element): FrameMessageManager | null {
  return (
    (frame as Element & {
      messageManager?: FrameMessageManager;
    }).messageManager || null
  );
}

function resolveTimerHost(): {
  clearTimeout: (timerId: unknown) => void;
  setTimeout: (callback: () => void, timeoutMs: number) => unknown;
} {
  const globalTimerHost = globalThis as unknown as {
    clearTimeout?: (timerId: unknown) => void;
    setTimeout?: (callback: () => void, timeoutMs: number) => unknown;
  };
  if (
    typeof globalTimerHost.setTimeout === "function" &&
    typeof globalTimerHost.clearTimeout === "function"
  ) {
    const hostSetTimeout = globalTimerHost.setTimeout;
    const hostClearTimeout = globalTimerHost.clearTimeout;
    return {
      clearTimeout: (timerId) => hostClearTimeout(timerId),
      setTimeout: (callback, timeoutMs) => hostSetTimeout(callback, timeoutMs),
    };
  }

  const mainWindow = Zotero.getMainWindow?.() as
    | {
        clearTimeout?: (timerId: unknown) => void;
        setTimeout?: (callback: () => void, timeoutMs: number) => unknown;
      }
    | undefined;
  if (
    typeof mainWindow?.setTimeout === "function" &&
    typeof mainWindow.clearTimeout === "function"
  ) {
    const windowSetTimeout = mainWindow.setTimeout;
    const windowClearTimeout = mainWindow.clearTimeout;
    return {
      clearTimeout: (timerId) => windowClearTimeout(timerId),
      setTimeout: (callback, timeoutMs) => windowSetTimeout(callback, timeoutMs),
    };
  }

  return {
    clearTimeout: () => undefined,
    setTimeout: (callback) => {
      void Promise.resolve().then(callback);
      return 0;
    },
  };
}

function buildPromptInsertFrameScript(
  messageName: string,
  prompt: string,
): string {
  return `
(function () {
  const messageName = ${JSON.stringify(messageName)};
  const prompt = ${JSON.stringify(prompt)};
  ${insertPromptIntoDocumentSource()}
  try {
    const result = insertPromptIntoDocument(content.document, prompt, "frame-script");
    sendAsyncMessage(messageName, result);
  } catch (error) {
    sendAsyncMessage(messageName, {
      ok: false,
      reason: error && error.message ? error.message : "frame-script-exception"
    });
  }
})();`;
}

function buildWebChatTextFrameScript(messageName: string): string {
  return `
(function () {
  const messageName = ${JSON.stringify(messageName)};
  const MCP_BRIDGE_SCAN_TEXT_LIMIT = ${MCP_BRIDGE_SCAN_TEXT_LIMIT};
  ${readWebChatTextFromDocument.toString()}
  try {
    sendAsyncMessage(messageName, {
      ok: true,
      text: readWebChatTextFromDocument(content.document)
    });
  } catch (error) {
    sendAsyncMessage(messageName, {
      ok: false,
      reason: error && error.message ? error.message : "frame-script-exception"
    });
  }
})();`;
}

function insertPromptIntoDocument(
  doc: Document,
  prompt: string,
  method: string,
): PromptInsertResult {
  const composer = findWebChatComposer(doc);
  if (!composer) {
    return { ok: false, method, reason: "composer-not-found" };
  }
  writePromptToComposer(composer, prompt);
  return { ok: true, method };
}

function readWebChatTextFromDocument(doc: Document): string {
  const root =
    doc.querySelector("main") ||
    doc.querySelector('[role="main"]') ||
    doc.body ||
    doc.documentElement;
  const text =
    root && "innerText" in root
      ? (root as HTMLElement).innerText
      : root?.textContent || "";
  return text.slice(-MCP_BRIDGE_SCAN_TEXT_LIMIT);
}

function findWebChatComposer(doc: Document): HTMLElement | null {
  const selectors = [
    "textarea:not([disabled]):not([readonly])",
    '[contenteditable="true"]',
    '[role="textbox"]',
    'input[type="text"]:not([disabled]):not([readonly])',
  ];
  const candidates: HTMLElement[] = [];
  selectors.forEach((selector) => {
    const nodes = doc.querySelectorAll(selector) as NodeListOf<Element>;
    for (let index = 0; index < nodes.length; index += 1) {
      const element = nodes.item(index);
      if (element.nodeType === Node.ELEMENT_NODE) {
        candidates.push(element as HTMLElement);
      }
    }
  });
  const visibleCandidates = candidates
    .filter(isVisibleComposerCandidate)
    .sort(
      (left, right) => scoreComposerCandidate(right) - scoreComposerCandidate(left),
    );
  return visibleCandidates[0] || null;
}

function isVisibleComposerCandidate(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const doc = element.ownerDocument;
  if (!doc) {
    return false;
  }
  const style = doc.defaultView?.getComputedStyle(element);
  return Boolean(
    rect.width >= 120 &&
      rect.height >= 18 &&
      style?.display !== "none" &&
      style?.visibility !== "hidden" &&
      !element.closest("[aria-hidden='true']"),
  );
}

function scoreComposerCandidate(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  const tagName = element.tagName.toLowerCase();
  const tagBoost = tagName === "textarea" ? 100000 : tagName === "input" ? 80000 : 0;
  const editableBoost =
    element.isContentEditable || element.getAttribute("contenteditable") === "true"
      ? 50000
      : 0;
  return tagBoost + editableBoost + rect.bottom * 100 + rect.width + rect.height;
}

function writePromptToComposer(element: HTMLElement, prompt: string): void {
  const doc = element.ownerDocument;
  if (!doc) {
    throw new Error("Composer document is unavailable");
  }
  element.focus();
  const tagName = element.tagName.toLowerCase();
  if (tagName === "textarea" || tagName === "input") {
    (element as HTMLTextAreaElement | HTMLInputElement).value = prompt;
  } else {
    const selection = doc.defaultView?.getSelection();
    const range = doc.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    if (!doc.execCommand("insertText", false, prompt)) {
      element.textContent = prompt;
    }
  }
  dispatchComposerEvents(element, prompt);
}

function dispatchComposerEvents(element: HTMLElement, prompt: string): void {
  const doc = element.ownerDocument;
  if (!doc) {
    return;
  }
  const win = doc.defaultView;
  try {
    element.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        data: prompt,
        inputType: "insertText",
      }),
    );
  } catch {
    // Older embedded Gecko builds can reject constructed InputEvent objects.
  }
  try {
    element.dispatchEvent(
      new (win?.InputEvent || InputEvent)("input", {
        bubbles: true,
        data: prompt,
        inputType: "insertText",
      }),
    );
  } catch {
    element.dispatchEvent(new Event("input", { bubbles: true }));
  }
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function insertPromptIntoDocumentSource(): string {
  return `${findWebChatComposer.toString()}
${isVisibleComposerCandidate.toString()}
${scoreComposerCandidate.toString()}
${writePromptToComposer.toString()}
${dispatchComposerEvents.toString()}
${insertPromptIntoDocument.toString()}`;
}

function openExternalURL(url: string): void {
  try {
    if (typeof Zotero.launchURL === "function") {
      Zotero.launchURL(url);
      return;
    }
  } catch (error) {
    ztoolkit.log("Zotero.launchURL failed:", error);
  }

  const componentClasses = Components.classes as Record<
    string,
    { getService: (interfaceType: unknown) => nsIExternalProtocolService }
  >;
  const externalProtocolService = componentClasses[
    "@mozilla.org/uriloader/external-protocol-service;1"
  ].getService(Components.interfaces.nsIExternalProtocolService);
  externalProtocolService.loadURI(Services.io.newURI(url));
}

async function extractMCPBridgeRequestsFromWebChat(
  frame: Element | null,
  activeTokens: Set<string>,
): Promise<MCPBridgeRequest[]> {
  if (!activeTokens.size) {
    return [];
  }

  const result = await readWebChatText(frame);
  if (!result.ok || !result.text) {
    return [];
  }

  return parseMCPBridgeRequests(result.text, activeTokens);
}

function parseMCPBridgeRequests(
  text: string,
  activeTokens: Set<string>,
): MCPBridgeRequest[] {
  const requests: MCPBridgeRequest[] = [];
  const markerPattern =
    /ZOTERO_WEBAI_MCP_REQUEST\s*([\s\S]*?)\s*END_ZOTERO_WEBAI_MCP_REQUEST/g;
  let match: RegExpExecArray | null;
  while ((match = markerPattern.exec(text)) !== null) {
    const rawPayload = stripMarkdownCodeFence(match[1] || "");
    const parsed = parseMCPBridgePayload(rawPayload, activeTokens, match[0]);
    if (parsed) {
      requests.push(parsed);
    }
  }
  return requests;
}

function stripMarkdownCodeFence(value: string): string {
  return value
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function parseMCPBridgePayload(
  value: string,
  activeTokens: Set<string>,
  raw: string,
): MCPBridgeRequest | null {
  let record: Record<string, unknown>;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    record = parsed as Record<string, unknown>;
  } catch {
    return null;
  }

  const token = String(record.token || "").trim();
  if (!activeTokens.has(token)) {
    return null;
  }

  const toolName = String(record.tool || record.toolName || record.name || "").trim();
  if (!toolName) {
    return null;
  }

  const argsRecord =
    record.arguments && typeof record.arguments === "object" && !Array.isArray(record.arguments)
      ? (record.arguments as Record<string, unknown>)
      : {};
  const requestId =
    String(record.id || "").trim() || `${token}:${toolName}:${stableHash(JSON.stringify(argsRecord))}`;

  return {
    arguments: argsRecord,
    id: requestId,
    raw,
    toolName,
  };
}

async function runMCPBridgeRequest({
  deliverPrompt,
  request,
  serviceLabel,
  settings,
  setStatus,
}: {
  deliverPrompt: (prompt: string, statusPrefix?: string | null) => Promise<void>;
  request: MCPBridgeRequest;
  serviceLabel: string;
  settings: Settings;
  setStatus: (status: string) => void;
}): Promise<void> {
  try {
    setStatus(`Running Zotero MCP tool ${request.toolName}...`);
    const results = await callMCPToolByName(
      settings,
      request.toolName,
      request.arguments,
    );
    const prompt = formatMCPBridgeResultPrompt(request, results);
    await deliverPrompt(
      prompt,
      `MCP ${request.toolName} result inserted into ${serviceLabel}.`,
    );
  } catch (error) {
    const message =
      error instanceof Error && error.message ? error.message : String(error);
    const prompt = [
      "Zotero-WebAI MCP tool error:",
      `Tool: ${request.toolName}`,
      `Arguments: ${safeJSONStringify(request.arguments)}`,
      `Error: ${message}`,
      "",
      "Please revise the MCP request if another Zotero tool or different arguments are needed, or continue without this tool if enough context is available.",
    ].join("\n");
    await deliverPrompt(prompt, `MCP ${request.toolName} failed.`);
  }
}

function formatMCPBridgeResultPrompt(
  request: MCPBridgeRequest,
  results: MCPToolResultItem[],
): string {
  const resultText =
    formatMCPPromptContext(results, {
      results,
      toolName: request.toolName,
      usedFallback: false,
    }) || "MCP tool returned no structured or text content.";
  return [
    "Zotero-WebAI MCP tool result:",
    `Tool: ${request.toolName}`,
    `Arguments: ${safeJSONStringify(request.arguments)}`,
    "",
    resultText,
    "",
    "Use this Zotero MCP result to continue answering the user's request. If another Zotero MCP tool is needed, emit a new ZOTERO_WEBAI_MCP_REQUEST block using the same active token and a schema-valid arguments object.",
  ].join("\n");
}

function createMCPBridgeToken(): string {
  return `zotero-webai-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

async function fetchMCPContextForConversation(
  settings: Settings,
  {
    contextSummary,
    mcpBridgeToken,
    message,
    scope,
    selectedSkill,
    setStatus,
  }: {
    contextSummary: AssembledContext | null;
    mcpBridgeToken: string;
    message: string;
    scope: ScopeContext | null;
    selectedSkill: WebAISkill | null;
    setStatus: (status: string) => void;
  },
): Promise<MCPPromptContextResult> {
  if (!shouldUseMCPInConversation(settings)) {
    return { contextText: "", status: null };
  }

  try {
    setStatus("Loading Zotero MCP tools for the web model...");
    const tools = await listMCPTools(settings);
    const planningContext = buildMCPPlanningContext(tools, mcpBridgeToken);
    const query = buildMCPConversationQuery({
      contextSummary,
      message,
      scope,
      selectedSkill,
    });
    if (!query) {
      return {
        contextText: planningContext,
        status: tools.length
          ? `MCP tool schema embedded (${tools.length} tools).`
          : "MCP returned no tool schema.",
      };
    }

    try {
      setStatus("Fetching initial Zotero MCP context for this conversation...");
      const outcome = await callMCPToolWithFallback(settings, query, tools);
      const contextText = formatMCPPromptContext(outcome.results, outcome);
      return {
        contextText: [planningContext, contextText].filter(Boolean).join("\n\n"),
        status: contextText
          ? `MCP tool schema embedded; initial context added from ${outcome.toolName}.`
          : `MCP tool schema embedded (${tools.length} tools).`,
      };
    } catch (error) {
      ztoolkit.log("MCP initial context unavailable for Web AI prompt:", error);
      return {
        contextText: planningContext,
        status: `MCP tool schema embedded (${tools.length} tools); no initial context.`,
      };
    }
  } catch (error) {
    ztoolkit.log("MCP tool schema unavailable for Web AI prompt:", error);
    return {
      contextText: "",
      status: "MCP unavailable; using Zotero context only.",
    };
  }
}

function shouldUseMCPInConversation(settings: Settings): boolean {
  return Boolean(
    settings.evidenceProviderMode === "mcp-http" &&
      settings.mcpEndpoint?.trim(),
  );
}

function buildMCPConversationQuery({
  contextSummary,
  message,
  scope,
  selectedSkill,
}: {
  contextSummary: AssembledContext | null;
  message: string;
  scope: ScopeContext | null;
  selectedSkill: WebAISkill | null;
}): string {
  const selectedText =
    scope?.selectedText?.trim() || contextSummary?.selectedText?.trim() || "";
  const parts = [
    selectedSkill ? `Skill: ${selectedSkill.label}` : "",
    message.trim() ? `User message: ${message.trim()}` : "",
    scope?.label ? `Zotero context: ${scope.label}` : "",
    contextSummary?.metadata ? `Metadata:\n${contextSummary.metadata}` : "",
    selectedText ? `Selected passage:\n${selectedText}` : "",
  ];
  const query = parts.filter(Boolean).join("\n\n").trim();
  return truncateText(query, MCP_QUERY_TEXT_LIMIT);
}

function buildMCPPlanningContext(
  tools: MCPToolSummary[],
  mcpBridgeToken: string,
): string {
  const catalog = formatMCPToolCatalog(tools);
  return [
    "Zotero MCP bridge:",
    "Zotero-WebAI can run local Zotero MCP tools for you. The user does not type MCP commands; you decide whether a tool is needed and choose schema-valid arguments.",
    "If Zotero MCP is needed, do not invent the tool result. Reply only with an MCP request block using the markers named below. Zotero-WebAI will execute it and insert the result back into this chat.",
    "Start marker: ZOTERO_WEBAI_MCP_REQUEST",
    "End marker: END_ZOTERO_WEBAI_MCP_REQUEST",
    `Required JSON fields inside the block: {"token":"${mcpBridgeToken}","id":"short-unique-id","tool":"tool_name","arguments":{...}}`,
    "Use the inputSchema for each tool to decide parameter names and values. Keep write tools for explicit user requests that modify Zotero notes, tags, metadata, or items.",
    catalog,
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatMCPToolCatalog(tools: MCPToolSummary[]): string {
  if (!tools.length) {
    return "Available Zotero MCP tools: none returned by tools/list.";
  }

  const render = (schemaLimit: number) =>
    [
      `Available Zotero MCP tools (${tools.length}):`,
      ...tools.map((tool) => {
        const lines = [`- ${tool.name}`];
        if (tool.description?.trim()) {
          lines.push(`  description: ${tool.description.trim()}`);
        }
        if (tool.inputSchema) {
          lines.push(
            `  inputSchema: ${truncateText(safeJSONStringify(tool.inputSchema), schemaLimit)}`,
          );
        }
        return lines.join("\n");
      }),
    ].join("\n");

  const fullCatalog = render(MCP_SCHEMA_TEXT_LIMIT);
  return fullCatalog.length <= MCP_TOOL_CATALOG_TEXT_LIMIT
    ? fullCatalog
    : render(900);
}

function formatMCPPromptContext(
  results: MCPToolResultItem[],
  outcome?: MCPToolCallOutcome,
): string {
  const formattedItems = results
    .map((result, index) => formatMCPPromptItem(result, index))
    .filter(Boolean);
  if (!formattedItems.length) {
    return "";
  }
  return truncateText(
    [
      "MCP context:",
      outcome?.toolName ? `Tool used: ${outcome.toolName}` : "",
      outcome?.usedFallback ? "The configured MCP tool failed, so Zotero-WebAI selected this read-only fallback tool from tools/list." : "",
      "Use the following MCP tool output as external/local Zotero context for this conversation. Separate MCP evidence from paper evidence, and mention uncertainty when the MCP output is incomplete.",
      ...formattedItems,
    ].join("\n\n"),
    MCP_CONTEXT_TEXT_LIMIT,
  );
}

function formatMCPPromptItem(
  result: MCPToolResultItem,
  index: number,
): string {
  const headerParts = [
    `${index + 1}. ${result.title?.trim() || "MCP result"}`,
    result.year?.trim() ? `(${result.year.trim()})` : "",
    result.source?.trim() ? `[${result.source.trim()}]` : "",
  ].filter(Boolean);
  const lines = [headerParts.join(" ")];
  if (result.url?.trim()) {
    lines.push(`URL: ${result.url.trim()}`);
  }
  const content = truncateText(result.content || "", MCP_ITEM_TEXT_LIMIT);
  if (content) {
    lines.push(content);
  }
  return lines.join("\n").trim();
}

function buildWorkspacePrompt({
  contextSummary,
  mcpContext,
  message,
  scope,
  selectedSkill,
}: {
  contextSummary: AssembledContext | null;
  mcpContext: string;
  message: string;
  scope: ScopeContext | null;
  selectedSkill: WebAISkill | null;
}): string {
  const instruction = message.trim();
  if (!selectedSkill && !instruction) {
    throw new Error("Write a message or choose a custom skill with /.");
  }

  const title = scope?.label || "Current Zotero context";
  const metadata = contextSummary?.metadata || "";
  const selectedText =
    scope?.selectedText?.trim() || contextSummary?.selectedText?.trim() || "";
  const fullText = truncateText(contextSummary?.fullText || "", PROMPT_TEXT_LIMIT);
  const parts = [
    selectedSkill
      ? `Skill: ${selectedSkill.label}\n${selectedSkill.promptPrefix}`
      : "",
    instruction ? `User message:\n${instruction}` : "",
    `Zotero context:\n${title}`,
    metadata ? `Metadata:\n${metadata}` : "",
    selectedText ? `Selected passage:\n${selectedText}` : "",
    fullText ? `Paper content:\n${fullText}` : "",
    mcpContext,
  ];

  if (contextSummary?.fullText && contextSummary.fullText.length > fullText.length) {
    parts.push(
      "Note: the paper text was truncated by Zotero-WebAI; continue from the available excerpt first.",
    );
  }

  return parts.filter(Boolean).join("\n\n");
}

function truncateText(text: string, limit: number): string {
  const normalized = text.trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}\n\n[Truncated by Zotero-WebAI]`;
}

function safeJSONStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function stableHash(value: string): string {
  let hash = 5381;
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 33) ^ value.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function copyTextToClipboard(text: string): void {
  try {
    Zotero.Utilities.Internal.copyTextToClipboard(text);
    return;
  } catch {
    // Fall through to platform clipboard helper.
  }

  const componentClasses = Components.classes as Record<
    string,
    { getService: (interfaceType: unknown) => nsIClipboardHelper }
  >;
  const clipboardHelper = componentClasses[
    "@mozilla.org/widget/clipboardhelper;1"
  ].getService(Components.interfaces.nsIClipboardHelper);
  clipboardHelper.copyString(text);
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: "flex",
    flex: "1 1 auto",
    flexDirection: "column",
    gap: "8px",
    minHeight: 0,
    minWidth: 0,
    width: "100%",
  },
  frameHost: {
    border: "1px solid #e0e0e0",
    borderRadius: "6px",
    display: "flex",
    flex: "1 1 460px",
    minHeight: "360px",
    minWidth: 0,
    overflow: "hidden",
  },
  frameToolbar: {
    alignItems: "center",
    display: "flex",
    flex: "0 0 auto",
    flexWrap: "wrap",
    gap: "6px",
    justifyContent: "space-between",
    minWidth: 0,
  },
  serviceBar: {
    display: "flex",
    flex: "1 1 180px",
    flexWrap: "wrap",
    gap: "6px",
    minWidth: 0,
  },
  serviceButton: {
    appearance: "none",
    border: "1px solid #c9c9c9",
    borderRadius: "16px",
    cursor: "pointer",
    fontSize: typography.label,
    fontWeight: 600,
    minHeight: "28px",
    padding: "4px 10px",
    whiteSpace: "nowrap",
  },
  frameActions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
  },
  miniButton: {
    appearance: "none",
    border: "1px solid #c9c9c9",
    borderRadius: "14px",
    cursor: "pointer",
    fontSize: typography.label,
    fontWeight: 500,
    minHeight: "26px",
    padding: "3px 9px",
    whiteSpace: "nowrap",
  },
  composerPanel: {
    border: "1px solid #e0e0e0",
    borderRadius: "20px",
    display: "flex",
    flex: "0 0 auto",
    flexDirection: "column",
    gap: "7px",
    padding: "10px 12px",
    position: "relative",
  },
  slashMenu: {
    border: "1px solid #e0e0e0",
    borderRadius: "10px",
    bottom: "calc(100% + 6px)",
    boxShadow: "0 8px 24px rgba(0, 0, 0, 0.12)",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    left: "10px",
    maxHeight: "220px",
    overflow: "auto",
    padding: "6px",
    position: "absolute",
    right: "10px",
    zIndex: 2,
  },
  skillOption: {
    alignItems: "center",
    appearance: "none",
    background: "transparent",
    border: 0,
    borderRadius: "8px",
    cursor: "pointer",
    display: "flex",
    gap: "8px",
    justifyContent: "space-between",
    minHeight: "32px",
    padding: "6px 8px",
    textAlign: "left",
    width: "100%",
  },
  skillOptionTitle: {
    fontSize: typography.body,
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  skillOptionCommand: {
    flexShrink: 0,
    fontSize: typography.meta,
  },
  selectedSkill: {
    alignSelf: "flex-start",
    appearance: "none",
    border: "1px solid #d6e5f4",
    borderRadius: "14px",
    cursor: "pointer",
    fontSize: typography.label,
    fontWeight: 600,
    maxWidth: "100%",
    overflow: "hidden",
    padding: "3px 8px",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  composerInput: {
    border: 0,
    boxSizing: "border-box",
    font: "inherit",
    fontSize: typography.body,
    lineHeight: 1.45,
    maxHeight: "180px",
    minHeight: "48px",
    outline: "none",
    padding: "2px 0",
    resize: "vertical",
    width: "100%",
  },
  composerFooter: {
    alignItems: "center",
    display: "flex",
    gap: "8px",
    justifyContent: "space-between",
    minWidth: 0,
  },
  status: {
    flex: "1 1 auto",
    fontSize: typography.meta,
    lineHeight: 1.35,
    minHeight: "18px",
    minWidth: 0,
    overflow: "hidden",
    overflowWrap: "anywhere",
    textOverflow: "ellipsis",
  },
  sendButton: {
    appearance: "none",
    border: "1px solid #d6e5f4",
    borderRadius: "999px",
    cursor: "pointer",
    flex: "0 0 auto",
    fontSize: typography.label,
    fontWeight: 700,
    minHeight: "34px",
    minWidth: "64px",
    padding: "5px 14px",
  },
};
