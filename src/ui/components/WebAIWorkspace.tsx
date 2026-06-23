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
import { getPref, setPref } from "../../utils/prefs";
import { getSidebarTheme, type SidebarTheme } from "../theme";
import { typography } from "../typography";

type WebAIServiceId = "deepseek" | "zai";
type PromptSourceMode = "paper" | "selection";
type WebAICommandKind = "mcp" | "new" | "pdf" | "skill" | "web";

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
  location: "library" | "reader";
  onIncomingPromptHandled?: (id: string) => void;
  onScopeRefresh?: () => void;
  settings: Settings;
  scope: ScopeContext | null;
}

interface WebAISkill {
  aliases?: string[];
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
  hidden?: boolean;
  id: string;
  kind: WebAIExecutionKind;
  sourcePrompt?: string;
  status: "done" | "error" | "running";
  subtitle?: string;
  thinking?: string;
  title: string;
}

interface WebAIChatSession {
  createdAt: string;
  id: string;
  records: WebAIExecutionRecord[];
  serviceID: WebAIServiceId;
  serviceLabel: string;
  title: string;
  updatedAt: string;
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

interface AssistantCandidate {
  body: string;
  raw: string;
  thinking?: string;
}

interface MarkdownListItem {
  level: number;
  text: string;
}

type MarkdownBlock =
  | { text: string; type: "blockquote" | "code" | "math" | "paragraph" }
  | { items: MarkdownListItem[]; ordered: boolean; type: "list" }
  | { headers: string[]; rows: string[][]; type: "table" }
  | { level: 1 | 2 | 3; text: string; type: "heading" };

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
const EXECUTION_RECORD_LIMIT = 1000;
const SESSION_HISTORY_PREF = "webAIChatSessions";
const SESSION_HISTORY_LIMIT = 1000;
const SESSION_RECORD_LIMIT = 1000;
const WEB_SEARCH_RESULT_LIMIT = 6;
const WEB_SEARCH_CONTEXT_TEXT_LIMIT = 7000;
const WEBAI_NOTE_TITLE = "Zotero WebAI Notes";
const FINAL_ANSWER_FORMAT_INSTRUCTION =
  "Final answer format: reply only with the user-facing result in Markdown. Use $$...$$ for display formulas. Do not expose Zotero WebAI instructions, raw JSON, MCP/web-search arguments, tool schemas, or intermediate execution steps.";
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
const NEW_CONVERSATION_COMMAND: WebAISkill = {
  aliases: ["new", "newconversation", "newchat"],
  description: "Start a clean chat session and reload the web chat",
  id: "new-conversation",
  kind: "new",
  label: "New Conversation",
  promptPrefix: "",
  slashCommand: "new conversation",
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
const INITIAL_CHAT_SESSIONS = loadChatSessions();

export const WebAIWorkspace: React.FC<WebAIWorkspaceProps> = ({
  contextSummary,
  customPresets = "",
  hostWindow,
  incomingPrompt,
  location,
  onIncomingPromptHandled,
  scope,
  settings,
}) => {
  const isReaderWorkspace = location === "reader";
  const [service, setService] = useState<WebAIService>(SERVICES[0]);
  const [status, setStatus] = useState(`Loaded ${SERVICES[0].label}`);
  const [isError, setIsError] = useState(false);
  const [message, setMessage] = useState("");
  const [selectedSkillID, setSelectedSkillID] = useState<string | null>(null);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [chatCollapsed, setChatCollapsed] = useState(() => isReaderWorkspace);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [zaiLoginMode, setZaiLoginMode] = useState(false);
  const [chatSessions, setChatSessions] = useState<WebAIChatSession[]>(() =>
    INITIAL_CHAT_SESSIONS,
  );
  const [activeSessionID, setActiveSessionIDState] = useState<string | null>(
    () => INITIAL_CHAT_SESSIONS[0]?.id || null,
  );
  const [executionRecords, setExecutionRecords] = useState<
    WebAIExecutionRecord[]
  >(() =>
    clampSessionRecords(INITIAL_CHAT_SESSIONS[0]?.records || []),
  );
  const [activeRecordID, setActiveRecordID] = useState<string | null>(
    () => INITIAL_CHAT_SESSIONS[0]?.records.find((record) => !record.hidden)?.id || null,
  );
  const frameHostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<Element | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const activeSessionIDRef = useRef<string | null>(activeSessionID);
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
    upsertChatSession(record);
    if (!record.hidden) {
      setActiveRecordID(record.id);
    }
    return record.id;
  };

  const upsertChatSession = (record: WebAIExecutionRecord) => {
    const sessionID = activeSessionIDRef.current || createSessionID();
    if (!activeSessionIDRef.current) {
      setActiveSessionID(sessionID);
    }
    setChatSessions((current) =>
      saveChatSessions(
        updateChatSessionsWithRecord(current, {
          record,
          serviceID: service.id,
          serviceLabel: service.label,
          sessionID,
        }),
      ),
    );
  };

  const setActiveSessionID = (sessionID: string | null) => {
    activeSessionIDRef.current = sessionID;
    setActiveSessionIDState(sessionID);
  };

  const replaceActiveSessionRecords = (records: WebAIExecutionRecord[]) => {
    const sessionID = activeSessionIDRef.current;
    if (!sessionID) {
      setExecutionRecords(records);
      return;
    }
    setExecutionRecords(records);
    setChatSessions((current) =>
      saveChatSessions(
        updateChatSessionsRecords(current, {
          records,
          serviceID: service.id,
          serviceLabel: service.label,
          sessionID,
        }),
      ),
    );
  };

  const openSession = (session: WebAIChatSession) => {
    const records = clampSessionRecords(session.records);
    setActiveSessionID(session.id);
    setExecutionRecords(records);
    setActiveRecordID(records.find((record) => !record.hidden)?.id || null);
    setStatus(`Loaded session: ${session.title}`);
    setIsError(false);
  };

  const clearCurrentSession = () => {
    replaceActiveSessionRecords([]);
    setActiveRecordID(null);
    setStatus("Cleared the current session.");
    setIsError(false);
  };

  const customSkills = useMemo(
    () => buildCustomSkills(customPresets),
    [customPresets],
  );
  const slashCommands = useMemo(
    () => [
      NEW_CONVERSATION_COMMAND,
      CURRENT_PDF_COMMAND,
      WEB_SEARCH_COMMAND,
      ZOTERO_MCP_COMMAND,
      ...customSkills,
    ],
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
  const visibleExecutionRecords = useMemo(
    () => executionRecords.filter((record) => !record.hidden),
    [executionRecords],
  );
  const transcriptRecords = useMemo(
    () => [...visibleExecutionRecords].reverse(),
    [visibleExecutionRecords],
  );

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

  useEffect(() => {
    const node = transcriptRef.current;
    if (!node) {
      return;
    }
    if (activeRecordID) {
      const target = node.querySelector<HTMLElement>(
        `[data-record-id="${activeRecordID}"]`,
      );
      if (target) {
        target.scrollIntoView({ block: "end" });
        return;
      }
    }
    node.scrollTop = node.scrollHeight;
  }, [activeRecordID, visibleExecutionRecords.length, historyVisible]);

  const recordAssistantReply = (
    captured: string,
    options: AssistantReplyRecordOptions = {},
  ) => {
    const normalized = normalizeAssistantCapture(
      captured,
      options.sourcePrompt,
      lastCapturedAssistantTextRef.current,
    );
    const dedupeKey = [normalized.body, normalized.thinking || ""].join("\n\n");
    if (
      !normalized.body ||
      dedupeKey === lastCapturedAssistantTextRef.current ||
      looksLikeInternalBridgeOutput(normalized.body)
    ) {
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
        () => lastCapturedAssistantTextRef.current,
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
    const baselineText = await readLatestAssistantText(frameRef.current)
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
    copyTextToClipboard(formatMarkdownForDisplay(record.body));
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
    const result = await readLatestAssistantText(frameRef.current);
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
    if (skill.kind === "new") {
      startNewConversation();
      return;
    }
    setSelectedSkillID(skill.id);
    setMessage(removeSlashToken(message).trimStart());
    setStatus(formatSlashCommandStatus(skill));
    setIsError(false);
  };

  const selectService = (candidate: WebAIService) => {
    setService(candidate);
    setZaiLoginMode(candidate.id === "zai" && !isReaderWorkspace);
    if (isReaderWorkspace) {
      setChatCollapsed(true);
    }
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

  const startNewConversation = () => {
    const session = createChatSession({
      records: [],
      serviceID: service.id,
      serviceLabel: service.label,
    });
    setMessage("");
    setSelectedSkillID(null);
    setActiveSessionID(session.id);
    setExecutionRecords([]);
    setActiveRecordID(null);
    setIsError(false);
    setChatSessions((current) => saveChatSessions([session, ...current]));
    activeMCPBridgeTokensRef.current.clear();
    handledMCPRequestsRef.current.clear();
    lastCapturedAssistantTextRef.current = "";
    assistantCaptureRunRef.current += 1;
    loadFrameElement(frameRef.current, service.url);
    setStatus(`Started a new ${service.label} conversation.`);
  };

  const sendPrompt = async () => {
    const draftMessage = message;
    if (isNewConversationCommand(draftMessage)) {
      startNewConversation();
      return;
    }

    const resolved = resolveSkillFromMessage(draftMessage, slashCommands, selectedSkill);
    if (resolved.skill?.kind === "new") {
      startNewConversation();
      return;
    }
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
        hidden: true,
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
        hidden: true,
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
      if (!mcpContext.contextText) {
        throw new Error(
          mcpContext.status || "MCP unavailable; check that zotero-mcp is running.",
        );
      }
      setStatus(
        mcpContext.status ||
          "MCP tool schema loaded. Waiting for the web model to request tools.",
      );
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
    const isComposing =
      "isComposing" in event.nativeEvent && event.nativeEvent.isComposing;

    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void runAction(sendPrompt);
      return;
    }

    if (event.key === "Enter" && showSlashMenu && slashSuggestions[0]) {
      event.preventDefault();
      chooseSkill(slashSuggestions[0]);
      return;
    }

    if (
      event.key === "Enter" &&
      !event.shiftKey &&
      !event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      !isComposing
    ) {
      event.preventDefault();
      void runAction(sendPrompt);
    }
  };

  const renderTranscriptRecord = (record: WebAIExecutionRecord) => {
    const displayPrompt = formatRecordSourceForChat(record);
    const isActive = activeRecordID === record.id;

    return (
      <section
        data-record-id={record.id}
        key={record.id}
        style={{
          ...styles.chatTurn,
          outline: isActive ? `1px solid ${theme.badgeBorder}` : "none",
        }}
      >
        {displayPrompt && (
          <div style={{ ...styles.messageRow, ...styles.userMessageRow }}>
            <article
              style={{
                ...styles.userBubble,
                background: theme.userMessageBackground,
                borderColor: theme.userMessageBorder,
              }}
            >
              <div style={styles.messageHeader}>
                <span style={{ ...styles.messageAuthor, color: theme.text }}>
                  User
                </span>
                <span style={{ ...styles.messageTimestamp, color: theme.mutedText }}>
                  {formatRecordTimestamp(record.createdAt)}
                </span>
              </div>
              <div style={{ ...styles.userMessageBody, color: theme.text }}>
                {renderMarkdownContent(displayPrompt, theme)}
              </div>
            </article>
          </div>
        )}

        <div style={{ ...styles.messageRow, ...styles.assistantMessageRow }}>
          <article
            style={{
              ...styles.assistantBubble,
              background: getRecordBubbleBackground(record.kind, theme),
              borderColor:
                record.status === "error"
                  ? theme.errorText
                  : getRecordBubbleBorder(record.kind, theme),
            }}
          >
            <div style={styles.messageHeader}>
              <span style={styles.assistantTitleLine}>
                <span
                  style={{
                    ...styles.executionKind,
                    background: getRecordBadgeBackground(record.kind, theme),
                    borderColor: getRecordBadgeBorder(record.kind, theme),
                    color:
                      record.status === "error"
                        ? theme.errorText
                        : getRecordBadgeText(record.kind, theme),
                  }}
                >
                  {getRecordKindLabel(record.kind)}
                </span>
                <span
                  style={{
                    ...styles.executionItemTitle,
                    color: theme.text,
                  }}
                >
                  {record.title}
                </span>
              </span>
              {!displayPrompt && (
                <span style={{ ...styles.messageTimestamp, color: theme.mutedText }}>
                  {formatRecordTimestamp(record.createdAt)}
                </span>
              )}
            </div>
            {record.subtitle && (
              <div
                style={{
                  ...styles.executionItemSubtitle,
                  color: theme.mutedText,
                }}
              >
                {record.subtitle}
              </div>
            )}
            <div style={{ ...styles.executionBody, color: theme.text }}>
              {renderMarkdownContent(record.body, theme)}
            </div>
            {record.thinking && (
              <details style={styles.thinkingDetails}>
                <summary
                  style={{
                    ...styles.thinkingSummary,
                    color: theme.mutedText,
                  }}
                >
                  Process hidden
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
                复制
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
                重新生成
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
                追加笔记
              </button>
            </div>
          </article>
        </div>
      </section>
    );
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
          ...(isReaderWorkspace ? styles.readerFrameHost : {}),
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
              {chatCollapsed ? "Show Web" : "Hide Web"}
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
            {chatCollapsed ? "Show Web" : "Hide Web"}
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
              onClick={clearCurrentSession}
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

      {!isZAILoginMode &&
        (isReaderWorkspace || visibleExecutionRecords.length > 0 || historyVisible) && (
        <div
          style={{
            ...styles.executionPanel,
            ...(isReaderWorkspace ? styles.readerExecutionPanel : {}),
            background: theme.surfaceBackground,
            borderColor: theme.softBorder,
          }}
        >
          <div style={styles.executionHeader}>
            <span style={{ ...styles.executionTitle, color: theme.text }}>
              Conversation
            </span>
            <div style={styles.executionHeaderActions}>
              <span style={{ ...styles.executionMeta, color: theme.mutedText }}>
                {visibleExecutionRecords.length} turns / {chatSessions.length} sessions
              </span>
            </div>
          </div>
          <div style={styles.resultsLayout}>
              {historyVisible && (
                <aside
                  style={{
                    ...styles.historyPanel,
                    background: theme.panelBackground,
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
                    {chatSessions.length === 0 && (
                      <div
                        style={{
                          ...styles.historyEmpty,
                          color: theme.mutedText,
                        }}
                      >
                        No saved sessions yet.
                      </div>
                    )}
                    {chatSessions.map((session) => {
                      const visibleCount = session.records.filter(
                        (record) => !record.hidden,
                      ).length;
                      return (
                      <button
                        key={`session-${session.id}`}
                        style={{
                          ...styles.historyItem,
                          background:
                            activeSessionID === session.id
                              ? theme.badgeBackground
                              : theme.surfaceBackground,
                          borderColor:
                            activeSessionID === session.id
                              ? theme.badgeBorder
                              : theme.softBorder,
                          color: theme.text,
                        }}
                        onClick={() => openSession(session)}
                        type="button"
                      >
                        <span style={styles.historyItemTitle}>
                          {session.title}
                        </span>
                        <span
                          style={{
                            ...styles.historyItemMeta,
                            color: theme.mutedText,
                          }}
                        >
                          {visibleCount} turns - {formatRecordTimestamp(session.updatedAt)}
                        </span>
                      </button>
                      );
                    })}
                  </div>
                </aside>
              )}
              <div ref={transcriptRef} style={styles.executionList}>
                {transcriptRecords.length ? (
                  transcriptRecords.map(renderTranscriptRecord)
                ) : (
                  <div
                    style={{
                      ...styles.emptyConversation,
                      color: theme.mutedText,
                    }}
                  >
                    Select a saved session or send a message to start a new turn.
                  </div>
                )}
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
          placeholder="Message in Markdown, /new conversation, or / for PDF, Web Search, Zotero MCP, Skills"
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
  if (skill.kind === "new") {
    return "Start a new conversation and clear the current web chat context.";
  }
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
    .filter((skill) => {
      const tokens = buildSlashSearchTokens(skill);
      return tokens.some((token) => token.includes(normalized));
    })
    .slice(0, 1000);
}

function getSlashQuery(value: string): { query: string } | null {
  const match = value.match(/^\s*\/([^\r\n]*)$/);
  return match ? { query: match[1] || "" } : null;
}

function isNewConversationCommand(value: string): boolean {
  const normalized = normalizeSlashCommand(value).toLowerCase();
  return ["new", "newconversation", "newchat"].includes(normalized);
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
      (skill) => matchesSlashSkill(skill, command),
    ) || selectedSkill;
  return {
    message: match[2] || "",
    skill: matchedSkill,
  };
}

function buildSlashSearchTokens(skill: WebAISkill): string[] {
  const rawTokens = [
    skill.label,
    skill.slashCommand,
    skill.id,
    skill.description || "",
    ...(skill.aliases || []),
  ];
  return rawTokens.flatMap((token) => {
    const lower = String(token || "").toLowerCase();
    const normalized = normalizeSlashCommand(lower).toLowerCase();
    return normalized && normalized !== lower ? [lower, normalized] : [lower];
  });
}

function matchesSlashSkill(skill: WebAISkill, command: string): boolean {
  const normalizedCommand = normalizeSlashCommand(command).toLowerCase();
  return buildSlashSearchTokens(skill).some(
    (token) => normalizeSlashCommand(token).toLowerCase() === normalizedCommand,
  );
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

async function readLatestAssistantText(
  frame: Element | null,
): Promise<WebChatTextResult> {
  if (!frame) {
    return { ok: false, reason: "web-frame-missing" };
  }

  const directResult = readLatestAssistantTextDirectly(frame);
  if (directResult.ok) {
    return directResult;
  }

  return readLatestAssistantTextWithFrameScript(frame);
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

function readLatestAssistantTextDirectly(frame: Element): WebChatTextResult {
  try {
    const doc = (frame as HTMLIFrameElement).contentWindow?.document;
    if (!doc) {
      return { ok: false, reason: "content-document-missing" };
    }
    return {
      ok: true,
      text: readLatestAssistantTextFromDocument(doc),
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

function readLatestAssistantTextWithFrameScript(
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

  const messageName = `ZoteroWebAI:LatestAssistant:${Date.now()}:${Math.random()
    .toString(36)
    .slice(2)}`;
  const source = buildLatestAssistantTextFrameScript(messageName);

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

function buildLatestAssistantTextFrameScript(messageName: string): string {
  return `
(function () {
  const messageName = ${JSON.stringify(messageName)};
  const MCP_BRIDGE_SCAN_TEXT_LIMIT = ${MCP_BRIDGE_SCAN_TEXT_LIMIT};
  ${readLatestAssistantTextFromDocument.toString()}
  try {
    sendAsyncMessage(messageName, {
      ok: true,
      text: readLatestAssistantTextFromDocument(content.document)
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

function readLatestAssistantTextFromDocument(doc: Document): string {
  const scanLimit = MCP_BRIDGE_SCAN_TEXT_LIMIT;
  const root =
    doc.querySelector("main") ||
    doc.querySelector('[role="main"]') ||
    doc.body ||
    doc.documentElement;
  if (!root) {
    return "";
  }

  const normalizeText = (value: string) =>
    String(value || "")
      .replace(/\r\n?/g, "\n")
      .replace(/\u00a0/g, " ")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

  const getElementText = (element: Element) => {
    const textSource = element.cloneNode(true) as Element;
    textSource
      .querySelectorAll(
        "button,svg,nav,header,footer,textarea,input,select,option,[role='button'],[role='toolbar'],[aria-hidden='true'],[hidden]",
      )
      .forEach((node: Element) => node.remove());
    const structured = elementHasMarkdownStructure(textSource);
    const raw = structured
      ? serializeElementToMarkdown(textSource)
      : "innerText" in textSource
        ? String((textSource as HTMLElement).innerText || "")
        : String(textSource.textContent || "");
    const noiseLinePattern =
      /^(copy|copied|share|regenerate|retry|stop generating|continue|edit|delete|like|dislike|复制|已复制|分享|重新生成|停止生成|继续生成|编辑|删除|赞|踩)$/i;
    const normalized = structured
      ? cleanupSerializedMarkdown(raw)
      : normalizeText(raw)
          .split("\n")
          .map((line) => line.trim())
          .filter(Boolean)
          .join("\n");
    return normalized
      .split("\n")
      .filter((line) => !noiseLinePattern.test(line.trim()))
      .filter(
        (line) =>
          !/^(copy|copied|share|regenerate|retry|stop generating|continue|edit|delete|like|dislike|deep think|search|web search|复制|已复制|分享|重新生成|停止生成|继续生成|编辑|删除|点赞|点踩|深度思考|智能搜索|联网搜索|搜索)$/i.test(
            line.trim(),
          ),
      )
      .join("\n")
      .trim();
  };

  const isVisible = (element: Element) => {
    const htmlElement = element as HTMLElement;
    const rect = htmlElement.getBoundingClientRect?.();
    const style = doc.defaultView?.getComputedStyle?.(htmlElement);
    return Boolean(
      rect &&
        rect.width > 8 &&
        rect.height > 8 &&
        style?.display !== "none" &&
        style?.visibility !== "hidden" &&
        style?.opacity !== "0" &&
        !htmlElement.hidden &&
        !htmlElement.closest?.(
          "textarea,input,select,option,form,[role='textbox'],[aria-hidden='true'],[hidden]",
        ),
    );
  };

  const candidateSelectors = [
    "[data-testid*='assistant-message']",
    "[data-message-author-role='assistant']",
    "[data-role='assistant']",
    "[data-author='assistant']",
    "[data-from='assistant']",
    "[class*='assistant-message']",
    "[class*='ds-markdown']",
    "[class*='markdown-body']",
    "[data-testid*='assistant']",
    "[data-testid*='answer']",
    "[data-testid*='message']",
    "[class*='assistant']",
    "[class*='Assistant']",
    "[class*='answer']",
    "[class*='Answer']",
    "[class*='response']",
    "[class*='Response']",
    "[class*='message']",
    "[class*='Message']",
    "[class*='markdown']",
    "[class*='Markdown']",
    "[class*='prose']",
    "[role='article']",
    "article",
  ];

  const candidates = new Set<Element>();
  for (const selector of candidateSelectors) {
    try {
      root
        .querySelectorAll(selector)
        .forEach((node: Element) => candidates.add(node));
    } catch {
      // Some embedded pages do not support every selector variant.
    }
  }

  const scoreCandidate = (element: Element, text: string) => {
    if (!isVisible(element) || text.length < 2) {
      return Number.NEGATIVE_INFINITY;
    }

    const htmlElement = element as HTMLElement;
    const rect = htmlElement.getBoundingClientRect();
    const descriptor = [
      element.tagName,
      element.id,
      element.className,
      element.getAttribute("role"),
      element.getAttribute("data-role"),
      element.getAttribute("data-author"),
      element.getAttribute("data-message-author-role"),
      element.getAttribute("data-testid"),
      element.getAttribute("aria-label"),
    ]
      .join(" ")
      .toLowerCase();
    const allNodes = Array.from(root.querySelectorAll("*"));
    const domIndex = allNodes.indexOf(element);
    let score =
      rect.bottom * 20 +
      (domIndex >= 0 ? domIndex : 0) +
      Math.min(text.length, 5000);

    if (/assistant|answer|response|bot|ai|markdown|prose|ds-markdown/.test(descriptor)) {
      score += 12000;
    }
    if (element.querySelector("h1,h2,h3,h4,h5,h6,ul,ol,table")) {
      score += 4500;
    }
    if (/message|article|conversation|chat/.test(descriptor)) {
      score += 1200;
    }
    if (/user|human|prompt|question|composer|input|textarea|toolbar|sidebar|nav|menu/.test(descriptor)) {
      score -= 10000;
    }
    if (text.length > 20000 && !/assistant|answer|response|markdown/.test(descriptor)) {
      score -= 12000;
    }
    if (element.querySelectorAll("[data-message-author-role], [data-role='assistant'], [class*='message'], [class*='Message']").length > 3) {
      score -= 8000;
    }
    if ((element.querySelectorAll("button,input,textarea,[contenteditable='true']").length || 0) > 4) {
      score -= 2500;
    }
    if (/User message:|Zotero context:|Paper content:|Final answer format:/i.test(text)) {
      score -= 16000;
    }

    return score;
  };

  const ranked = Array.from(candidates)
    .map((element, index) => {
      const text = getElementText(element);
      return {
        element,
        index,
        score: scoreCandidate(element, text),
        text,
      };
    })
    .filter((candidate) => Number.isFinite(candidate.score) && candidate.text)
    .sort((left, right) => {
      if (right.score !== left.score) {
        return right.score - left.score;
      }
      return right.index - left.index;
    });

  const best = ranked[0]?.text || "";
  if (best) {
    return best.slice(-scanLimit);
  }

  const fallbackText =
    "innerText" in root
      ? String((root as HTMLElement).innerText || "")
      : String(root.textContent || "");
  return normalizeText(fallbackText).slice(-scanLimit);
}

function elementHasMarkdownStructure(element: Element): boolean {
  return Boolean(
    element.querySelector(
      "h1,h2,h3,h4,h5,h6,p,ul,ol,li,table,thead,tbody,tr,th,td,blockquote,pre,code,strong,b,em,i,a",
    ),
  );
}

function serializeElementToMarkdown(element: Element): string {
  const chunks = getElementChildNodes(element)
    .map((node) => serializeMarkdownNode(node, 0))
    .filter(Boolean);
  return cleanupSerializedMarkdown(chunks.join("\n\n"));
}

function serializeMarkdownNode(node: Node, listDepth: number): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeInlineMarkdownText(node.textContent || "");
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (
    element.matches(
      "button,svg,nav,header,footer,textarea,input,select,option,[role='button'],[role='toolbar'],[aria-hidden='true'],[hidden]",
    )
  ) {
    return "";
  }

  if (/^h[1-6]$/.test(tag)) {
    const level = Math.min(Number(tag.slice(1)) || 3, 3);
    const text = serializeInlineMarkdown(element).trim();
    return text ? `${"#".repeat(level)} ${text}` : "";
  }
  if (tag === "p" || tag === "div" || tag === "section" || tag === "article") {
    const childBlocks = serializeContainerMarkdown(element, listDepth);
    if (childBlocks) {
      return childBlocks;
    }
    return serializeInlineMarkdown(element).trim();
  }
  if (tag === "br") {
    return "\n";
  }
  if (tag === "ul" || tag === "ol") {
    return serializeListMarkdown(element, tag === "ol", listDepth);
  }
  if (tag === "blockquote") {
    return serializeElementToMarkdown(element)
      .split("\n")
      .map((line) => (line ? `> ${line}` : ">"))
      .join("\n");
  }
  if (tag === "pre") {
    const code = (element.textContent || "").replace(/\s+$/g, "");
    return code ? `\`\`\`\n${code}\n\`\`\`` : "";
  }
  if (tag === "table") {
    return serializeTableMarkdown(element);
  }
  if (tag === "li") {
    return serializeListItemMarkdown(element, false, listDepth, 1);
  }

  return serializeInlineMarkdown(element).trim();
}

function serializeContainerMarkdown(element: Element, listDepth: number): string {
  const blockChildren = getElementChildNodes(element).filter((child) =>
    isMarkdownBlockNode(child),
  );
  if (!blockChildren.length) {
    return "";
  }

  const chunks: string[] = [];
  const inlineBefore: string[] = [];
  for (const child of getElementChildNodes(element)) {
    if (isMarkdownBlockNode(child)) {
      const inline = normalizeInlineMarkdownText(inlineBefore.join(""));
      if (inline) {
        chunks.push(inline);
      }
      inlineBefore.length = 0;
      const block = serializeMarkdownNode(child, listDepth);
      if (block) {
        chunks.push(block);
      }
      continue;
    }
    inlineBefore.push(serializeInlineMarkdownNode(child));
  }
  const trailingInline = normalizeInlineMarkdownText(inlineBefore.join(""));
  if (trailingInline) {
    chunks.push(trailingInline);
  }
  return chunks.filter(Boolean).join("\n\n");
}

function isMarkdownBlockNode(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return false;
  }
  const tag = (node as Element).tagName.toLowerCase();
  return /^(h[1-6]|p|ul|ol|li|table|blockquote|pre|section|article)$/.test(tag);
}

function serializeListMarkdown(
  listElement: Element,
  ordered: boolean,
  listDepth: number,
): string {
  const items = getElementChildren(listElement).filter(
    (child) => child.tagName.toLowerCase() === "li",
  );
  return items
    .map((item, index) =>
      serializeListItemMarkdown(item, ordered, listDepth, index + 1),
    )
    .filter(Boolean)
    .join("\n");
}

function serializeListItemMarkdown(
  item: Element,
  ordered: boolean,
  listDepth: number,
  index: number,
): string {
  const nestedLists: Element[] = [];
  const inlineParts: string[] = [];
  const childBlocks: string[] = [];

  getElementChildNodes(item).forEach((child) => {
    if (
      child.nodeType === Node.ELEMENT_NODE &&
      /^(ul|ol)$/i.test((child as Element).tagName)
    ) {
      nestedLists.push(child as Element);
      return;
    }
    if (isMarkdownBlockNode(child) && (child as Element).tagName.toLowerCase() !== "p") {
      const block = serializeMarkdownNode(child, listDepth + 1);
      if (block) {
        childBlocks.push(block);
      }
      return;
    }
    inlineParts.push(serializeInlineMarkdownNode(child));
  });

  const text = normalizeInlineMarkdownText(inlineParts.join(""));
  const marker = ordered ? `${index}.` : "*";
  const indent = "  ".repeat(listDepth);
  const continuationIndent = `${indent}  `;
  const lines = [
    `${indent}${marker} ${text || childBlocks.shift() || ""}`.trimEnd(),
  ];

  childBlocks.forEach((block) => {
    lines.push(
      block
        .split("\n")
        .map((line) => `${continuationIndent}${line}`)
        .join("\n"),
    );
  });
  nestedLists.forEach((nested) => {
    const nestedMarkdown = serializeListMarkdown(
      nested,
      nested.tagName.toLowerCase() === "ol",
      listDepth + 1,
    );
    if (nestedMarkdown) {
      lines.push(nestedMarkdown);
    }
  });
  return lines.join("\n");
}

function serializeTableMarkdown(table: Element): string {
  const rows = (Array.from(table.querySelectorAll("tr")) as Element[])
    .map((row) =>
      getElementChildren(row)
        .filter((cell) => /^(th|td)$/i.test(cell.tagName))
        .map((cell) => serializeInlineMarkdown(cell).trim()),
    )
    .filter((row) => row.length);
  if (!rows.length) {
    return "";
  }

  const columnCount = Math.max(...rows.map((row) => row.length));
  const normalizedRows = rows.map((row) =>
    Array.from({ length: columnCount }, (_, index) => escapeMarkdownTableCell(row[index] || "")),
  );
  const header = normalizedRows[0];
  const separator = header.map(() => ":---");
  return [
    `| ${header.join(" | ")} |`,
    `| ${separator.join(" | ")} |`,
    ...normalizedRows.slice(1).map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function serializeInlineMarkdown(element: Element): string {
  return normalizeInlineMarkdownText(
    getElementChildNodes(element)
      .map((child) => serializeInlineMarkdownNode(child))
      .join(""),
  );
}

function serializeInlineMarkdownNode(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent || "";
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const element = node as Element;
  const tag = element.tagName.toLowerCase();
  if (
    element.matches(
      "button,svg,nav,header,footer,textarea,input,select,option,[role='button'],[role='toolbar'],[aria-hidden='true'],[hidden]",
    )
  ) {
    return "";
  }
  if (tag === "br") {
    return "\n";
  }
  if (tag === "strong" || tag === "b") {
    const text = serializeInlineMarkdown(element);
    return text ? `**${text}**` : "";
  }
  if (tag === "em" || tag === "i") {
    const text = serializeInlineMarkdown(element);
    return text ? `*${text}*` : "";
  }
  if (tag === "code") {
    const text = normalizeInlineMarkdownText(element.textContent || "");
    return text ? `\`${text.replace(/`/g, "\\`")}\`` : "";
  }
  if (tag === "a") {
    const text = serializeInlineMarkdown(element);
    const href = element.getAttribute("href") || "";
    return text && /^https?:\/\//i.test(href) ? `[${text}](${href})` : text;
  }
  if (/^(ul|ol|table|blockquote|pre|h[1-6])$/.test(tag)) {
    return `\n${serializeMarkdownNode(element, 0)}\n`;
  }
  return getElementChildNodes(element)
    .map((child) => serializeInlineMarkdownNode(child))
    .join("");
}

function getElementChildNodes(element: Element): Node[] {
  return Array.prototype.slice.call(element.childNodes).filter(Boolean) as Node[];
}

function getElementChildren(element: Element): Element[] {
  return Array.prototype.slice.call(element.children).filter(Boolean) as Element[];
}

function normalizeInlineMarkdownText(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[ \t\f\v]+/g, " ")
    .replace(/\s+\n/g, "\n")
    .replace(/\n\s+/g, "\n")
    .trim();
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\n+/g, "<br>");
}

function cleanupSerializedMarkdown(value: string): string {
  return value
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
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
  deliverPrompt,
  request,
  serviceLabel,
  settings,
  setStatus,
}: {
  deliverPrompt: (
    prompt: string,
    statusPrefix?: string | null,
    captureOptions?: AssistantReplyRecordOptions,
  ) => Promise<void>;
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
    const prompt = formatMCPBridgeResultPrompt(request, detailed);
    await deliverPrompt(
      prompt,
      `MCP ${request.toolName} result inserted into ${serviceLabel}.`,
      {
        kind: "mcp",
        sourcePrompt: prompt,
        subtitle: `/${ZOTERO_MCP_COMMAND.slashCommand} ${request.toolName} via ${serviceLabel}`,
        title: `Zotero MCP result: ${request.toolName}`,
      },
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
    await deliverPrompt(prompt, `MCP ${request.toolName} failed.`, {
      kind: "mcp",
      sourcePrompt: prompt,
      subtitle: `/${ZOTERO_MCP_COMMAND.slashCommand} ${request.toolName} via ${serviceLabel}`,
      title: `Zotero MCP error: ${request.toolName}`,
    });
  }
}

function formatMCPBridgeResultPrompt(
  request: MCPBridgeRequest,
  result: MCPToolDetailedResult,
): string {
  const resultText =
    formatMCPPromptContext(result.results, {
      toolName: result.toolName || request.toolName,
      usedFallback: false,
    }) ||
    truncateText(result.text || safeJSONStringify(result.raw), MCP_CONTEXT_TEXT_LIMIT) ||
    "MCP tool returned no structured or text content.";
  return [
    "Zotero WebAI MCP tool result:",
    `Tool: ${request.toolName}`,
    `Arguments: ${safeJSONStringify(request.arguments)}`,
    "",
    resultText,
    "",
    "Use this Zotero MCP result to continue answering the user's request. If another Zotero MCP tool is needed, emit a new ZOTERO_WEBAI_MCP_REQUEST block using the same active token and a schema-valid arguments object.",
    FINAL_ANSWER_FORMAT_INSTRUCTION,
    "Final answer must summarize only the useful result for the user. Do not repeat Tool, Arguments, raw JSON, MCP context, bridge markers, or execution steps.",
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
    "Use the inputSchema for each tool to decide parameter names and values. Prefer complete/standard modes and limit 1000 when available. For Zotero library search, prefer search_library with {q, limit:1000, mode:\"complete\", relevanceScoring:true, sort:\"relevance\"}; then use itemKey/key with get_item_details or get_content when the user needs abstracts, notes, attachments, or full text. Keep write tools for explicit user requests that modify Zotero notes, tags, metadata, or items.",
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
    result.key?.trim() ? `{key: ${result.key.trim()}}` : "",
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
    FINAL_ANSWER_FORMAT_INSTRUCTION,
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

function createSessionID(): string {
  return `session-${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`;
}

function createChatSession({
  records,
  serviceID,
  serviceLabel,
}: {
  records: WebAIExecutionRecord[];
  serviceID: WebAIServiceId;
  serviceLabel: string;
}): WebAIChatSession {
  const now = new Date().toISOString();
  return {
    createdAt: now,
    id: createSessionID(),
    records: clampSessionRecords(records),
    serviceID,
    serviceLabel,
    title: buildSessionTitle(records, serviceLabel),
    updatedAt: now,
  };
}

function loadChatSessions(): WebAIChatSession[] {
  const value = getPref(SESSION_HISTORY_PREF);
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return clampChatSessions(
      parsed.map(normalizeChatSession).filter(isChatSession),
    );
  } catch (error) {
    ztoolkit.log("Failed to load Zotero WebAI chat sessions:", error);
    return [];
  }
}

function saveChatSessions(sessions: WebAIChatSession[]): WebAIChatSession[] {
  const normalized = clampChatSessions(sessions);
  try {
    setPref(SESSION_HISTORY_PREF, JSON.stringify(normalized));
  } catch (error) {
    ztoolkit.log("Failed to save Zotero WebAI chat sessions:", error);
  }
  return normalized;
}

function normalizeChatSession(value: unknown): WebAIChatSession | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const source = value as Partial<WebAIChatSession>;
  const records = clampSessionRecords(
    Array.isArray(source.records)
      ? source.records.map(normalizeExecutionRecord).filter(isExecutionRecord)
      : [],
  );
  const now = new Date().toISOString();
  const serviceID: WebAIServiceId =
    source.serviceID === "zai" ? "zai" : "deepseek";
  const serviceLabel =
    typeof source.serviceLabel === "string" && source.serviceLabel.trim()
      ? source.serviceLabel.trim()
      : serviceID === "zai"
        ? "Z.ai Web"
        : "DeepSeek Web";
  return {
    createdAt:
      typeof source.createdAt === "string" && source.createdAt
        ? source.createdAt
        : records.at(-1)?.createdAt || now,
    id:
      typeof source.id === "string" && source.id.trim()
        ? source.id.trim()
        : createSessionID(),
    records,
    serviceID,
    serviceLabel,
    title:
      typeof source.title === "string" && source.title.trim()
        ? source.title.trim()
        : buildSessionTitle(records, serviceLabel),
    updatedAt:
      typeof source.updatedAt === "string" && source.updatedAt
        ? source.updatedAt
        : records[0]?.createdAt || now,
  };
}

function isChatSession(
  session: WebAIChatSession | null,
): session is WebAIChatSession {
  return Boolean(session);
}

function normalizeExecutionRecord(value: unknown): WebAIExecutionRecord | null {
  if (!value || typeof value !== "object") {
    return null;
  }
  const source = value as Partial<WebAIExecutionRecord>;
  if (typeof source.body !== "string" || typeof source.title !== "string") {
    return null;
  }
  const kind: WebAIExecutionKind =
    source.kind === "assistant" ||
    source.kind === "mcp" ||
    source.kind === "pdf" ||
    source.kind === "skill" ||
    source.kind === "web" ||
    source.kind === "error"
      ? source.kind
      : "assistant";
  const status: WebAIExecutionRecord["status"] =
    source.status === "running" ||
    source.status === "error" ||
    source.status === "done"
      ? source.status
      : "done";
  return {
    body: source.body,
    createdAt:
      typeof source.createdAt === "string" && source.createdAt
        ? source.createdAt
        : new Date().toISOString(),
    hidden: Boolean(source.hidden),
    id:
      typeof source.id === "string" && source.id.trim()
        ? source.id.trim()
        : `exec-${Date.now().toString(36)}-${Math.random()
            .toString(36)
            .slice(2, 8)}`,
    kind,
    sourcePrompt:
      typeof source.sourcePrompt === "string" ? source.sourcePrompt : undefined,
    status,
    subtitle: typeof source.subtitle === "string" ? source.subtitle : undefined,
    thinking: typeof source.thinking === "string" ? source.thinking : undefined,
    title: source.title,
  };
}

function isExecutionRecord(
  record: WebAIExecutionRecord | null,
): record is WebAIExecutionRecord {
  return Boolean(record);
}

function updateChatSessionsWithRecord(
  sessions: WebAIChatSession[],
  {
    record,
    serviceID,
    serviceLabel,
    sessionID,
  }: {
    record: WebAIExecutionRecord;
    serviceID: WebAIServiceId;
    serviceLabel: string;
    sessionID: string;
  },
): WebAIChatSession[] {
  const index = sessions.findIndex((session) => session.id === sessionID);
  if (index < 0) {
    const session = createChatSession({
      records: [record],
      serviceID,
      serviceLabel,
    });
    return [{ ...session, id: sessionID }, ...sessions];
  }

  const existing = sessions[index];
  const records = clampSessionRecords([record, ...existing.records]);
  const updated: WebAIChatSession = {
    ...existing,
    records,
    serviceID,
    serviceLabel,
    title: buildSessionTitle(records, serviceLabel),
    updatedAt: record.createdAt,
  };
  return [updated, ...sessions.filter((session) => session.id !== sessionID)];
}

function updateChatSessionsRecords(
  sessions: WebAIChatSession[],
  {
    records,
    serviceID,
    serviceLabel,
    sessionID,
  }: {
    records: WebAIExecutionRecord[];
    serviceID: WebAIServiceId;
    serviceLabel: string;
    sessionID: string;
  },
): WebAIChatSession[] {
  const normalizedRecords = clampSessionRecords(records);
  const now = new Date().toISOString();
  const index = sessions.findIndex((session) => session.id === sessionID);
  if (index < 0) {
    const session = createChatSession({
      records: normalizedRecords,
      serviceID,
      serviceLabel,
    });
    return [{ ...session, id: sessionID }, ...sessions];
  }

  const existing = sessions[index];
  const updated: WebAIChatSession = {
    ...existing,
    records: normalizedRecords,
    serviceID,
    serviceLabel,
    title: buildSessionTitle(normalizedRecords, serviceLabel),
    updatedAt: normalizedRecords[0]?.createdAt || now,
  };
  return [updated, ...sessions.filter((session) => session.id !== sessionID)];
}

function clampChatSessions(sessions: WebAIChatSession[]): WebAIChatSession[] {
  const seen = new Set<string>();
  return sessions
    .filter((session) => {
      if (!session.id || seen.has(session.id)) {
        return false;
      }
      seen.add(session.id);
      return true;
    })
    .sort(
      (left, right) =>
        Date.parse(right.updatedAt || "") - Date.parse(left.updatedAt || ""),
    )
    .slice(0, SESSION_HISTORY_LIMIT);
}

function clampSessionRecords(
  records: WebAIExecutionRecord[],
): WebAIExecutionRecord[] {
  return records.slice(0, SESSION_RECORD_LIMIT);
}

function buildSessionTitle(
  records: WebAIExecutionRecord[],
  serviceLabel: string,
): string {
  const visibleRecord = records.find((record) => !record.hidden);
  const source =
    visibleRecord?.sourcePrompt &&
    (extractPromptSection(visibleRecord.sourcePrompt, "User message") ||
      (!hasPromptSections(visibleRecord.sourcePrompt)
        ? visibleRecord.sourcePrompt
        : ""));
  const titleSource = normalizeCapturedText(source || visibleRecord?.title || "");
  if (titleSource) {
    return truncateTextForDisplay(titleSource, 64).replace(/\n+/g, " ");
  }
  return `${serviceLabel} session`;
}

function formatRecordSourceForChat(record: WebAIExecutionRecord): string {
  const source = normalizeCapturedText(record.sourcePrompt || "");
  if (!source) {
    return "";
  }

  const command = extractPromptLine(source, "Command");
  const userMessage =
    extractPromptSection(source, "User message") ||
    (!hasPromptSections(source) ? source : "");
  const compactMessage = truncateTextForDisplay(userMessage, 1200);

  if (command) {
    return compactMessage ? `${command}\n\n${compactMessage}` : command;
  }
  if (record.kind === "web" && compactMessage) {
    return `/${WEB_SEARCH_COMMAND.slashCommand} ${compactMessage}`;
  }
  if (record.kind === "mcp" && compactMessage) {
    return `/${ZOTERO_MCP_COMMAND.slashCommand} ${compactMessage}`;
  }
  if (record.kind === "pdf" && compactMessage) {
    return `/${CURRENT_PDF_COMMAND.slashCommand} ${compactMessage}`;
  }
  return compactMessage;
}

function getRecordKindLabel(kind: WebAIExecutionKind): string {
  if (kind === "assistant") {
    return "AI";
  }
  if (kind === "mcp") {
    return "MCP";
  }
  if (kind === "pdf") {
    return "PDF";
  }
  if (kind === "skill") {
    return "Skill";
  }
  if (kind === "web") {
    return "Web";
  }
  return "Error";
}

function getRecordBubbleBackground(
  kind: WebAIExecutionKind,
  theme: SidebarTheme,
): string {
  if (kind === "error") {
    return theme.errorBackground;
  }
  if (kind === "web") {
    return theme.noticeBackground;
  }
  if (kind === "mcp") {
    return theme.accentBackground;
  }
  return theme.assistantMessageBackground;
}

function getRecordBubbleBorder(
  kind: WebAIExecutionKind,
  theme: SidebarTheme,
): string {
  if (kind === "error") {
    return theme.errorBorder;
  }
  if (kind === "web") {
    return theme.noticeBorder;
  }
  if (kind === "mcp") {
    return theme.accentBorder;
  }
  return theme.assistantMessageBorder;
}

function getRecordBadgeBackground(
  kind: WebAIExecutionKind,
  theme: SidebarTheme,
): string {
  if (kind === "error") {
    return theme.errorBackground;
  }
  if (kind === "web") {
    return theme.noticeBackground;
  }
  if (kind === "mcp") {
    return theme.accentBackground;
  }
  return theme.badgeBackground;
}

function getRecordBadgeBorder(
  kind: WebAIExecutionKind,
  theme: SidebarTheme,
): string {
  if (kind === "error") {
    return theme.errorBorder;
  }
  if (kind === "web") {
    return theme.noticeBorder;
  }
  if (kind === "mcp") {
    return theme.accentBorder;
  }
  return theme.badgeBorder;
}

function getRecordBadgeText(
  kind: WebAIExecutionKind,
  theme: SidebarTheme,
): string {
  if (kind === "error") {
    return theme.errorText;
  }
  if (kind === "web") {
    return theme.noticeText;
  }
  if (kind === "mcp") {
    return theme.accentText;
  }
  return theme.badgeText;
}

function extractPromptLine(text: string, label: string): string {
  const match = text.match(new RegExp(`(?:^|\\n)${escapeRegExp(label)}:\\s*(.+)`));
  return match?.[1]?.trim() || "";
}

function extractPromptSection(text: string, label: string): string {
  const sectionNames = [
    "Command",
    "User message",
    "Zotero context",
    "Metadata",
    "Selected passage",
    "Paper content",
    "Web search context",
    "MCP context",
    "Zotero MCP bridge",
    "Note",
  ];
  const nextSectionPattern = sectionNames
    .filter((name) => name !== label)
    .map(escapeRegExp)
    .join("|");
  const pattern = new RegExp(
    `(?:^|\\n)${escapeRegExp(label)}:\\s*\\n?([\\s\\S]*?)(?=\\n(?:${nextSectionPattern}):|$)`,
  );
  return pattern.exec(text)?.[1]?.trim() || "";
}

function hasPromptSections(text: string): boolean {
  return /(^|\n)(Command|User message|Zotero context|Metadata|Selected passage|Paper content|Web search context|MCP context|Zotero MCP bridge):/i.test(
    text,
  );
}

function truncateTextForDisplay(text: string, limit: number): string {
  const normalized = normalizeCapturedText(text);
  if (normalized.length <= limit) {
    return normalized;
  }
  return `${normalized.slice(0, limit).trim()}\n\n[Hidden long context]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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
    truncateText(result.text || safeJSONStringify(result.raw), MCP_CONTEXT_TEXT_LIMIT) ||
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
      hidden: true,
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
      hidden: true,
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
  const body = formatMarkdownForDisplay(record.body);
  return [
    "<hr/>",
    `<h2>${escapeHTML(record.title)}</h2>`,
    `<p><strong>${escapeHTML(record.kind.toUpperCase())}</strong>${
      record.subtitle ? ` · ${escapeHTML(record.subtitle)}` : ""
    } · ${escapeHTML(formatRecordTimestamp(record.createdAt))}</p>`,
    `<pre>${escapeHTML(body)}</pre>`,
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
  return extractAssistantCandidate(text, sourcePrompt).raw;
}

function extractAssistantCandidate(
  text: string,
  sourcePrompt = "",
  previousCapture = "",
): AssistantCandidate {
  const cleaned = text
    .replace(/ZOTERO_WEBAI_MCP_REQUEST[\s\S]*?END_ZOTERO_WEBAI_MCP_REQUEST/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!cleaned) {
    return { body: "", raw: "" };
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
  const normalized = normalizeAssistantCapture(
    stripped,
    sourcePrompt,
    previousCapture,
  );
  return {
    body: normalized.body,
    raw: normalized.body,
    thinking: normalized.thinking,
  };
}

function normalizeAssistantCapture(
  captured: string,
  sourcePrompt = "",
  previousCapture = "",
): AssistantCaptureParts {
  const normalized = stripAssistantWebNoise(
    stripPromptEcho(captured, sourcePrompt),
  );
  const split = splitThinkingFromAnswer(
    stripRepeatedCapturePrefix(normalized, previousCapture),
  );
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
    .filter(
      (line) =>
        !/^(deep think|thinking|reasoning|search|web search|copy|copied|share|regenerate|retry|stop generating|continue generating|continue|edit|delete|like|dislike|复制|已复制|分享|重新生成|重试|停止生成|继续生成|继续|编辑|删除|点赞|点踩|深度思考|推理过程|思考过程|智能搜索|联网搜索|搜索|给\s*(DeepSeek|Z\.ai)\s*发送消息)$/i.test(
          line,
        ),
    )
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function stripRepeatedCapturePrefix(value: string, previousCapture = ""): string {
  const text = normalizeCapturedText(value);
  const previous = normalizeCapturedText(previousCapture);
  if (!text || !previous || previous.length < 80) {
    return text;
  }

  if (text.startsWith(previous)) {
    return text.slice(previous.length).trim();
  }

  const previousTail = previous.slice(-Math.min(previous.length, 1200));
  const index = text.lastIndexOf(previousTail);
  if (index >= 0) {
    return text.slice(index + previousTail.length).trim();
  }

  return text;
}

function splitThinkingFromAnswer(value: string): AssistantCaptureParts {
  const text = normalizeCapturedText(value);
  const tagMatches = Array.from(text.matchAll(/<think>([\s\S]*?)<\/think>/gi));
  if (tagMatches.length) {
    const thinking = tagMatches
      .map((match) => match[1]?.trim())
      .filter(Boolean)
      .join("\n\n");
    return {
      body: text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim(),
      thinking: thinking || undefined,
    };
  }

  const openThinkIndex = text.search(/<\s*think\s*>/i);
  if (openThinkIndex >= 0) {
    const before = text.slice(0, openThinkIndex).trim();
    const afterOpen = text.slice(openThinkIndex).replace(/<\s*think\s*>/i, "");
    const finalAnswerMatch = afterOpen.match(
      /(?:^|\n)\s*(?:最终答案|答案|回答|结果|结论|Answer|Final answer|Result|Response)\s*[:：]\s*/i,
    );
    if (finalAnswerMatch?.index !== undefined) {
      const thinking = afterOpen.slice(0, finalAnswerMatch.index).trim();
      const body = [
        before,
        afterOpen.slice(finalAnswerMatch.index + finalAnswerMatch[0].length).trim(),
      ]
        .filter(Boolean)
        .join("\n\n");
      return { body, thinking: thinking || undefined };
    }
  }

  const splitBySections = splitInternalSectionsFromAnswer(text);
  if (splitBySections.thinking) {
    return splitBySections;
  }

  return { body: text };
}

function splitInternalSectionsFromAnswer(value: string): AssistantCaptureParts {
  const lines = value.split(/\n/);
  const bodyLines: string[] = [];
  const internalLines: string[] = [];
  let mode: "body" | "internal" = "body";
  let sawInternal = false;
  let sawAnswer = false;

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (isInternalProcessHeading(line)) {
      mode = "internal";
      sawInternal = true;
      internalLines.push(rawLine);
      continue;
    }
    if (isFinalAnswerHeading(line)) {
      mode = "body";
      sawAnswer = true;
      continue;
    }

    if (mode === "internal") {
      internalLines.push(rawLine);
    } else {
      bodyLines.push(rawLine);
    }
  }

  const body = bodyLines.join("\n").trim();
  const thinking = internalLines.join("\n").trim();
  if (!sawInternal) {
    return { body: value };
  }
  if (!body && !sawAnswer) {
    return { body: "", thinking };
  }
  return { body, thinking: thinking || undefined };
}

function isInternalProcessHeading(value: string): boolean {
  if (
    /^(思考链|思考过程|推理过程|深度思考|运行代码|代码运行|运行过程|执行过程|工具调用|工具执行|中间步骤|过程|Reasoning|Thinking|Chain of thought|Running code|Code execution|Execution process|Tool call|Tool calls|Tool output|Intermediate steps?)\s*[:：]?$/i.test(
      value,
    )
  ) {
    return true;
  }
  return /^(思考链|思考过程|推理过程|深度思考|运行代码|代码运行|运行过程|执行过程|工具调用|工具执行|中间步骤|过程|Reasoning|Thinking|Chain of thought|Running code|Code execution|Execution process|Tool call|Tool calls|Tool output|Intermediate steps?)\s*[:：]?$/i.test(
    value,
  );
}

function isFinalAnswerHeading(value: string): boolean {
  if (/^(最终答案|答案|回答|结论|结果|正文|Answer|Final answer|Result|Response)\s*[:：]?$/i.test(value)) {
    return true;
  }
  return /^(最终答案|答案|回答|结论|结果|正文|Answer|Final answer|Result|Response)\s*[:：]?$/i.test(
    value,
  );
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
  if (
    /(^|\n)(用户消息|当前文献|论文内容|网页搜索上下文|User message|Zotero context|Paper content|MCP context|Web search context)[:：]/i.test(
      text,
    ) &&
    /Final answer format|ZOTERO_WEBAI_MCP_REQUEST|Available Zotero MCP tools|Note: the paper text was truncated by Zotero WebAI/i.test(
      text,
    )
  ) {
    return true;
  }
  return (hasPromptSections && (hasZoteroTruncation || hasMCPJsonEcho)) ||
    (hasPromptSections && text.length > 1200 && !/[。！？.!?]\s*\n/.test(text));
}

function looksLikeInternalBridgeOutput(value: string): boolean {
  const text = normalizeCapturedText(value);
  if (!text) {
    return false;
  }
  if (
    /ZOTERO_WEBAI_MCP_REQUEST|END_ZOTERO_WEBAI_MCP_REQUEST/.test(text) ||
    /Zotero WebAI MCP tool (result|error):/i.test(text) ||
    /Zotero MCP bridge:/i.test(text) ||
    /Available Zotero MCP tools \(\d+\):/i.test(text) ||
    /Final answer format:\s*reply only with the user-facing result/i.test(text)
  ) {
    return true;
  }

  const hasToolArguments =
    /(^|\n)Tool:\s*\S+/i.test(text) && /(^|\n)Arguments:\s*[{[]/i.test(text);
  const hasBridgeInstruction =
    /Use this Zotero MCP result|MCP context:|Tool used:|inputSchema:/i.test(
      text,
    );
  if (hasToolArguments && hasBridgeInstruction) {
    return true;
  }

  const rawJSONMarkers = [
    '"appliedModeConfig"',
    '"pagination"',
    '"searchTime"',
    '"matchedChunks"',
    '"structuredContent"',
    '"isError"',
  ].filter((marker) => text.includes(marker));
  return rawJSONMarkers.length >= 2 && /^[\s{[]/.test(text);
}

function renderMarkdownContent(
  value: string,
  theme: SidebarTheme,
): React.ReactNode {
  const blocks = parseMarkdownBlocks(formatMarkdownForDisplay(value));
  if (!blocks.length) {
    return null;
  }

  return (
    <div style={styles.markdownRoot}>
      {blocks.map((block, index) => renderMarkdownBlock(block, index, theme))}
    </div>
  );
}

function formatMarkdownForDisplay(value: string): string {
  const text = normalizeCapturedText(value);
  if (!text) {
    return "";
  }
  if (looksLikeReadableMarkdown(text)) {
    return text;
  }
  return enrichPlainTextAsMarkdown(text)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function looksLikeReadableMarkdown(value: string): boolean {
  const text = normalizeCapturedText(value);
  if (!text) {
    return false;
  }
  return (
    /(^|\n)\s*(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+|```|\$\$)/.test(text) ||
    /\|.+\|\s*\n\s*\|[-:\s|]+\|/.test(text)
  );
}

function enrichPlainTextAsMarkdown(value: string): string {
  let formatted = normalizeCapturedText(value).replace(/[ \t]{2,}/g, " ");
  formatted = promoteDenseOrdinalHeadings(formatted);
  formatted = promoteSummaryHeading(formatted);
  formatted = promoteInlineLabelsToBullets(formatted);
  formatted = splitLongPlainParagraphs(formatted);
  return formatted;
}

function promoteDenseOrdinalHeadings(value: string): string {
  const cjkOrdinal =
    "\u4e00\u4e8c\u4e09\u56db\u4e94\u516d\u4e03\u516b\u4e5d\u5341";
  const headingPattern = new RegExp(
    `(^|[\\s\\u3002\\uff01\\uff1f!?;\\uff1b])((?:[${cjkOrdinal}]+\\u3001|[\\uff08(][${cjkOrdinal}]+[\\uff09)]))\\s*([^\\n\\u3002\\uff01\\uff1f!?;\\uff1b:：]{1,34}?)[\\uff1a:]\\s*`,
    "g",
  );
  return value.replace(
    headingPattern,
    (match: string, prefix: string, marker: string, title: string) => {
      const lead = prefix && /\S/.test(prefix) ? `${prefix.trim()}\n\n` : "\n\n";
      const spacer = marker.endsWith("\u3001") ? "" : " ";
      return `${lead}## ${marker}${spacer}${title.trim()}\n\n`;
    },
  );
}

function promoteSummaryHeading(value: string): string {
  const summaryPattern =
    /([\u3002\uff01\uff1f!?])\s*((?:\u7efc\u4e0a\u6240\u8ff0|\u603b\u4e4b|\u56e0\u6b64)[\uff0c,])/g;
  return value.replace(
    summaryPattern,
    (match: string, prefix: string, summaryLead: string) =>
      `${prefix}\n\n## \u603b\u7ed3\n\n${summaryLead}`,
  );
}

function promoteInlineLabelsToBullets(value: string): string {
  const labelPattern =
    /(^|[\n\u3002\uff01\uff1f\uff1b;!?])\s*([\u3400-\u9fffA-Za-z][\u3400-\u9fffA-Za-z0-9\uff08\uff09()\/\-.\s]{1,26})[\uff1a:]\s*/g;
  return value.replace(
    labelPattern,
    (match: string, prefix: string, label: string) => {
      const normalizedLabel = normalizeInlineLabel(label);
      if (!shouldPromoteInlineLabel(normalizedLabel)) {
        return match;
      }
      const lead = prefix && /\S/.test(prefix) ? `${prefix}\n` : "\n";
      return `${lead}- **${normalizedLabel}\uFF1A** `;
    },
  );
}

function normalizeInlineLabel(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function shouldPromoteInlineLabel(label: string): boolean {
  if (label.length < 2 || label.length > 26) {
    return false;
  }
  if (/[,\uFF0C\u3002\uFF01\uFF1F!?;\uFF1B:\uFF1A]/.test(label)) {
    return false;
  }
  if (
    /^(query|tool|arguments|command|user message|metadata|source|url|doi|pmid|arxiv|json|xml)$/i.test(
      label,
    )
  ) {
    return false;
  }
  if (/\d$|\d{2,}/.test(label)) {
    return false;
  }
  const cjkMatches = label.match(/[\u3400-\u9fff]/g) || [];
  return cjkMatches.length >= 2 || /^[A-Za-z][A-Za-z /.-]{2,26}$/.test(label);
}

function splitLongPlainParagraphs(value: string): string {
  return value
    .split(/\n{2,}/)
    .map((paragraph) => splitLongPlainParagraph(paragraph.trim()))
    .filter(Boolean)
    .join("\n\n");
}

function splitLongPlainParagraph(paragraph: string): string {
  if (
    paragraph.length < 280 ||
    /^(#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+|```|\$\$)/.test(paragraph)
  ) {
    return paragraph;
  }

  const sentences =
    paragraph.match(/[^\u3002\uff01\uff1f!?]+[\u3002\uff01\uff1f!?]?/g) || [];
  const cleanSentences = sentences.map((sentence) => sentence.trim()).filter(Boolean);
  if (cleanSentences.length <= 1) {
    return paragraph;
  }

  const groups: string[] = [];
  let current = "";
  cleanSentences.forEach((sentence) => {
    if (current && current.length + sentence.length > 220) {
      groups.push(current);
      current = sentence;
      return;
    }
    current = current ? `${current} ${sentence}` : sentence;
  });
  if (current) {
    groups.push(current);
  }
  return groups.join("\n\n");
}

function parseMarkdownBlocks(value: string): MarkdownBlock[] {
  const lines = normalizeCapturedText(value).split("\n");
  const blocks: MarkdownBlock[] = [];
  const paragraphLines: string[] = [];

  const flushParagraph = () => {
    const text = paragraphLines.join("\n").trim();
    if (text) {
      blocks.push({ text, type: "paragraph" });
    }
    paragraphLines.length = 0;
  };

  for (let index = 0; index < lines.length;) {
    const rawLine = lines[index] || "";
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      index += 1;
      continue;
    }

    if (line.startsWith("```")) {
      flushParagraph();
      const codeLines: string[] = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith("```")) {
        codeLines.push(lines[index]);
        index += 1;
      }
      if (index < lines.length) {
        index += 1;
      }
      blocks.push({
        text: codeLines.join("\n").replace(/\s+$/, ""),
        type: "code",
      });
      continue;
    }

    if (line.startsWith("$$")) {
      flushParagraph();
      if (line.endsWith("$$") && line.length > 4) {
        blocks.push({ text: line.slice(2, -2).trim(), type: "math" });
        index += 1;
        continue;
      }
      const mathLines: string[] = [];
      const firstLine = line.replace(/^\$\$\s*/, "");
      if (firstLine) {
        mathLines.push(firstLine);
      }
      index += 1;
      while (index < lines.length) {
        const currentLine = lines[index] || "";
        if (currentLine.trim().endsWith("$$")) {
          const closingLine = currentLine.replace(/\s*\$\$\s*$/, "");
          if (closingLine.trim()) {
            mathLines.push(closingLine);
          }
          index += 1;
          break;
        }
        mathLines.push(currentLine);
        index += 1;
      }
      blocks.push({ text: mathLines.join("\n").trim(), type: "math" });
      continue;
    }

    const headingMatch = line.match(/^(#{1,3})\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      blocks.push({
        level: headingMatch[1].length as 1 | 2 | 3,
        text: headingMatch[2].trim(),
        type: "heading",
      });
      index += 1;
      continue;
    }

    if (isMarkdownTableStart(lines, index)) {
      flushParagraph();
      const tableLines: string[] = [];
      while (index < lines.length && isMarkdownTableLine(lines[index] || "")) {
        tableLines.push(lines[index] || "");
        index += 1;
      }
      const table = parseMarkdownTable(tableLines);
      if (table) {
        blocks.push(table);
      }
      continue;
    }

    const unorderedMatch = line.match(/^[-*+]\s+(.+)$/);
    const orderedMatch = line.match(/^\d+[.)]\s+(.+)$/);
    if (unorderedMatch || orderedMatch) {
      flushParagraph();
      const ordered = Boolean(orderedMatch);
      const items: MarkdownListItem[] = [];
      let currentItem: MarkdownListItem | null = null;
      const pushCurrentItem = () => {
        if (currentItem?.text.trim()) {
          items.push({
            level: currentItem.level,
            text: currentItem.text.trim(),
          });
        }
        currentItem = null;
      };
      while (index < lines.length) {
        const currentRaw = lines[index] || "";
        const current = currentRaw.trim();
        if (!current) {
          break;
        }
        const match = ordered
          ? currentRaw.match(/^(\s*)\d+[.)]\s+(.+)$/)
          : currentRaw.match(/^(\s*)[-*+]\s+(.+)$/);
        if (match) {
          pushCurrentItem();
          currentItem = {
            level: Math.floor((match[1] || "").replace(/\t/g, "  ").length / 2),
            text: match[2].trim(),
          };
          index += 1;
          continue;
        }
        if (isMarkdownBlockBoundary(current)) {
          break;
        }
        if (currentItem) {
          currentItem.text = `${currentItem.text}\n${currentRaw.trim()}`;
        } else {
          currentItem = {
            level: 0,
            text: currentRaw.trim(),
          };
        }
        index += 1;
      }
      pushCurrentItem();
      blocks.push({ items, ordered, type: "list" });
      continue;
    }

    if (line.startsWith(">")) {
      flushParagraph();
      const quoteLines: string[] = [];
      while (index < lines.length && lines[index].trim().startsWith(">")) {
        quoteLines.push(lines[index].trim().replace(/^>\s?/, ""));
        index += 1;
      }
      blocks.push({ text: quoteLines.join("\n").trim(), type: "blockquote" });
      continue;
    }

    paragraphLines.push(rawLine);
    index += 1;
  }

  flushParagraph();
  return blocks;
}

function isMarkdownBlockBoundary(line: string): boolean {
  return /^(#{1,6}\s+|```|\$\$|>\s+)/.test(line) || isMarkdownTableLine(line);
}

function isMarkdownTableStart(lines: string[], index: number): boolean {
  return (
    isMarkdownTableLine(lines[index] || "") &&
    Boolean((lines[index + 1] || "").match(/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/))
  );
}

function isMarkdownTableLine(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && /^\|?.+\|.+\|?$/.test(trimmed);
}

function parseMarkdownTable(lines: string[]): MarkdownBlock | null {
  if (lines.length < 2) {
    return null;
  }
  const rows = lines
    .filter((line, index) => index !== 1)
    .map(splitMarkdownTableRow)
    .filter((row) => row.length);
  if (!rows.length) {
    return null;
  }
  return {
    headers: rows[0],
    rows: rows.slice(1),
    type: "table",
  };
}

function splitMarkdownTableRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const character of trimmed) {
    if (escaped) {
      current += character;
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (character === "|") {
      cells.push(current.trim());
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current.trim());
  return cells;
}

function renderMarkdownBlock(
  block: MarkdownBlock,
  index: number,
  theme: SidebarTheme,
): React.ReactNode {
  const key = `md-${index}`;
  if (block.type === "heading") {
    return (
      <div
        key={key}
        style={{
          ...styles.markdownHeading,
          color: theme.text,
          fontSize:
            block.level === 1
              ? typography.headingMd
              : block.level === 2
                ? typography.headingSm
                : typography.body,
        }}
      >
        {renderInlineMarkdown(block.text, key, theme)}
      </div>
    );
  }
  if (block.type === "list") {
    const ListTag = block.ordered ? "ol" : "ul";
    return (
      <ListTag key={key} style={styles.markdownList}>
        {block.items.map((item, itemIndex) => (
          <li
            key={`${key}-item-${itemIndex}`}
            style={{
              ...styles.markdownListItem,
              marginLeft: item.level ? `${item.level * 18}px` : 0,
            }}
          >
            {renderInlineMarkdown(item.text, `${key}-item-${itemIndex}`, theme)}
          </li>
        ))}
      </ListTag>
    );
  }
  if (block.type === "table") {
    return (
      <div key={key} style={styles.markdownTableWrapper}>
        <table style={styles.markdownTable}>
          <thead>
            <tr>
              {block.headers.map((header, headerIndex) => (
                <th
                  key={`${key}-head-${headerIndex}`}
                  style={{
                    ...styles.markdownTableHeader,
                    background: theme.inputBackground,
                    borderColor: theme.softBorder,
                    color: theme.text,
                  }}
                >
                  {renderInlineMarkdown(header, `${key}-head-${headerIndex}`, theme)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {block.rows.map((row, rowIndex) => (
              <tr key={`${key}-row-${rowIndex}`}>
                {block.headers.map((_, cellIndex) => (
                  <td
                    key={`${key}-cell-${rowIndex}-${cellIndex}`}
                    style={{
                      ...styles.markdownTableCell,
                      borderColor: theme.softBorder,
                      color: theme.text,
                    }}
                  >
                    {renderInlineMarkdown(
                      row[cellIndex] || "",
                      `${key}-cell-${rowIndex}-${cellIndex}`,
                      theme,
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  if (block.type === "blockquote") {
    return (
      <blockquote
        key={key}
        style={{
          ...styles.markdownBlockquote,
          borderColor: theme.badgeBorder,
          color: theme.mutedText,
        }}
      >
        {renderInlineMarkdown(block.text, key, theme)}
      </blockquote>
    );
  }
  if (block.type === "code") {
    return (
      <pre
        key={key}
        style={{
          ...styles.markdownCodeBlock,
          background: theme.inputBackground,
          borderColor: theme.softBorder,
          color: theme.text,
        }}
      >
        {block.text}
      </pre>
    );
  }
  if (block.type === "math") {
    return (
      <pre
        key={key}
        style={{
          ...styles.markdownMathBlock,
          background: theme.inputBackground,
          borderColor: theme.badgeBorder,
          color: theme.text,
        }}
      >
        {`$$\n${block.text}\n$$`}
      </pre>
    );
  }
  return (
    <p key={key} style={styles.markdownParagraph}>
      {renderInlineMarkdown(block.text, key, theme)}
    </p>
  );
}

function renderInlineMarkdown(
  text: string,
  keyPrefix: string,
  theme: SidebarTheme,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const tokenPattern =
    /(\$\$[\s\S]+?\$\$|`[^`\n]+`|\*\*[\s\S]+?\*\*|\*[^*\n]+?\*|\[[^\]\n]+\]\([^)]+\))/g;
  const appendPlain = (plain: string) => {
    if (!plain) {
      return;
    }
    const parts = plain.split("\n");
    parts.forEach((part, partIndex) => {
      if (part) {
        nodes.push(
          <React.Fragment key={`${keyPrefix}-text-${nodes.length}`}>
            {part}
          </React.Fragment>,
        );
      }
      if (partIndex < parts.length - 1) {
        nodes.push(<br key={`${keyPrefix}-br-${nodes.length}`} />);
      }
    });
  };

  let lastIndex = 0;
  for (const match of text.matchAll(tokenPattern)) {
    appendPlain(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = `${keyPrefix}-inline-${nodes.length}`;
    if (token.startsWith("$$")) {
      nodes.push(
        <code
          key={key}
          style={{
            ...styles.markdownInlineMath,
            background: theme.inputBackground,
            borderColor: theme.badgeBorder,
            color: theme.text,
          }}
        >
          {token}
        </code>,
      );
    } else if (token.startsWith("`")) {
      nodes.push(
        <code
          key={key}
          style={{
            ...styles.markdownInlineCode,
            background: theme.inputBackground,
            borderColor: theme.softBorder,
            color: theme.text,
          }}
        >
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**")) {
      nodes.push(
        <strong key={key}>
          {renderInlineMarkdown(token.slice(2, -2), key, theme)}
        </strong>,
      );
    } else if (token.startsWith("*")) {
      nodes.push(
        <em key={key}>
          {renderInlineMarkdown(token.slice(1, -1), key, theme)}
        </em>,
      );
    } else {
      const linkMatch = token.match(/^\[([^\]\n]+)\]\(([^)]+)\)$/);
      const label = linkMatch?.[1] || token;
      const url = linkMatch?.[2] || "";
      nodes.push(
        <a
          href={url || undefined}
          key={key}
          onClick={(event) => {
            if (/^https?:\/\//i.test(url)) {
              event.preventDefault();
              openExternalURL(url);
            }
          }}
          rel="noreferrer"
          style={{ ...styles.markdownLink, color: theme.badgeText }}
        >
          {label}
        </a>,
      );
    }
    lastIndex = (match.index || 0) + token.length;
  }
  appendPlain(text.slice(lastIndex));
  return nodes;
}

async function waitForStableAssistantText(
  frame: Element | null,
  baselineText: string,
  shouldContinue: () => boolean,
  sourcePrompt = "",
  getPreviousCapture: () => string = () => "",
): Promise<string> {
  const baseline = extractAssistantCandidate(
    baselineText,
    sourcePrompt,
    getPreviousCapture(),
  ).body;
  let bestCandidate = "";
  let stableReads = 0;

  for (let attempt = 0; attempt < 55; attempt += 1) {
    if (!shouldContinue()) {
      return "";
    }
    await sleepWithHostTimer(attempt < 2 ? 1000 : 1500);
    const result = await readLatestAssistantText(frame);
    if (!result.ok || !result.text) {
      continue;
    }
    const candidate = extractAssistantCandidate(
      result.text,
      sourcePrompt,
      getPreviousCapture(),
    );
    if (
      !candidate.body ||
      candidate.body === baseline ||
      candidate.body.trim().length < 1 ||
      looksLikeInternalBridgeOutput(candidate.body)
    ) {
      continue;
    }
    if (candidate.body === bestCandidate) {
      stableReads += 1;
    } else {
      bestCandidate = candidate.body;
      stableReads = 0;
    }
    if (stableReads >= 2) {
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
    fontFamily:
      'Arial, "Helvetica Neue", "Segoe UI", system-ui, sans-serif',
    gap: "8px",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    width: "100%",
  },
  frameHost: {
    border: "1px solid #e0e0e0",
    borderRadius: "6px",
    boxSizing: "border-box",
    display: "flex",
    flex: "1 1 auto",
    maxHeight: "82vh",
    maxWidth: "100%",
    minHeight: "420px",
    minWidth: 0,
    overflow: "auto",
    resize: "vertical",
    width: "100%",
  },
  readerFrameHost: {
    flex: "0 0 auto",
    height: "220px",
    maxHeight: "70vh",
    minHeight: "180px",
    resize: "vertical",
  },
  frameHostCollapsed: {
    display: "none",
  },
  loginFrameHost: {
    flex: "1 1 auto",
    maxHeight: "none",
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
    borderRadius: "10px",
    boxSizing: "border-box",
    display: "flex",
    flex: "0 0 auto",
    flexDirection: "column",
    gap: "10px",
    height: "430px",
    maxHeight: "78vh",
    minHeight: "260px",
    minWidth: 0,
    overflow: "auto",
    padding: "10px",
    resize: "vertical",
    width: "100%",
  },
  readerExecutionPanel: {
    flex: "1 1 auto",
    height: "560px",
    maxHeight: "none",
    minHeight: "280px",
    resize: "vertical",
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
    gap: "10px",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
  },
  historyPanel: {
    border: "1px solid #e0e0e0",
    borderRadius: "8px",
    boxSizing: "border-box",
    display: "flex",
    flex: "0 1 34%",
    flexDirection: "column",
    gap: "8px",
    maxHeight: "100%",
    maxWidth: "42%",
    minHeight: 0,
    minWidth: "160px",
    overflow: "auto",
    padding: "8px",
    resize: "vertical",
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
  historyEmpty: {
    fontSize: typography.meta,
    lineHeight: 1.45,
    padding: "8px",
  },
  executionList: {
    display: "flex",
    flex: "1 1 auto",
    flexDirection: "column",
    gap: "18px",
    maxHeight: "100%",
    maxWidth: "100%",
    minWidth: 0,
    minHeight: 0,
    overflow: "auto",
    padding: "4px 8px 12px",
    resize: "vertical",
    width: "100%",
  },
  emptyConversation: {
    alignItems: "center",
    display: "flex",
    flex: "1 1 auto",
    fontSize: typography.meta,
    justifyContent: "center",
    lineHeight: 1.5,
    minHeight: "120px",
    padding: "16px",
    textAlign: "center",
  },
  chatTurn: {
    borderRadius: "10px",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    minWidth: 0,
    outlineOffset: "2px",
    padding: "2px",
  },
  messageRow: {
    display: "flex",
    minWidth: 0,
    width: "100%",
  },
  userMessageRow: {
    justifyContent: "flex-end",
  },
  assistantMessageRow: {
    justifyContent: "flex-start",
  },
  userBubble: {
    border: "1px solid #d7eed7",
    borderRadius: "14px",
    boxSizing: "border-box",
    maxWidth: "78%",
    minWidth: "160px",
    overflow: "auto",
    padding: "13px 16px",
    resize: "vertical",
    MozUserSelect: "text",
    userSelect: "text",
  },
  assistantBubble: {
    border: "1px solid #e2e2e2",
    borderRadius: "14px",
    boxSizing: "border-box",
    maxWidth: "100%",
    minHeight: "80px",
    minWidth: "220px",
    overflow: "auto",
    padding: "14px 16px",
    resize: "vertical",
    MozUserSelect: "text",
    userSelect: "text",
    width: "100%",
  },
  messageHeader: {
    alignItems: "center",
    display: "flex",
    gap: "10px",
    justifyContent: "space-between",
    marginBottom: "8px",
    minWidth: 0,
  },
  messageAuthor: {
    fontSize: typography.body,
    fontWeight: 700,
    lineHeight: 1.3,
  },
  messageTimestamp: {
    flex: "0 0 auto",
    fontSize: typography.caption,
    lineHeight: 1.25,
    whiteSpace: "nowrap",
  },
  userMessageBody: {
    fontSize: typography.body,
    lineHeight: 1.58,
    MozUserSelect: "text",
    overflowWrap: "anywhere",
    userSelect: "text",
    whiteSpace: "normal",
    wordBreak: "break-word",
  },
  assistantTitleLine: {
    alignItems: "center",
    display: "flex",
    flex: "1 1 auto",
    flexWrap: "wrap",
    gap: "8px",
    minWidth: 0,
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
    borderRadius: "6px",
    flex: "0 0 auto",
    fontSize: typography.meta,
    fontWeight: 700,
    lineHeight: 1.25,
    padding: "2px 7px",
  },
  executionSummaryText: {
    display: "flex",
    flex: "1 1 auto",
    flexDirection: "column",
    minWidth: 0,
  },
  executionItemTitle: {
    fontSize: typography.body,
    fontWeight: 700,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  executionItemSubtitle: {
    fontSize: typography.meta,
    lineHeight: 1.35,
    marginBottom: "8px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  executionBody: {
    background: "transparent",
    border: 0,
    fontFamily: "inherit",
    fontSize: typography.body,
    lineHeight: 1.72,
    margin: "10px 0 0",
    maxHeight: "none",
    overflow: "auto",
    padding: 0,
    MozUserSelect: "text",
    userSelect: "text",
    whiteSpace: "normal",
    wordBreak: "break-word",
  },
  markdownRoot: {
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    minWidth: 0,
    MozUserSelect: "text",
    userSelect: "text",
    width: "100%",
  },
  markdownParagraph: {
    lineHeight: 1.72,
    margin: "0 0 2px",
    overflowWrap: "anywhere",
    whiteSpace: "normal",
    wordBreak: "break-word",
  },
  markdownHeading: {
    fontWeight: 700,
    lineHeight: 1.38,
    margin: "6px 0 1px",
    overflowWrap: "anywhere",
    wordBreak: "break-word",
  },
  markdownList: {
    lineHeight: 1.68,
    margin: "0 0 2px",
    paddingInlineStart: "22px",
  },
  markdownListItem: {
    margin: "5px 0",
    overflowWrap: "anywhere",
    wordBreak: "break-word",
  },
  markdownTableWrapper: {
    maxWidth: "100%",
    overflow: "auto",
  },
  markdownTable: {
    borderCollapse: "collapse",
    fontSize: typography.meta,
    lineHeight: 1.55,
    minWidth: "100%",
    tableLayout: "auto",
  },
  markdownTableHeader: {
    border: "1px solid #e0e0e0",
    fontWeight: 700,
    padding: "6px 8px",
    textAlign: "left",
    verticalAlign: "top",
    whiteSpace: "normal",
  },
  markdownTableCell: {
    border: "1px solid #e0e0e0",
    padding: "6px 8px",
    textAlign: "left",
    verticalAlign: "top",
    whiteSpace: "normal",
  },
  markdownBlockquote: {
    borderLeft: "3px solid #d6e5f4",
    lineHeight: 1.65,
    margin: 0,
    padding: "4px 0 4px 10px",
    whiteSpace: "pre-wrap",
  },
  markdownCodeBlock: {
    border: "1px solid #e0e0e0",
    borderRadius: "6px",
    boxSizing: "border-box",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace",
    fontSize: typography.meta,
    lineHeight: 1.5,
    margin: 0,
    maxWidth: "100%",
    overflow: "auto",
    padding: "8px 10px",
    whiteSpace: "pre",
  },
  markdownMathBlock: {
    border: "1px solid #d6e5f4",
    borderRadius: "6px",
    boxSizing: "border-box",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace",
    fontSize: typography.meta,
    lineHeight: 1.55,
    margin: 0,
    maxWidth: "100%",
    overflow: "auto",
    padding: "8px 10px",
    whiteSpace: "pre-wrap",
  },
  markdownInlineCode: {
    border: "1px solid #e0e0e0",
    borderRadius: "4px",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace",
    fontSize: "0.94em",
    padding: "1px 4px",
    whiteSpace: "break-spaces",
  },
  markdownInlineMath: {
    border: "1px solid #d6e5f4",
    borderRadius: "4px",
    fontFamily:
      "ui-monospace, SFMono-Regular, Menlo, Consolas, Liberation Mono, monospace",
    fontSize: "0.94em",
    padding: "1px 4px",
    whiteSpace: "break-spaces",
  },
  markdownLink: {
    cursor: "pointer",
    textDecoration: "underline",
    textUnderlineOffset: "2px",
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
    userSelect: "text",
    whiteSpace: "pre-wrap",
    wordBreak: "break-word",
  },
  recordActions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    justifyContent: "flex-start",
    marginTop: "12px",
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
    borderRadius: "10px",
    display: "flex",
    flex: "0 0 auto",
    flexDirection: "column",
    gap: "8px",
    minHeight: "180px",
    minWidth: 0,
    overflow: "auto",
    padding: "11px 12px 10px",
    position: "relative",
    resize: "vertical",
    width: "100%",
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
    lineHeight: 1.55,
    maxHeight: "260px",
    minHeight: "108px",
    outline: "none",
    padding: "2px 0 4px",
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
