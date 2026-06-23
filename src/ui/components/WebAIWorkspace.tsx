import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AssembledContext } from "../../services/contextAssembler";
import {
  callMCPToolDetailed,
  listMCPTools,
  type MCPToolDetailedCallOutcome,
  type MCPToolDetailedResult,
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
type WebAICommandKind = "mcp" | "pdf" | "skill" | "web";

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
  description?: string;
  id: string;
  kind: WebAICommandKind;
  label: string;
  promptPrefix: string;
  slashCommand: string;
}

interface PromptInsertResult {
  method?: string;
  ok: boolean;
  reason?: string;
  submitted?: boolean;
}

interface MCPPromptContextResult {
  contextText: string;
  status: string | null;
}

type WebAIExecutionKind =
  | "assistant"
  | "mcp"
  | "pdf"
  | "skill"
  | "web"
  | "error";

interface WebAIExecutionRecord {
  body: string;
  createdAt: string;
  id: string;
  kind: WebAIExecutionKind;
  sourcePrompt?: string;
  status: "done" | "error" | "running";
  subtitle?: string;
  thinking?: string;
  title: string;
}

type WebAIExecutionRecordDraft = Omit<
  WebAIExecutionRecord,
  "createdAt" | "id"
>;

interface AssistantReplyRecordOptions {
  kind?: WebAIExecutionKind;
  sourcePrompt?: string;
  subtitle?: string;
  title?: string;
}

interface WebSearchPromptContextResult {
  contextText: string;
  query: string;
  status: string | null;
}

interface WebSearchResult {
  snippet: string;
  title: string;
  url: string;
}

interface WebChatTextResult {
  ok: boolean;
  reason?: string;
  text?: string;
}

interface AssistantCaptureParts {
  body: string;
  thinking?: string;
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
const MCP_BRIDGE_SCAN_TEXT_LIMIT = 120000;
const MCP_BRIDGE_POLL_MS = 900;
const EXECUTION_RECORD_LIMIT = 24;
const WEB_SEARCH_RESULT_LIMIT = 6;
const WEB_SEARCH_CONTEXT_TEXT_LIMIT = 7000;
const WEBAI_NOTE_TITLE = "Zotero WebAI Notes";
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
const ZOTERO_MCP_COMMAND: WebAISkill = {
  description: "Load zotero-mcp tools for this conversation",
  id: "zotero-mcp",
  kind: "mcp",
  label: "Zotero MCP",
  promptPrefix: "",
  slashCommand: "zotero-mcp",
};
const CURRENT_PDF_COMMAND: WebAISkill = {
  description: "Attach current PDF or item full text to this prompt",
  id: "current-pdf",
  kind: "pdf",
  label: "Current PDF",
  promptPrefix: "",
  slashCommand: "pdf",
};
const WEB_SEARCH_COMMAND: WebAISkill = {
  description: "Search the web and attach results to this prompt",
  id: "web-search",
  kind: "web",
  label: "Web Search",
  promptPrefix: "",
  slashCommand: "websearch",
};

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
  const [historyVisible, setHistoryVisible] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [zaiLoginMode, setZaiLoginMode] = useState(false);
  const [executionRecords, setExecutionRecords] = useState<
    WebAIExecutionRecord[]
  >([]);
  const frameHostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<Element | null>(null);
  const activeMCPBridgeTokensRef = useRef<Set<string>>(new Set());
  const assistantCaptureRunRef = useRef(0);
  const handledMCPRequestsRef = useRef<Set<string>>(new Set());
  const lastCapturedAssistantTextRef = useRef("");
  const theme = getSidebarTheme(hostWindow);

  const appendExecutionRecord = (
    draft: WebAIExecutionRecordDraft,
  ): string => {
    const record = createExecutionRecord(draft);
    setExecutionRecords((current) =>
      [record, ...current].slice(0, EXECUTION_RECORD_LIMIT),
    );
    return record.id;
  };

  const customSkills = useMemo(
    () => buildCustomSkills(customPresets),
    [customPresets],
  );
  const slashCommands = useMemo(
    () => [CURRENT_PDF_COMMAND, WEB_SEARCH_COMMAND, ZOTERO_MCP_COMMAND, ...customSkills],
    [customSkills],
  );
  const selectedSkill =
    slashCommands.find((skill) => skill.id === selectedSkillID) || null;
  const slashQuery = getSlashQuery(message);
  const slashSuggestions = slashQuery
    ? filterSlashSkills(slashCommands, slashQuery.query)
    : [];
  const showSlashMenu = Boolean(slashQuery && slashSuggestions.length > 0);
  const isZAILoginMode = service.id === "zai" && zaiLoginMode;

  useEffect(() => {
    if (selectedSkillID && !slashCommands.some((skill) => skill.id === selectedSkillID)) {
      setSelectedSkillID(null);
    }
  }, [selectedSkillID, slashCommands]);

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
    setStatus(
      service.id === "zai"
        ? "Loaded Z.ai Web. Use Login Mode or Login Window if captcha needs more room."
        : `Loaded ${service.label}. Sign in, then Send inserts prompts into the web chat.`,
    );
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
            appendExecutionRecord,
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

  const recordAssistantReply = (
    captured: string,
    options: AssistantReplyRecordOptions = {},
  ) => {
    const normalized = normalizeAssistantCapture(captured, options.sourcePrompt);
    const dedupeKey = [normalized.body, normalized.thinking || ""].join("\n\n");
    if (!normalized.body || dedupeKey === lastCapturedAssistantTextRef.current) {
      return false;
    }
    lastCapturedAssistantTextRef.current = dedupeKey;
    appendExecutionRecord({
      body: normalized.body,
      kind: options.kind || "assistant",
      sourcePrompt: options.sourcePrompt,
      status: "done",
      subtitle: options.subtitle || service.label,
      thinking: normalized.thinking,
      title: options.title || "Captured web answer",
    });
    return true;
  };

  const waitForAssistantReply = async (
    baselineText?: string,
    options?: AssistantReplyRecordOptions,
  ) => {
    const runId = ++assistantCaptureRunRef.current;
    try {
      setStatus(`Waiting for ${service.label} answer...`);
      const captured = await waitForStableAssistantText(
        frameRef.current,
        baselineText || "",
        () => runId === assistantCaptureRunRef.current,
        options?.sourcePrompt,
      );
      if (!captured || runId !== assistantCaptureRunRef.current) {
        return;
      }
      if (recordAssistantReply(captured, options)) {
        setStatus(`Captured latest ${service.label} answer into Zotero WebAI.`);
      }
    } catch (error) {
      ztoolkit.log("Web AI automatic capture failed:", error);
      if (runId === assistantCaptureRunRef.current) {
        setStatus(
          `Prompt sent. If the answer is not captured automatically, click Capture.`,
        );
      }
    }
  };

  const deliverPrompt = async (
    prompt: string,
    statusPrefix?: string | null,
    captureOptions?: AssistantReplyRecordOptions,
  ) => {
    const baselineText = await readWebChatText(frameRef.current)
      .then((result) => (result.ok ? result.text || "" : ""))
      .catch(() => "");
    copyTextToClipboard(prompt);
    const result = await insertPromptIntoWebChat(frameRef.current, prompt, true);
    focusFrame(frameRef.current);
    const nextCaptureOptions = {
      ...captureOptions,
      sourcePrompt: captureOptions?.sourcePrompt || prompt,
    };
    if (result.ok && result.submitted) {
      setStatus(
        `${statusPrefix ? `${statusPrefix} ` : ""}Prompt sent to ${service.label}; waiting for result.`,
      );
      void waitForAssistantReply(baselineText, nextCaptureOptions);
    } else if (result.ok) {
      setStatus(
        `${statusPrefix ? `${statusPrefix} ` : ""}Prompt inserted into ${service.label}. Send it in the web chat, then click Capture if needed.`,
      );
    } else {
      setStatus(
        `${statusPrefix ? `${statusPrefix} ` : ""}Prompt copied (${prompt.length} characters). If it did not appear in ${service.label}, click the web chat box and paste.`,
      );
    }
    setIsError(false);
  };

  const copyRecord = (record: WebAIExecutionRecord) => {
    copyTextToClipboard(record.body);
    setStatus(`Copied ${record.title}.`);
    setIsError(false);
  };

  const regenerateRecord = async (record: WebAIExecutionRecord) => {
    if (record.kind === "web") {
      const query = record.sourcePrompt || record.title.replace(/^Web search:\s*/i, "");
      await fetchWebSearchContextForConversation({
        appendExecutionRecord,
        contextSummary,
        message: query,
        scope,
        selectedSkill,
        setStatus,
      });
      setIsError(false);
      return;
    }
    if (record.kind === "pdf") {
      const reusablePrompt =
        record.sourcePrompt?.includes(
          `Command: /${CURRENT_PDF_COMMAND.slashCommand}`,
        ) && record.sourcePrompt.includes("Paper content:")
          ? record.sourcePrompt
          : "";
      if (!reusablePrompt && !contextSummary?.fullText?.trim()) {
        throw new Error(
          contextSummary?.blockingMessage ||
            "Current PDF or Zotero item full text is unavailable.",
        );
      }
      const prompt =
        reusablePrompt ||
        buildWorkspacePrompt({
          contextSummary,
          includeFullText: true,
          mcpContext: "",
          message: record.sourcePrompt || "",
          scope,
          selectedSkill: CURRENT_PDF_COMMAND,
          webContext: "",
        });
      await deliverPrompt(prompt, `Regenerating ${record.title}.`, {
        ...buildPDFReplyRecordOptions(service.label),
        sourcePrompt: prompt,
      });
      return;
    }

    const prompt =
      record.sourcePrompt && record.kind !== "skill"
        ? record.sourcePrompt
        : buildRegeneratePrompt(record);
    await deliverPrompt(prompt, `Regenerating ${record.title}.`, {
      kind: record.kind === "skill" ? "skill" : "assistant",
      sourcePrompt: prompt,
      subtitle: service.label,
      title: `Regenerated: ${record.title}`,
    });
  };

  const appendRecordToNote = async (record: WebAIExecutionRecord) => {
    const noteID = await appendResultToZoteroNote(scope, record);
    setStatus(`Appended ${record.title} to Zotero WebAI Notes (#${noteID}).`);
    setIsError(false);
  };

  const captureAssistantReply = async () => {
    const result = await readWebChatText(frameRef.current);
    if (!result.ok || !result.text?.trim()) {
      throw new Error(result.reason || "No web chat text available");
    }
    const captured = extractLatestAssistantText(result.text);
    if (!captured) {
      throw new Error("No assistant result found in the embedded web chat");
    }
    recordAssistantReply(
      captured,
      buildCommandReplyRecordOptions(selectedSkill, service.label),
    );
    setStatus(`Captured latest ${service.label} answer into Zotero WebAI.`);
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
    setStatus(formatSlashCommandStatus(skill));
    setIsError(false);
  };

  const selectService = (candidate: WebAIService) => {
    setService(candidate);
    setZaiLoginMode(candidate.id === "zai");
  };

  const openServiceLoginWindow = () => {
    openLoginWindow(hostWindow, service);
    setStatus(
      `Opened a larger ${service.label} login window. After sign-in, return here and reload if needed.`,
    );
    setIsError(false);
  };

  const enterZAILoginMode = () => {
    setChatCollapsed(false);
    setZaiLoginMode(true);
    setStatus("Z.ai Login Mode gives the captcha the full sidebar height.");
    setIsError(false);
  };

  const exitZAILoginMode = () => {
    setChatCollapsed(false);
    setZaiLoginMode(false);
    setStatus("Z.ai Chat Mode restored. Send inserts prompts into the web chat.");
    setIsError(false);
  };

  const toggleChatFrame = () => {
    const nextCollapsed = !chatCollapsed;
    setChatCollapsed(nextCollapsed);
    setStatus(
      nextCollapsed
        ? `${service.label} display hidden. Click Show Chat to restore it.`
        : `${service.label} display restored.`,
    );
    setIsError(false);
  };

  const sendPrompt = async () => {
    const draftMessage = message;
    const resolved = resolveSkillFromMessage(draftMessage, slashCommands, selectedSkill);
    if (!resolved.skill && !resolved.message.trim()) {
      throw new Error("Write a message or choose a / command.");
    }
    setMessage("");
    setSelectedSkillID(null);
    const isMCPCommand = resolved.skill?.kind === "mcp";
    const isPDFCommand = resolved.skill?.kind === "pdf";
    const isWebSearchCommand = resolved.skill?.kind === "web";

    const promptInput = {
      contextSummary,
      message: resolved.message,
      scope,
      selectedSkill: resolved.skill,
    };
    if (isPDFCommand) {
      const pdfTextLength = contextSummary?.fullText?.trim().length || 0;
      appendExecutionRecord({
        body: formatPDFCommandExecutionBody({
          contextSummary,
          message: resolved.message,
          scope,
        }),
        kind: "pdf",
        sourcePrompt: resolved.message,
        status: pdfTextLength ? "done" : "error",
        subtitle: `/${CURRENT_PDF_COMMAND.slashCommand}`,
        title: "Current PDF command",
      });
      if (!pdfTextLength) {
        throw new Error(
          contextSummary?.blockingMessage ||
            "Current PDF or Zotero item full text is unavailable.",
        );
      }
    }
    if (resolved.skill?.kind === "skill") {
      appendExecutionRecord({
        body: formatSkillExecutionBody({
          contextSummary,
          message: resolved.message,
          scope,
          skill: resolved.skill,
        }),
        kind: "skill",
        sourcePrompt: resolved.message,
        status: "done",
        subtitle: `/${resolved.skill.slashCommand}`,
        title: `Skill: ${resolved.skill.label}`,
      });
    }
    const mcpBridgeToken = isMCPCommand && shouldUseMCPInConversation(settings)
      ? createMCPBridgeToken()
      : "";
    const shouldUseWebSearch =
      isWebSearchCommand || webSearchEnabled || shouldAutoUseWebSearch(resolved.message);
    const webContext = shouldUseWebSearch
      ? await fetchWebSearchContextForConversation({
          appendExecutionRecord,
          ...promptInput,
          setStatus,
        })
      : { contextText: "", query: "", status: null };
    const mcpContext = isMCPCommand
      ? await fetchMCPContextForConversation(settings, {
          mcpBridgeToken,
          setStatus,
        })
      : { contextText: "", status: null };
    if (isMCPCommand) {
      appendExecutionRecord({
        body: formatMCPCommandExecutionBody({
          message: resolved.message,
          status: mcpContext.status,
        }),
        kind: "mcp",
        sourcePrompt: resolved.message,
        status: mcpContext.contextText ? "done" : "error",
        subtitle: `/${ZOTERO_MCP_COMMAND.slashCommand}`,
        title: "Zotero MCP command",
      });
      if (!mcpContext.contextText) {
        throw new Error(
          mcpContext.status || "MCP unavailable; check that zotero-mcp is running.",
        );
      }
    }
    if (mcpBridgeToken && mcpContext.contextText) {
      activeMCPBridgeTokensRef.current.add(mcpBridgeToken);
    }
    const prompt = buildWorkspacePrompt({
      ...promptInput,
      includeFullText: isPDFCommand,
      mcpContext: mcpContext.contextText,
      webContext: webContext.contextText,
    });
    await deliverPrompt(
      prompt,
      [webContext.status, mcpContext.status].filter(Boolean).join(" ") || null,
      {
        ...buildCommandReplyRecordOptions(resolved.skill, service.label),
        sourcePrompt: prompt,
      },
    );
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
          ...(isZAILoginMode ? styles.loginFrameHost : {}),
          ...(chatCollapsed ? styles.frameHostCollapsed : {}),
          background: theme.surfaceBackground,
          borderColor: theme.softBorder,
        }}
      />

      {isZAILoginMode ? (
        <div
          style={{
            ...styles.loginModeBar,
            background: theme.surfaceBackground,
            borderColor: theme.softBorder,
          }}
        >
          <div style={styles.loginModeText}>
            <span style={{ ...styles.loginModeTitle, color: theme.text }}>
              Z.ai Login Mode
            </span>
            <span
              style={{
                ...styles.loginModeHint,
                color: isError ? theme.errorText : theme.mutedText,
              }}
            >
              {status}
            </span>
          </div>
          <div style={styles.frameActions}>
            <button
              style={{
                ...styles.miniButton,
                background: chatCollapsed
                  ? theme.badgeBackground
                  : theme.surfaceBackground,
                borderColor: chatCollapsed ? theme.badgeBorder : theme.buttonBorder,
                color: chatCollapsed ? theme.badgeText : theme.buttonText,
              }}
              onClick={toggleChatFrame}
              type="button"
            >
              {chatCollapsed ? "Show Chat" : "Hide Chat"}
            </button>
            <button
              style={{
                ...styles.miniButton,
                ...styles.primaryMiniButton,
                background: theme.badgeBackground,
                borderColor: theme.badgeBorder,
                color: theme.badgeText,
              }}
              onClick={openServiceLoginWindow}
              type="button"
            >
              Login Window
            </button>
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
              onClick={exitZAILoginMode}
              type="button"
            >
              Chat Mode
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
              External
            </button>
          </div>
        </div>
      ) : (
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
              onClick={() => selectService(candidate)}
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
              background: chatCollapsed
                ? theme.badgeBackground
                : theme.surfaceBackground,
              borderColor: chatCollapsed ? theme.badgeBorder : theme.buttonBorder,
              color: chatCollapsed ? theme.badgeText : theme.buttonText,
            }}
            onClick={toggleChatFrame}
            type="button"
          >
            {chatCollapsed ? "Show Chat" : "Hide Chat"}
          </button>
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
          {service.id === "zai" && (
            <>
              <button
                style={{
                  ...styles.miniButton,
                  ...styles.primaryMiniButton,
                  background: theme.badgeBackground,
                  borderColor: theme.badgeBorder,
                  color: theme.badgeText,
                }}
                onClick={openServiceLoginWindow}
                type="button"
              >
                Login Window
              </button>
              <button
                style={{
                  ...styles.miniButton,
                  background: theme.surfaceBackground,
                  borderColor: theme.buttonBorder,
                  color: theme.buttonText,
                }}
                onClick={enterZAILoginMode}
                type="button"
              >
                Login Mode
              </button>
            </>
          )}
          <button
            style={{
              ...styles.miniButton,
              background: theme.surfaceBackground,
              borderColor: theme.buttonBorder,
              color: theme.buttonText,
            }}
            onClick={() => void runAction(captureAssistantReply)}
            type="button"
          >
            Capture
          </button>
          {executionRecords.length > 0 && (
            <button
              style={{
                ...styles.miniButton,
                background: theme.surfaceBackground,
                borderColor: theme.buttonBorder,
                color: theme.buttonText,
              }}
              onClick={() => setExecutionRecords([])}
              type="button"
            >
              Clear
            </button>
          )}
          <button
            style={{
              ...styles.miniButton,
              background: historyVisible
                ? theme.badgeBackground
                : theme.surfaceBackground,
              borderColor: historyVisible ? theme.badgeBorder : theme.buttonBorder,
              color: historyVisible ? theme.badgeText : theme.buttonText,
            }}
            onClick={() => setHistoryVisible((visible) => !visible)}
            type="button"
          >
            History
          </button>
          <button
            style={{
              ...styles.miniButton,
              background: webSearchEnabled
                ? theme.accentBackground
                : theme.surfaceBackground,
              borderColor: webSearchEnabled ? theme.accentBorder : theme.buttonBorder,
              color: webSearchEnabled ? theme.accentText : theme.buttonText,
            }}
            onClick={() => setWebSearchEnabled((enabled) => !enabled)}
            type="button"
          >
            Web Search
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
      )}

      {!isZAILoginMode && executionRecords.length > 0 && (
        <div
          style={{
            ...styles.executionPanel,
            background: theme.surfaceBackground,
            borderColor: theme.softBorder,
          }}
        >
          <div style={styles.executionHeader}>
            <span style={{ ...styles.executionTitle, color: theme.text }}>
              Results
            </span>
            <div style={styles.executionHeaderActions}>
              <span style={{ ...styles.executionMeta, color: theme.mutedText }}>
                {executionRecords.length} items
              </span>
            </div>
          </div>
          <div style={styles.resultsLayout}>
              {historyVisible && (
                <aside
                  style={{
                    ...styles.historyPanel,
                    borderColor: theme.softBorder,
                  }}
                >
                  <div style={styles.historyHeader}>
                    <span style={{ ...styles.historyTitle, color: theme.text }}>
                      History
                    </span>
                    <button
                      style={{
                        ...styles.inlineActionButton,
                        borderColor: theme.buttonBorder,
                        color: theme.buttonText,
                      }}
                      onClick={() => setHistoryVisible(false)}
                      type="button"
                    >
                      Hide
                    </button>
                  </div>
                  <div style={styles.historyList}>
                    {executionRecords.map((record) => (
                      <button
                        key={`history-${record.id}`}
                        style={{
                          ...styles.historyItem,
                          borderColor: theme.softBorder,
                          color: theme.text,
                        }}
                        onClick={() => copyRecord(record)}
                        type="button"
                      >
                        <span style={styles.historyItemTitle}>{record.title}</span>
                        <span
                          style={{
                            ...styles.historyItemMeta,
                            color: theme.mutedText,
                          }}
                        >
                          {formatRecordTimestamp(record.createdAt)}
                        </span>
                      </button>
                    ))}
                  </div>
                </aside>
              )}
              <div style={styles.executionList}>
                {executionRecords.map((record) => (
                  <article
                    key={record.id}
                    style={{
                      ...styles.executionItem,
                      borderColor:
                        record.status === "error"
                          ? theme.errorText
                          : theme.softBorder,
                    }}
                  >
                    <div style={styles.executionSummary}>
                      <span
                        style={{
                          ...styles.executionKind,
                          background:
                            record.kind === "mcp"
                              ? theme.accentBackground
                              : record.kind === "pdf"
                                ? theme.badgeBackground
                                : record.kind === "skill"
                                  ? theme.badgeBackground
                                  : record.kind === "web"
                                    ? theme.noticeBackground
                                    : theme.surfaceBackground,
                          borderColor: theme.buttonBorder,
                          color:
                            record.status === "error"
                              ? theme.errorText
                              : theme.text,
                        }}
                      >
                        {record.kind}
                      </span>
                      <span style={styles.executionSummaryText}>
                        <span
                          style={{
                            ...styles.executionItemTitle,
                            color: theme.text,
                          }}
                        >
                          {record.title}
                        </span>
                        {record.subtitle && (
                          <span
                            style={{
                              ...styles.executionItemSubtitle,
                              color: theme.mutedText,
                            }}
                          >
                            {record.subtitle}
                          </span>
                        )}
                      </span>
                    </div>
                    {record.thinking && (
                      <details style={styles.thinkingDetails}>
                        <summary
                          style={{
                            ...styles.thinkingSummary,
                            color: theme.mutedText,
                          }}
                        >
                          思考链 / Thinking
                        </summary>
                        <pre
                          style={{
                            ...styles.thinkingBody,
                            color: theme.mutedText,
                          }}
                        >
                          {record.thinking}
                        </pre>
                      </details>
                    )}
                    <pre style={{ ...styles.executionBody, color: theme.text }}>
                      {record.body}
                    </pre>
                    <div style={styles.recordActions}>
                      <button
                        style={{
                          ...styles.inlineActionButton,
                          borderColor: theme.buttonBorder,
                          color: theme.buttonText,
                        }}
                        onClick={() => copyRecord(record)}
                        type="button"
                      >
                        Copy
                      </button>
                      <button
                        style={{
                          ...styles.inlineActionButton,
                          borderColor: theme.buttonBorder,
                          color: theme.buttonText,
                        }}
                        onClick={() => void runAction(() => regenerateRecord(record))}
                        type="button"
                      >
                        Regenerate
                      </button>
                      <button
                        style={{
                          ...styles.inlineActionButton,
                          borderColor: theme.buttonBorder,
                          color: theme.buttonText,
                        }}
                        onClick={() => void runAction(() => appendRecordToNote(record))}
                        type="button"
                      >
                        Append Note
                      </button>
                    </div>
                  </article>
                ))}
              </div>
            </div>
        </div>
      )}

      {!isZAILoginMode && (
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
                <span style={styles.skillOptionText}>
                  <span style={styles.skillOptionTitle}>{skill.label}</span>
                  {skill.description && (
                    <span
                      style={{
                        ...styles.skillOptionDescription,
                        color: theme.mutedText,
                      }}
                    >
                      {skill.description}
                    </span>
                  )}
                </span>
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
            title="Clear selected command"
            type="button"
          >
            /{selectedSkill.slashCommand} {selectedSkill.label}
          </button>
        )}

        <textarea
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Message, or type / for PDF, Web Search, Zotero MCP, Skills"
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
              : "Type / for PDF, Web Search, Zotero MCP, or custom skills."}
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
      )}
    </section>
  );
};

function buildCustomSkills(customPresetsValue: string): WebAISkill[] {
  return parseCustomPresets(customPresetsValue).presets
    .filter((preset) => preset.label?.trim() && preset.promptPrefix?.trim())
    .map((preset) => {
      const label = String(preset.label || preset.id).trim();
      return {
        description: String(preset.description || "").trim(),
        id: preset.id,
        kind: "skill",
        label,
        promptPrefix: String(preset.promptPrefix || "").trim(),
        slashCommand: normalizeSlashCommand(
          preset.slashCommand || preset.label || preset.id,
        ),
      };
    });
}

function formatSlashCommandStatus(skill: WebAISkill): string {
  if (skill.kind === "pdf") {
    return "Current PDF selected. Send to attach the current PDF/item full text to this prompt.";
  }
  if (skill.kind === "web") {
    return "Web Search selected. Send to search the web and attach the results.";
  }
  if (skill.kind === "mcp") {
    return "Zotero MCP selected. Send to load zotero-mcp tools; the web model can request real tool calls.";
  }
  return `Skill /${skill.slashCommand} selected. Write your question and send.`;
}

function filterSlashSkills(skills: WebAISkill[], query: string): WebAISkill[] {
  const normalized = normalizeSlashCommand(query).toLowerCase();
  if (!normalized) {
    return skills.slice(0, 1000);
  }

  return skills
    .filter((skill) =>
      [skill.label, skill.slashCommand, skill.id, skill.description || ""]
        .join(" ")
        .toLowerCase()
        .includes(normalized),
    )
    .slice(0, 1000);
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
    browser.setAttribute("allowfullscreen", "true");
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
      "allow-pointer-lock",
      "allow-popups",
      "allow-popups-to-escape-sandbox",
      "allow-same-origin",
      "allow-scripts",
      "allow-storage-access-by-user-activation",
      "allow-top-navigation-by-user-activation",
    ].join(" "),
  );
  iframe.setAttribute("allow", "clipboard-read; clipboard-write; fullscreen");
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
  submit = false,
): Promise<PromptInsertResult> {
  if (!frame) {
    return { ok: false, reason: "web-frame-missing" };
  }

  const directResult = insertPromptDirectly(frame, prompt, submit);
  if (directResult.ok) {
    return directResult;
  }

  return insertPromptWithFrameScript(frame, prompt, submit);
}

function insertPromptDirectly(
  frame: Element,
  prompt: string,
  submit: boolean,
): PromptInsertResult {
  try {
    const doc = (frame as HTMLIFrameElement).contentWindow?.document;
    if (!doc) {
      return { ok: false, reason: "content-document-missing" };
    }
    return insertPromptIntoDocument(doc, prompt, "direct-dom", submit);
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
  submit: boolean,
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
  const source = buildPromptInsertFrameScript(messageName, prompt, submit);

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
  submit: boolean,
): string {
  return `
(function () {
  const messageName = ${JSON.stringify(messageName)};
  const prompt = ${JSON.stringify(prompt)};
  const submit = ${JSON.stringify(submit)};
  ${insertPromptIntoDocumentSource()}
  try {
    const result = insertPromptIntoDocument(content.document, prompt, "frame-script", submit);
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
  submit = false,
): PromptInsertResult {
  const composer = findWebChatComposer(doc);
  if (!composer) {
    return { ok: false, method, reason: "composer-not-found" };
  }
  writePromptToComposer(composer, prompt);
  const submitted = submit ? submitWebChatPrompt(doc, composer) : false;
  return { ok: true, method, submitted };
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

function submitWebChatPrompt(doc: Document, composer: HTMLElement): boolean {
  const buttons = Array.from(
    doc.querySelectorAll("button, [role='button']"),
  ) as HTMLElement[];
  const visibleButtons = buttons
    .filter(isVisibleSubmitCandidate)
    .sort((left, right) => scoreSubmitCandidate(right) - scoreSubmitCandidate(left));
  const submitButton = visibleButtons[0] || null;
  if (submitButton) {
    submitButton.click();
    return true;
  }

  const win = doc.defaultView;
  try {
    composer.dispatchEvent(
      new (win?.KeyboardEvent || KeyboardEvent)("keydown", {
        bubbles: true,
        cancelable: true,
        code: "Enter",
        key: "Enter",
      }),
    );
    composer.dispatchEvent(
      new (win?.KeyboardEvent || KeyboardEvent)("keyup", {
        bubbles: true,
        cancelable: true,
        code: "Enter",
        key: "Enter",
      }),
    );
    return true;
  } catch {
    return false;
  }
}

function isVisibleSubmitCandidate(element: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  const doc = element.ownerDocument;
  if (!doc) {
    return false;
  }
  const style = doc.defaultView?.getComputedStyle(element);
  const label = [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.textContent,
  ]
    .join(" ")
    .toLowerCase();
  const disabled =
    element.hasAttribute("disabled") ||
    element.getAttribute("aria-disabled") === "true";
  return Boolean(
    !disabled &&
      rect.width >= 18 &&
      rect.height >= 18 &&
      style?.display !== "none" &&
      style?.visibility !== "hidden" &&
      !element.closest("[aria-hidden='true']") &&
      /(send|submit|发送|送出|arrow|paper|chat)/i.test(label),
  );
}

function scoreSubmitCandidate(element: HTMLElement): number {
  const rect = element.getBoundingClientRect();
  const label = [
    element.getAttribute("aria-label"),
    element.getAttribute("title"),
    element.textContent,
  ]
    .join(" ")
    .toLowerCase();
  let score = rect.bottom * 10 + rect.right;
  if (/(send|发送|submit)/i.test(label)) score += 100000;
  if (/(arrow|paper|plane)/i.test(label)) score += 20000;
  if (element.tagName.toLowerCase() === "button") score += 10000;
  return score;
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
${submitWebChatPrompt.toString()}
${isVisibleSubmitCandidate.toString()}
${scoreSubmitCandidate.toString()}
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

function openLoginWindow(hostWindow: Window, service: WebAIService): void {
  const features =
    "chrome,centerscreen,resizable,scrollbars,width=1120,height=840";
  const name = `zotero-webai-${service.id}-login`;

  try {
    const opened = hostWindow.open(service.url, name, features);
    if (opened) {
      opened.focus?.();
      return;
    }
  } catch (error) {
    ztoolkit.log("window.open login window failed:", error);
  }

  try {
    const componentClasses = Components.classes as Record<
      string,
      { getService: (interfaceType: unknown) => { openWindow?: (...args: unknown[]) => Window | null } }
    >;
    const windowWatcher = componentClasses[
      "@mozilla.org/embedcomp/window-watcher;1"
    ].getService(Components.interfaces.nsIWindowWatcher);
    const opened = windowWatcher.openWindow?.(
      hostWindow,
      service.url,
      name,
      features,
      null,
    );
    if (opened) {
      opened.focus?.();
      return;
    }
  } catch (error) {
    ztoolkit.log("window watcher login window failed:", error);
  }

  openExternalURL(service.url);
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
  appendExecutionRecord,
  deliverPrompt,
  request,
  serviceLabel,
  settings,
  setStatus,
}: {
  appendExecutionRecord: (draft: WebAIExecutionRecordDraft) => string;
  deliverPrompt: (prompt: string, statusPrefix?: string | null) => Promise<void>;
  request: MCPBridgeRequest;
  serviceLabel: string;
  settings: Settings;
  setStatus: (status: string) => void;
}): Promise<void> {
  try {
    setStatus(`Running Zotero MCP tool ${request.toolName}...`);
    const detailed = await callMCPToolDetailed(
      settings,
      request.toolName,
      request.arguments,
    );
    appendExecutionRecord({
      body: formatMCPDetailedRecordBody(detailed, {
        arguments: request.arguments,
      }),
      kind: "mcp",
      status: "done",
      subtitle: `tools/call ${request.toolName}`,
      title: `MCP result: ${request.toolName}`,
    });
    const prompt = formatMCPBridgeResultPrompt(request, detailed.results);
    await deliverPrompt(
      prompt,
      `MCP ${request.toolName} result inserted into ${serviceLabel}.`,
    );
  } catch (error) {
    const message =
      error instanceof Error && error.message ? error.message : String(error);
    const prompt = [
      "Zotero WebAI MCP tool error:",
      `Tool: ${request.toolName}`,
      `Arguments: ${safeJSONStringify(request.arguments)}`,
      `Error: ${message}`,
      "",
      "Please revise the MCP request if another Zotero tool or different arguments are needed, or continue without this tool if enough context is available.",
    ].join("\n");
    appendExecutionRecord({
      body: prompt,
      kind: "error",
      status: "error",
      subtitle: `tools/call ${request.toolName}`,
      title: `MCP failed: ${request.toolName}`,
    });
    await deliverPrompt(prompt, `MCP ${request.toolName} failed.`);
  }
}

function formatMCPBridgeResultPrompt(
  request: MCPBridgeRequest,
  results: MCPToolResultItem[],
): string {
  const resultText =
    formatMCPPromptContext(results, {
      toolName: request.toolName,
      usedFallback: false,
    }) || "MCP tool returned no structured or text content.";
  return [
    "Zotero WebAI MCP tool result:",
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
    mcpBridgeToken,
    setStatus,
  }: {
    mcpBridgeToken: string;
    setStatus: (status: string) => void;
  },
): Promise<MCPPromptContextResult> {
  if (!shouldUseMCPInConversation(settings)) {
    return {
      contextText: "",
      status: "MCP endpoint is not configured.",
    };
  }

  try {
    setStatus("Loading zotero-mcp tools for this / command...");
    const tools = await listMCPTools(settings);
    const planningContext = buildMCPPlanningContext(tools, mcpBridgeToken);
    return {
      contextText: planningContext,
      status: tools.length
        ? `MCP tool schema loaded (${tools.length} tools).`
        : "MCP returned no tool schema.",
    };
  } catch (error) {
    ztoolkit.log("MCP tool schema unavailable for Web AI prompt:", error);
    return {
      contextText: "",
      status: "MCP unavailable; check that zotero-mcp is running.",
    };
  }
}

function shouldUseMCPInConversation(settings: Settings): boolean {
  return Boolean(settings.mcpEndpoint?.trim());
}

function buildMCPPlanningContext(
  tools: MCPToolSummary[],
  mcpBridgeToken: string,
): string {
  const catalog = formatMCPToolCatalog(tools);
  return [
    "Zotero MCP bridge:",
    "The user explicitly selected /zotero-mcp. Zotero WebAI can run local zotero-mcp tools for this conversation; decide whether a tool is needed and choose schema-valid arguments.",
    "If Zotero MCP is needed, do not invent the tool result. Reply only with an MCP request block using the markers named below. Zotero WebAI will execute it and insert the result back into this chat.",
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
  outcome?: Pick<MCPToolDetailedCallOutcome, "toolName" | "usedFallback">,
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
      outcome?.usedFallback ? "The configured MCP tool failed, so Zotero WebAI selected this read-only fallback tool from tools/list." : "",
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
  includeFullText,
  mcpContext,
  message,
  scope,
  selectedSkill,
  webContext,
}: {
  contextSummary: AssembledContext | null;
  includeFullText: boolean;
  mcpContext: string;
  message: string;
  scope: ScopeContext | null;
  selectedSkill: WebAISkill | null;
  webContext: string;
}): string {
  const instruction = message.trim();
  if (!selectedSkill && !instruction) {
    throw new Error("Write a message or choose a custom skill with /.");
  }

  const title = scope?.label || "Current Zotero context";
  const metadata = contextSummary?.metadata || "";
  const selectedText =
    scope?.selectedText?.trim() || contextSummary?.selectedText?.trim() || "";
  const fullText = includeFullText
    ? truncateText(contextSummary?.fullText || "", PROMPT_TEXT_LIMIT)
    : "";
  const commandInstruction = formatCommandPromptInstruction(
    selectedSkill,
    includeFullText,
  );
  const fallbackInstruction =
    !instruction && selectedSkill?.kind === "pdf"
      ? "Summarize the current PDF, extract the key findings, methods, limitations, and useful notes for Zotero."
      : !instruction && selectedSkill?.kind === "web"
        ? "Use the web search context to answer with concise citations."
        : "";
  const parts = [
    commandInstruction,
    instruction || fallbackInstruction
      ? `User message:\n${instruction || fallbackInstruction}`
      : "",
    `Zotero context:\n${title}`,
    metadata ? `Metadata:\n${metadata}` : "",
    selectedText ? `Selected passage:\n${selectedText}` : "",
    fullText ? `Paper content:\n${fullText}` : "",
    webContext,
    mcpContext,
  ];

  if (
    includeFullText &&
    contextSummary?.fullText &&
    contextSummary.fullText.length > fullText.length
  ) {
    parts.push(
      "Note: the paper text was truncated by Zotero WebAI; continue from the available excerpt first.",
    );
  }

  return parts.filter(Boolean).join("\n\n");
}

function formatCommandPromptInstruction(
  selectedSkill: WebAISkill | null,
  includeFullText: boolean,
): string {
  if (!selectedSkill) {
    return "";
  }
  if (selectedSkill.kind === "skill") {
    return `Skill: ${selectedSkill.label}\n${selectedSkill.promptPrefix}`;
  }
  if (selectedSkill.kind === "pdf") {
    return [
      `Command: /${selectedSkill.slashCommand}`,
      includeFullText
        ? "The user explicitly attached the current Zotero PDF or item full text. Treat the Paper content section as the primary source."
        : "The user selected the PDF command, but no full text was attached.",
    ].join("\n");
  }
  if (selectedSkill.kind === "web") {
    return [
      `Command: /${selectedSkill.slashCommand}`,
      "The user explicitly requested built-in web search. Use the Web search context below when it is available, cite URLs when relying on it, and separate web context from Zotero context.",
    ].join("\n");
  }
  if (selectedSkill.kind === "mcp") {
    return `Command: /${selectedSkill.slashCommand}\nUse zotero-mcp only when a real local Zotero tool result is needed. If a tool is needed, request it through the MCP bridge instructions below.`;
  }
  return "";
}

function createExecutionRecord(
  draft: WebAIExecutionRecordDraft,
): WebAIExecutionRecord {
  return {
    ...draft,
    createdAt: new Date().toISOString(),
    id: `exec-${Date.now().toString(36)}-${Math.random()
      .toString(36)
      .slice(2, 8)}`,
  };
}

function formatSkillExecutionBody({
  contextSummary,
  message,
  scope,
  skill,
}: {
  contextSummary: AssembledContext | null;
  message: string;
  scope: ScopeContext | null;
  skill: WebAISkill;
}): string {
  const selectedText =
    scope?.selectedText?.trim() || contextSummary?.selectedText?.trim() || "";
  return [
    `Skill: ${skill.label}`,
    `Command: /${skill.slashCommand}`,
    "",
    "Skill instruction:",
    skill.promptPrefix,
    message.trim() ? `\nUser message:\n${message.trim()}` : "",
    scope?.label ? `\nZotero context:\n${scope.label}` : "",
    contextSummary?.metadata ? `\nMetadata:\n${contextSummary.metadata}` : "",
    selectedText ? `\nSelected passage:\n${truncateText(selectedText, 2400)}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildSkillReplyRecordOptions(
  skill: WebAISkill,
  serviceLabel: string,
): AssistantReplyRecordOptions {
  return {
    kind: "skill",
    subtitle: `/${skill.slashCommand} via ${serviceLabel}`,
    title: `Skill result: ${skill.label}`,
  };
}

function buildCommandReplyRecordOptions(
  skill: WebAISkill | null,
  serviceLabel: string,
): AssistantReplyRecordOptions {
  if (!skill) {
    return {};
  }
  if (skill.kind === "skill") {
    return buildSkillReplyRecordOptions(skill, serviceLabel);
  }
  if (skill.kind === "mcp") {
    return buildMCPReplyRecordOptions(serviceLabel);
  }
  if (skill.kind === "pdf") {
    return buildPDFReplyRecordOptions(serviceLabel);
  }
  if (skill.kind === "web") {
    return {
      kind: "assistant",
      subtitle: `/${WEB_SEARCH_COMMAND.slashCommand} via ${serviceLabel}`,
      title: "Web-search answer",
    };
  }
  return {};
}

function buildPDFReplyRecordOptions(
  serviceLabel: string,
): AssistantReplyRecordOptions {
  return {
    kind: "pdf",
    subtitle: `/${CURRENT_PDF_COMMAND.slashCommand} via ${serviceLabel}`,
    title: "PDF-assisted answer",
  };
}

function buildMCPReplyRecordOptions(
  serviceLabel: string,
): AssistantReplyRecordOptions {
  return {
    kind: "mcp",
    subtitle: `/${ZOTERO_MCP_COMMAND.slashCommand} via ${serviceLabel}`,
    title: "MCP-assisted answer",
  };
}

function formatMCPCommandExecutionBody({
  message,
  status,
}: {
  message: string;
  status: string | null;
}): string {
  return [
    `Command: /${ZOTERO_MCP_COMMAND.slashCommand}`,
    status ? `Status: ${status}` : "",
    "",
    message.trim() ? `User message:\n${message.trim()}` : "",
    "The web model received the zotero-mcp tool catalog and can request real tools by emitting a ZOTERO_WEBAI_MCP_REQUEST block.",
  ]
    .filter(Boolean)
    .join("\n");
}

function formatPDFCommandExecutionBody({
  contextSummary,
  message,
  scope,
}: {
  contextSummary: AssembledContext | null;
  message: string;
  scope: ScopeContext | null;
}): string {
  const fullTextLength = contextSummary?.fullText?.trim().length || 0;
  const attachedLength = Math.min(fullTextLength, PROMPT_TEXT_LIMIT);
  const selectedText =
    scope?.selectedText?.trim() || contextSummary?.selectedText?.trim() || "";
  return [
    `Command: /${CURRENT_PDF_COMMAND.slashCommand}`,
    fullTextLength
      ? `Status: attached ${attachedLength} of ${fullTextLength} characters from the current PDF/item full text.`
      : "Status: current PDF/item full text unavailable.",
    contextSummary?.fullTextSource
      ? `Source: ${contextSummary.fullTextSource}`
      : "",
    scope?.label ? `Zotero context: ${scope.label}` : "",
    message.trim() ? `User message:\n${message.trim()}` : "",
    selectedText
      ? `Selected passage:\n${truncateText(selectedText, 2400)}`
      : "",
    contextSummary?.blockingMessage
      ? `Blocking message: ${contextSummary.blockingMessage}`
      : "",
    contextSummary?.warnings?.length
      ? `Warnings:\n${contextSummary.warnings.join("\n")}`
      : "",
    fullTextLength > PROMPT_TEXT_LIMIT
      ? "Note: the paper text will be truncated in the prompt."
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}

function formatMCPDetailedRecordBody(
  result: MCPToolDetailedResult,
  options?: {
    arguments?: Record<string, unknown>;
    usedFallback?: boolean;
  },
): string {
  const resultText =
    formatMCPPromptContext(result.results, {
      toolName: result.toolName,
      usedFallback: Boolean(options?.usedFallback),
    }) ||
    result.text ||
    "MCP tool returned no structured or text content.";
  return [
    `Tool: ${result.toolName}`,
    options?.arguments
      ? `Arguments:\n${safeJSONStringify(options.arguments)}`
      : "",
    options?.usedFallback ? "Mode: automatic fallback" : "",
    "",
    resultText,
  ]
    .filter(Boolean)
    .join("\n");
}

async function fetchWebSearchContextForConversation({
  appendExecutionRecord,
  contextSummary,
  message,
  scope,
  selectedSkill,
  setStatus,
}: {
  appendExecutionRecord: (draft: WebAIExecutionRecordDraft) => string;
  contextSummary: AssembledContext | null;
  message: string;
  scope: ScopeContext | null;
  selectedSkill: WebAISkill | null;
  setStatus: (status: string) => void;
}): Promise<WebSearchPromptContextResult> {
  const query = buildWebSearchQuery({
    contextSummary,
    message,
    scope,
    selectedSkill,
  });
  if (!query) {
    return { contextText: "", query: "", status: null };
  }

  try {
    setStatus(`Searching web: ${query}`);
    const results = await searchWeb(query);
    const body = formatWebSearchRecordBody(query, results);
    appendExecutionRecord({
      body,
      kind: "web",
      sourcePrompt: query,
      status: results.length ? "done" : "error",
      subtitle: `${results.length} web results`,
      title: `Web search: ${query}`,
    });
    return {
      contextText: results.length
        ? formatWebSearchPromptContext(query, results)
        : "",
      query,
      status: results.length
        ? `Web search added (${results.length} results).`
        : "Web search returned no readable results.",
    };
  } catch (error) {
    const messageText =
      error instanceof Error && error.message ? error.message : String(error);
    appendExecutionRecord({
      body: `Query: ${query}\n\n${messageText}`,
      kind: "error",
      sourcePrompt: query,
      status: "error",
      subtitle: "built-in web search",
      title: "Web search failed",
    });
    ztoolkit.log("Web search failed:", error);
    return {
      contextText: "",
      query,
      status: "Web search unavailable; continuing without web context.",
    };
  }
}

function buildWebSearchQuery({
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
  const explicit = cleanSearchQuery(message);
  if (explicit) {
    return explicit;
  }
  const metadataTitle = contextSummary?.metadata
    ?.split(/\r?\n/)
    .find((line) => /title|题名|标题/i.test(line))
    ?.replace(/^.*?:\s*/, "")
    .trim();
  return truncateText(
    [
      selectedSkill?.label || "",
      scope?.label || metadataTitle || "",
    ]
      .filter(Boolean)
      .join(" ")
      .trim(),
    240,
  );
}

function cleanSearchQuery(value: string): string {
  return truncateText(
    value
      .replace(/^\s*\/\S+\s*/, "")
      .replace(/^(搜索|联网搜索|网页搜索|查找|查一下|search|web search)\s*[:：]?\s*/i, "")
      .trim(),
    240,
  );
}

function shouldAutoUseWebSearch(value: string): boolean {
  return /\b(latest|recent|today|news|current|web|internet|search)\b/i.test(value) ||
    /(联网|网页|搜索|查找|查一下|最新|今天|新闻|当前|近期)/.test(value);
}

async function searchWeb(query: string): Promise<WebSearchResult[]> {
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await fetchText(url);
  return parseDuckDuckGoHTML(html).slice(0, WEB_SEARCH_RESULT_LIMIT);
}

async function fetchText(url: string): Promise<string> {
  try {
    const response = await fetch(url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 Zotero WebAI",
      },
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.text();
  } catch {
    const xhr = await Zotero.HTTP.request("GET", url, {
      headers: {
        Accept: "text/html,application/xhtml+xml",
        "User-Agent": "Mozilla/5.0 Zotero WebAI",
      },
      responseType: "text",
      timeout: 20000,
    });
    return String(xhr.responseText || "");
  }
}

function parseDuckDuckGoHTML(html: string): WebSearchResult[] {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const results: WebSearchResult[] = [];
  const nodes = Array.from(doc.querySelectorAll(".result")) as HTMLElement[];
  for (const node of nodes) {
    const anchor = node.querySelector<HTMLAnchorElement>(".result__a");
    const title = normalizeWhitespace(anchor?.textContent || "");
    const rawURL = anchor?.getAttribute("href") || "";
    const snippet = normalizeWhitespace(
      node.querySelector(".result__snippet")?.textContent || "",
    );
    const url = unwrapDuckDuckGoURL(rawURL);
    if (title && url) {
      results.push({ snippet, title, url });
    }
  }
  return results;
}

function unwrapDuckDuckGoURL(url: string): string {
  if (!url) {
    return "";
  }
  try {
    const parsed = new URL(url, "https://duckduckgo.com");
    return parsed.searchParams.get("uddg") || parsed.href;
  } catch {
    return url;
  }
}

function formatWebSearchRecordBody(
  query: string,
  results: WebSearchResult[],
): string {
  if (!results.length) {
    return `Query: ${query}\n\nNo readable web results returned.`;
  }
  return [
    `Query: ${query}`,
    "",
    ...results.map((result, index) =>
      [
        `${index + 1}. ${result.title}`,
        result.url,
        result.snippet,
      ]
        .filter(Boolean)
        .join("\n"),
    ),
  ].join("\n\n");
}

function formatWebSearchPromptContext(
  query: string,
  results: WebSearchResult[],
): string {
  return truncateText(
    [
      "Web search context:",
      `Query: ${query}`,
      "Use these web results as external context. Cite URLs when relying on them and distinguish web context from Zotero/PDF context.",
      "",
      ...results.map((result, index) =>
        [
          `${index + 1}. ${result.title}`,
          `URL: ${result.url}`,
          result.snippet,
        ]
          .filter(Boolean)
          .join("\n"),
      ),
    ].join("\n\n"),
    WEB_SEARCH_CONTEXT_TEXT_LIMIT,
  );
}

function buildRegeneratePrompt(record: WebAIExecutionRecord): string {
  return [
    "Regenerate the following Zotero WebAI result with improved clarity and completeness.",
    `Result type: ${record.kind}`,
    `Title: ${record.title}`,
    record.subtitle ? `Context: ${record.subtitle}` : "",
    "",
    "Previous result:",
    record.body,
  ]
    .filter(Boolean)
    .join("\n");
}

async function appendResultToZoteroNote(
  scope: ScopeContext | null,
  record: WebAIExecutionRecord,
): Promise<number> {
  const parentItem = resolveNoteParentItem(scope);
  if (!parentItem) {
    throw new Error("No current Zotero item is available for appending a note.");
  }

  const note = await getOrCreateWebAINote(parentItem);
  const existing = note.getNote?.() || Zotero.Notes.defaultNote;
  note.setNote(appendHTMLToZoteroNote(existing, formatRecordNoteHTML(record)));
  await note.saveTx();
  return note.id;
}

function resolveNoteParentItem(scope: ScopeContext | null): Zotero.Item | null {
  const itemID = scope?.itemIds?.[0] || scope?.readerAttachmentId || 0;
  if (!itemID) {
    return null;
  }
  const item = Zotero.Items.get(itemID);
  if (!item) {
    return null;
  }
  return item.isRegularItem?.() ? item : item.parentItem || item.topLevelItem || item;
}

async function getOrCreateWebAINote(parentItem: Zotero.Item): Promise<Zotero.Item> {
  const noteIDs = parentItem.getNotes?.(false) || [];
  for (const noteID of noteIDs) {
    const note = Zotero.Items.get(noteID);
    if (note?.isNote?.() && note.getNoteTitle?.() === WEBAI_NOTE_TITLE) {
      return note;
    }
  }

  const note = new Zotero.Item("note");
  const mutableNote = note as Zotero.Item & {
    libraryID?: number;
    parentID?: number | false;
  };
  mutableNote.libraryID = parentItem.libraryID;
  mutableNote.parentID = parentItem.id;
  note.setNote(
    `<div class="zotero-note znv1"><h1>${escapeHTML(WEBAI_NOTE_TITLE)}</h1></div>`,
  );
  await note.saveTx();
  return note;
}

function appendHTMLToZoteroNote(existing: string, addition: string): string {
  const inner = existing
    .replace(/^<div class="zotero-note znv1">\s*/i, "")
    .replace(/\s*<\/div>\s*$/i, "");
  return `<div class="zotero-note znv1">${inner}${addition}</div>`;
}

function formatRecordNoteHTML(record: WebAIExecutionRecord): string {
  return [
    "<hr/>",
    `<h2>${escapeHTML(record.title)}</h2>`,
    `<p><strong>${escapeHTML(record.kind.toUpperCase())}</strong>${
      record.subtitle ? ` · ${escapeHTML(record.subtitle)}` : ""
    } · ${escapeHTML(formatRecordTimestamp(record.createdAt))}</p>`,
    `<pre>${escapeHTML(record.body)}</pre>`,
  ].join("");
}

function formatRecordTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeHTML(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function extractLatestAssistantText(text: string, sourcePrompt = ""): string {
  const cleaned = text
    .replace(/ZOTERO_WEBAI_MCP_REQUEST[\s\S]*?END_ZOTERO_WEBAI_MCP_REQUEST/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) {
    return "";
  }

  const markerMatches = [
    "Zotero WebAI MCP tool result:",
    "Use this Zotero MCP result to continue answering",
    "Zotero context:",
    "Paper content:",
  ];
  let lastMarker = "";
  let lastMarkerIndex = -1;
  for (const marker of markerMatches) {
    const markerIndex = cleaned.lastIndexOf(marker);
    if (markerIndex > lastMarkerIndex) {
      lastMarker = marker;
      lastMarkerIndex = markerIndex;
    }
  }
  const candidate =
    lastMarkerIndex >= 0
      ? cleaned.slice(lastMarkerIndex + lastMarker.length).trim()
      : cleaned;
  const stripped = stripPromptEcho(candidate || cleaned, sourcePrompt);
  return truncateText(stripAssistantWebNoise(stripped), MCP_CONTEXT_TEXT_LIMIT);
}

function normalizeAssistantCapture(
  captured: string,
  sourcePrompt = "",
): AssistantCaptureParts {
  const normalized = stripAssistantWebNoise(
    stripPromptEcho(captured, sourcePrompt),
  );
  const split = splitThinkingFromAnswer(normalized);
  return {
    body: truncateText(stripAssistantWebNoise(split.body), MCP_CONTEXT_TEXT_LIMIT),
    thinking: split.thinking
      ? truncateText(stripAssistantWebNoise(split.thinking), MCP_CONTEXT_TEXT_LIMIT)
      : undefined,
  };
}

function stripPromptEcho(value: string, sourcePrompt = ""): string {
  let text = normalizeCapturedText(value);
  const prompt = normalizeCapturedText(sourcePrompt);
  if (!text || !prompt) {
    return text;
  }

  const exactIndex = text.lastIndexOf(prompt);
  if (exactIndex >= 0) {
    text = text.slice(exactIndex + prompt.length).trim();
  }

  const promptEndMarkers = [
    "Note: the paper text was truncated by Zotero WebAI; continue from the available excerpt first.",
    "Use the following MCP tool output as external/local Zotero context for this conversation.",
    "Use these web results as external context.",
  ];
  for (const marker of promptEndMarkers) {
    const index = text.lastIndexOf(marker);
    if (index >= 0) {
      text = text.slice(index + marker.length).trim();
    }
  }

  const promptLines = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 48);
  for (const line of promptLines.slice(-12)) {
    const index = text.lastIndexOf(line);
    if (index >= 0) {
      text = text.slice(index + line.length).trim();
    }
  }

  if (looksLikePromptEcho(text)) {
    return "";
  }
  return text;
}

function normalizeCapturedText(value: string): string {
  return value
    .replace(/\\n/g, "\n")
    .replace(/\r\n?/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripAssistantWebNoise(value: string): string {
  const text = normalizeCapturedText(value)
    .replace(/本回答由\s*AI\s*生成[，,]?\s*内容仅供参考[，,]?\s*请仔细甄别/g, "")
    .replace(/内容由\s*AI\s*生成[，,]?\s*请仔细甄别/g, "");
  const noiseLinePattern =
    /^(深度思考|智能搜索|联网搜索|搜索|复制|分享|重新生成|停止生成|继续生成|给\s*(DeepSeek|Z\.ai)\s*发送消息)$/i;
  return text
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line && !noiseLinePattern.test(line))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function splitThinkingFromAnswer(value: string): AssistantCaptureParts {
  const text = normalizeCapturedText(value);
  const tagMatch = text.match(/<think>([\s\S]*?)<\/think>/i);
  if (tagMatch) {
    return {
      body: text.replace(tagMatch[0], "").trim(),
      thinking: tagMatch[1]?.trim() || undefined,
    };
  }

  const lines = text.split(/\n/);
  const thinkingStart = lines.findIndex((line) =>
    /^(思考链|思考过程|推理过程|深度思考|Reasoning|Thinking|Chain of thought)\s*[:：]?$/i.test(
      line.trim(),
    ),
  );
  if (thinkingStart < 0) {
    return { body: text };
  }

  const answerStart = lines.findIndex(
    (line, index) =>
      index > thinkingStart &&
      /^(最终答案|答案|回答|结论|Answer|Final answer|Result)\s*[:：]?$/i.test(
        line.trim(),
      ),
  );
  if (answerStart < 0) {
    return {
      body: lines.filter((_, index) => index !== thinkingStart).join("\n").trim(),
    };
  }

  return {
    body: lines.slice(answerStart + 1).join("\n").trim(),
    thinking: lines.slice(thinkingStart + 1, answerStart).join("\n").trim(),
  };
}

function looksLikePromptEcho(value: string): boolean {
  const text = normalizeCapturedText(value);
  if (!text) {
    return false;
  }
  const hasPromptSections =
    /(^|\n)(User message|Zotero context|Metadata|Selected passage|Paper content|MCP context|Web search context):/i.test(
      text,
    );
  const hasZoteroTruncation = text.includes(
    "Note: the paper text was truncated by Zotero WebAI",
  );
  const hasMCPJsonEcho =
    /"appliedModeConfig"|"pagination"|"searchTime"|"hasMore"/.test(text);
  return (hasPromptSections && (hasZoteroTruncation || hasMCPJsonEcho)) ||
    (hasPromptSections && text.length > 1200 && !/[。！？.!?]\s*\n/.test(text));
}

async function waitForStableAssistantText(
  frame: Element | null,
  baselineText: string,
  shouldContinue: () => boolean,
  sourcePrompt = "",
): Promise<string> {
  const baseline = extractLatestAssistantText(baselineText, sourcePrompt);
  let bestCandidate = "";
  let stableReads = 0;

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!shouldContinue()) {
      return "";
    }
    await sleepWithHostTimer(attempt < 2 ? 1200 : 1800);
    const result = await readWebChatText(frame);
    if (!result.ok || !result.text) {
      continue;
    }
    const candidate = extractLatestAssistantText(result.text, sourcePrompt);
    if (!candidate || candidate === baseline || candidate.length < 8) {
      continue;
    }
    if (candidate === bestCandidate) {
      stableReads += 1;
    } else {
      bestCandidate = candidate;
      stableReads = 0;
    }
    if (stableReads >= 1) {
      return bestCandidate;
    }
  }

  return bestCandidate;
}

function sleepWithHostTimer(timeoutMs: number): Promise<void> {
  const timerHost = resolveTimerHost();
  return new Promise((resolve) => {
    timerHost.setTimeout(resolve, timeoutMs);
  });
}

function truncateText(text: string, limit: number): string {
  const normalized = text.trim();
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit)}\n\n[Truncated by Zotero WebAI]`;
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
    flex: "1 1 620px",
    minHeight: "520px",
    minWidth: 0,
    overflow: "hidden",
  },
  frameHostCollapsed: {
    display: "none",
  },
  loginFrameHost: {
    flex: "1 1 auto",
    minHeight: 0,
  },
  loginModeBar: {
    alignItems: "center",
    border: "1px solid #e0e0e0",
    borderRadius: "8px",
    display: "flex",
    flex: "0 0 auto",
    flexWrap: "wrap",
    gap: "8px",
    justifyContent: "space-between",
    minWidth: 0,
    padding: "8px",
  },
  loginModeText: {
    display: "flex",
    flex: "1 1 220px",
    flexDirection: "column",
    gap: "2px",
    minWidth: 0,
  },
  loginModeTitle: {
    fontSize: typography.label,
    fontWeight: 700,
    lineHeight: 1.25,
  },
  loginModeHint: {
    fontSize: typography.meta,
    lineHeight: 1.35,
    minWidth: 0,
    overflow: "hidden",
    overflowWrap: "anywhere",
    textOverflow: "ellipsis",
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
  primaryMiniButton: {
    fontWeight: 700,
  },
  executionPanel: {
    border: "1px solid #e0e0e0",
    borderRadius: "8px",
    boxSizing: "border-box",
    display: "flex",
    flex: "0 0 auto",
    flexDirection: "column",
    gap: "8px",
    height: "260px",
    maxHeight: "70vh",
    minHeight: "150px",
    minWidth: 0,
    overflow: "hidden",
    padding: "8px",
    resize: "vertical",
    width: "100%",
  },
  executionHeader: {
    alignItems: "center",
    display: "flex",
    gap: "8px",
    justifyContent: "space-between",
    minWidth: 0,
  },
  executionHeaderActions: {
    alignItems: "center",
    display: "flex",
    flex: "0 0 auto",
    gap: "6px",
    minWidth: 0,
  },
  executionTitle: {
    fontSize: typography.label,
    fontWeight: 700,
    lineHeight: 1.3,
  },
  executionMeta: {
    fontSize: typography.meta,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  resultsLayout: {
    display: "flex",
    flex: "1 1 auto",
    gap: "8px",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
  },
  historyPanel: {
    borderRight: "1px solid #e0e0e0",
    display: "flex",
    flex: "0 0 240px",
    flexDirection: "column",
    gap: "6px",
    maxWidth: "34%",
    minHeight: 0,
    minWidth: "220px",
    paddingRight: "8px",
  },
  historyHeader: {
    alignItems: "center",
    display: "flex",
    gap: "6px",
    justifyContent: "space-between",
    minWidth: 0,
  },
  historyTitle: {
    fontSize: typography.label,
    fontWeight: 700,
    lineHeight: 1.3,
  },
  historyList: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    minHeight: 0,
    overflow: "auto",
  },
  historyItem: {
    appearance: "none",
    background: "transparent",
    border: "1px solid #e0e0e0",
    borderRadius: "6px",
    cursor: "pointer",
    display: "flex",
    flexDirection: "column",
    gap: "2px",
    minHeight: "52px",
    minWidth: 0,
    padding: "6px 8px",
    textAlign: "left",
  },
  historyItemTitle: {
    fontSize: typography.meta,
    fontWeight: 700,
    lineHeight: 1.25,
    overflow: "hidden",
    overflowWrap: "anywhere",
    wordBreak: "break-word",
  },
  historyItemMeta: {
    fontSize: typography.caption,
    lineHeight: 1.25,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  executionList: {
    display: "flex",
    flex: "1 1 auto",
    flexDirection: "column",
    gap: "6px",
    minWidth: 0,
    minHeight: 0,
    overflow: "auto",
  },
  executionItem: {
    border: "1px solid #e0e0e0",
    borderRadius: "6px",
    padding: "6px",
  },
  executionSummary: {
    alignItems: "center",
    cursor: "pointer",
    display: "flex",
    gap: "8px",
    listStyle: "none",
    minWidth: 0,
  },
  executionKind: {
    border: "1px solid #c9c9c9",
    borderRadius: "4px",
    flex: "0 0 auto",
    fontSize: typography.meta,
    fontWeight: 700,
    padding: "1px 5px",
    textTransform: "uppercase",
  },
  executionSummaryText: {
    display: "flex",
    flex: "1 1 auto",
    flexDirection: "column",
    minWidth: 0,
  },
  executionItemTitle: {
    fontSize: typography.label,
    fontWeight: 700,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  executionItemSubtitle: {
    fontSize: typography.meta,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  executionBody: {
    background: "transparent",
    border: 0,
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace",
    fontSize: typography.meta,
    lineHeight: 1.45,
    margin: "6px 0 0",
    maxHeight: "none",
    overflow: "auto",
    padding: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  thinkingDetails: {
    marginTop: "6px",
  },
  thinkingSummary: {
    cursor: "pointer",
    fontSize: typography.meta,
    fontWeight: 600,
    lineHeight: 1.35,
  },
  thinkingBody: {
    background: "transparent",
    border: 0,
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace",
    fontSize: typography.meta,
    lineHeight: 1.45,
    margin: "6px 0 0",
    maxHeight: "140px",
    overflow: "auto",
    padding: 0,
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  recordActions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    marginTop: "8px",
  },
  inlineActionButton: {
    appearance: "none",
    background: "transparent",
    border: "1px solid #c9c9c9",
    borderRadius: "12px",
    cursor: "pointer",
    fontSize: typography.meta,
    fontWeight: 600,
    minHeight: "24px",
    padding: "2px 8px",
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
  skillOptionText: {
    display: "flex",
    flex: "1 1 auto",
    flexDirection: "column",
    minWidth: 0,
  },
  skillOptionTitle: {
    fontSize: typography.body,
    fontWeight: 600,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  skillOptionDescription: {
    fontSize: typography.meta,
    lineHeight: 1.25,
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
