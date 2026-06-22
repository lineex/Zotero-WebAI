import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AssembledContext } from "../../services/contextAssembler";
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

const PROMPT_TEXT_LIMIT = 60000;
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
}) => {
  const [service, setService] = useState<WebAIService>(SERVICES[0]);
  const [status, setStatus] = useState(`Loaded ${SERVICES[0].label}`);
  const [isError, setIsError] = useState(false);
  const [message, setMessage] = useState("");
  const [selectedSkillID, setSelectedSkillID] = useState<string | null>(null);
  const [showCopiedPrompt, setShowCopiedPrompt] = useState(false);
  const [copiedPrompt, setCopiedPrompt] = useState("");
  const frameHostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<Element | null>(null);
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
    host.appendChild(frame);
    setStatus(`Loaded ${service.label}. Sign in, then paste copied prompts into the web chat.`);
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
    setStatus(`${incomingPrompt.label} is ready. Send copies it into ${service.label}.`);
    setIsError(false);
    onIncomingPromptHandled?.(incomingPrompt.id);
  }, [incomingPrompt, onIncomingPromptHandled, service.label]);

  const copyPrompt = (prompt: string) => {
    copyTextToClipboard(prompt);
    focusFrame(frameRef.current);
    setCopiedPrompt(prompt);
    setShowCopiedPrompt(false);
    setStatus(`Prompt copied (${prompt.length} characters). Paste it into ${service.label}.`);
    setIsError(false);
  };

  const runAction = (action: () => void) => {
    try {
      action();
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

  const sendPrompt = () => {
    const resolved = resolveSkillFromMessage(message, customSkills, selectedSkill);
    if (resolved.skill && resolved.skill.id !== selectedSkillID) {
      setSelectedSkillID(resolved.skill.id);
    }
    const prompt = buildWorkspacePrompt({
      contextSummary,
      message: resolved.message,
      scope,
      selectedSkill: resolved.skill,
    });
    copyPrompt(prompt);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      runAction(sendPrompt);
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
              runAction(() => loadFrameElement(frameRef.current, service.url))
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
            onClick={() => runAction(sendPrompt)}
            title="Copy prompt and focus the web chat"
            type="button"
          >
            Send
          </button>
        </div>

        {copiedPrompt && (
          <button
            style={{
              ...styles.previewToggle,
              color: theme.buttonText,
            }}
            onClick={() => setShowCopiedPrompt((value) => !value)}
            type="button"
          >
            {showCopiedPrompt ? "Hide copied prompt" : "Show copied prompt"}
          </button>
        )}

        {copiedPrompt && showCopiedPrompt && (
          <textarea
            readOnly
            style={{
              ...styles.generatedPrompt,
              background: theme.inputBackground,
              borderColor: theme.inputBorder,
              color: theme.text,
            }}
            value={copiedPrompt}
          />
        )}
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

function buildWorkspacePrompt({
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
  previewToggle: {
    alignSelf: "flex-start",
    appearance: "none",
    background: "transparent",
    border: 0,
    cursor: "pointer",
    fontSize: typography.meta,
    padding: 0,
  },
  generatedPrompt: {
    border: "1px solid #d4d4d4",
    borderRadius: "8px",
    boxSizing: "border-box",
    font: "inherit",
    fontSize: typography.meta,
    lineHeight: 1.4,
    maxHeight: "150px",
    minHeight: "76px",
    padding: "7px 8px",
    resize: "vertical",
    width: "100%",
  },
};
