import React, { useEffect, useMemo, useRef, useState } from "react";
import { FilePickerHelper } from "zotero-plugin-toolkit";
import type { AssembledContext } from "../../services/contextAssembler";
import { callMCPTool } from "../../services/mcpClient";
import {
  getAllPresets,
  type CommandPreset,
} from "../../services/presets";
import {
  getEvidenceSettingsIssue,
  type Settings,
} from "../../services/settingsManager";
import type { ScopeContext } from "../../types/scope";
import { getSidebarTheme } from "../theme";
import { typography } from "../typography";

type WebAIServiceId = "deepseek" | "zai";
type PromptSourceMode = "paper" | "selection" | "imported-pdf" | "image";

interface WebAIService {
  id: WebAIServiceId;
  label: string;
  url: string;
}

interface ImportedPDFInput {
  attachmentID?: number;
  label: string;
  path: string;
}

interface ImageInput {
  label: string;
  name: string;
  previewURL?: string;
  size: number;
  type: string;
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
  description: string;
  id: string;
  label: string;
  promptPrefix: string;
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

const WEB_ONLY_SKILLS: WebAISkill[] = [
  {
    id: "web-reading-note",
    label: "Reading Note",
    description: "Turn context into Zotero-ready notes",
    promptPrefix:
      "Create a Zotero-ready reading note in Chinese. Use concise sections: research question, methods, findings, limitations, reusable quotes or paraphrases, and follow-up questions. Separate paper evidence from your interpretation.",
  },
  {
    id: "web-image",
    label: "Image Input",
    description: "Analyze a selected image with paper context",
    promptPrefix:
      "Analyze the image I upload together with the Zotero context. Identify visual content, relevant labels or data, links to the paper argument, and what should be saved as notes. If the image is a figure, explain the figure panel by panel.",
  },
  {
    id: "web-mcp",
    label: "MCP Evidence",
    description: "Use MCP results as evidence inside the prompt",
    promptPrefix:
      "Use the MCP evidence and Zotero context below to answer carefully. Distinguish Zotero document facts, MCP evidence, and your own synthesis. List uncertainties and checks needed before citing.",
  },
  {
    id: "web-deep-research",
    label: "Deep Research",
    description: "DeepSeek++ style research workflow",
    promptPrefix:
      "Act as a research copilot. Build a rigorous reading workflow: extract the core claim, reconstruct the argument, test the evidence, compare with neighboring literature, and propose the next searches or experiments. Keep the answer structured and concise.",
  },
];

export const WebAIWorkspace: React.FC<WebAIWorkspaceProps> = ({
  contextSummary,
  customPresets = "",
  hostWindow,
  incomingPrompt,
  onIncomingPromptHandled,
  onScopeRefresh,
  settings,
  scope,
}) => {
  const [service, setService] = useState<WebAIService>(SERVICES[0]);
  const [status, setStatus] = useState(`Loaded ${SERVICES[0].label}`);
  const [isError, setIsError] = useState(false);
  const [noteDraft, setNoteDraft] = useState("");
  const [userInstruction, setUserInstruction] = useState("");
  const [selectedSkillID, setSelectedSkillID] = useState("summarize");
  const [sourceMode, setSourceMode] = useState<PromptSourceMode>("paper");
  const [promptDraft, setPromptDraft] = useState("");
  const [importedPDF, setImportedPDF] = useState<ImportedPDFInput | null>(null);
  const [imageInput, setImageInput] = useState<ImageInput | null>(null);
  const [mcpEvidence, setMcpEvidence] = useState("");
  const imageInputRef = useRef<HTMLInputElement>(null);
  const frameHostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<Element | null>(null);
  const theme = getSidebarTheme(hostWindow);

  const skills = useMemo(
    () => buildWebAISkills(scope?.type || null, customPresets),
    [customPresets, scope?.type],
  );
  const selectedSkill =
    skills.find((skill) => skill.id === selectedSkillID) || skills[0];

  useEffect(() => {
    if (selectedSkill && !skills.some((skill) => skill.id === selectedSkillID)) {
      setSelectedSkillID(selectedSkill.id);
    }
  }, [selectedSkill, selectedSkillID, skills]);

  useEffect(() => {
    const host = frameHostRef.current;
    if (!host) {
      return;
    }

    host.replaceChildren();
    const frame = createWebFrame(host.ownerDocument || hostWindow.document, service.url);
    frameRef.current = frame;
    host.appendChild(frame);
    setStatus(`Loaded ${service.label}. Sign in here, then paste copied prompts into the page.`);
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

    setPromptDraft(incomingPrompt.prompt);
    setUserInstruction(incomingPrompt.prompt);
    setSourceMode(incomingPrompt.sourceMode || "selection");
    setStatus(`${incomingPrompt.label} is ready. Copy it into ${service.label}.`);
    setIsError(false);
    onIncomingPromptHandled?.(incomingPrompt.id);
  }, [incomingPrompt, onIncomingPromptHandled, service.label]);

  useEffect(() => {
    return () => {
      if (imageInput?.previewURL) {
        URL.revokeObjectURL(imageInput.previewURL);
      }
    };
  }, [imageInput?.previewURL]);

  const runAction = async (action: () => Promise<void> | void) => {
    try {
      await action();
    } catch (error) {
      const message =
        error instanceof Error && error.message ? error.message : String(error);
      setStatus(`Failed: ${message}`);
      setIsError(true);
      ztoolkit.log("Web AI action failed:", error);
    }
  };

  const copyPrompt = async (prompt: string) => {
    copyTextToClipboard(prompt);
    focusFrame(frameRef.current);
    setPromptDraft(prompt);
    setStatus(`Prompt copied (${prompt.length} characters). Paste it into ${service.label}.`);
    setIsError(false);
  };

  const buildAndCopyPrompt = async (mode = sourceMode) => {
    const prompt = buildWorkspacePrompt({
      contextSummary,
      imageInput,
      importedPDF,
      mcpEvidence,
      scope,
      selectedSkill,
      sourceMode: mode,
      userInstruction,
    });
    await copyPrompt(prompt);
  };

  const handleImportPDF = async () => {
    const selectedPath = await pickPDFPath(hostWindow);
    if (!selectedPath) {
      setStatus("PDF import cancelled.");
      setIsError(false);
      return;
    }

    const parentItem = resolveParentItem(scope);
    const options: {
      contentType: string;
      file: nsIFile | string;
      libraryID?: number;
      parentItemID?: number;
      title: string;
    } = {
      contentType: "application/pdf",
      file: selectedPath,
      title: getFileName(selectedPath),
    };
    if (parentItem?.id) {
      options.parentItemID = parentItem.id;
    } else {
      const libraryID = getSelectedLibraryID();
      if (libraryID) {
        options.libraryID = libraryID;
      }
    }

    const attachment = await Zotero.Attachments.importFromFile(options);
    const label = attachment.getDisplayTitle?.() || getFileName(selectedPath);
    setImportedPDF({
      attachmentID: attachment.id,
      label,
      path: selectedPath,
    });
    setSourceMode("imported-pdf");
    onScopeRefresh?.();
    setStatus(`Imported PDF: ${label}. Build a prompt or open it in Zotero for full-text context.`);
    setIsError(false);
  };

  const handleImageInput = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    if (!file) {
      return;
    }
    if (imageInput?.previewURL) {
      URL.revokeObjectURL(imageInput.previewURL);
    }
    const previewURL = URL.createObjectURL(file);
    setImageInput({
      label: getBrowserFileLabel(file),
      name: file.name,
      previewURL,
      size: file.size,
      type: file.type || "image/*",
    });
    setSourceMode("image");
    setSelectedSkillID("web-image");
    setStatus("Image selected. Upload it in the web chat if the embedded page asks for a file.");
    setIsError(false);
  };

  const handleMCPFetch = async () => {
    const issue = getEvidenceSettingsIssue(settings);
    if (settings.evidenceProviderMode !== "mcp-http" || issue) {
      throw new Error(issue || "Select MCP HTTP in Zotero-WebAI settings first.");
    }
    const query =
      userInstruction.trim() ||
      scope?.selectedText?.trim() ||
      contextSummary?.metadata?.split("\n")[0]?.trim() ||
      scope?.label ||
      "";
    if (!query) {
      throw new Error("Write a question or select text before calling MCP.");
    }

    const results = await callMCPTool(settings, query);
    const evidence = results
      .map((item, index) =>
        [
          `Result ${index + 1}: ${item.title || "MCP result"}`,
          item.source ? `Source: ${item.source}` : "",
          item.url ? `URL: ${item.url}` : "",
          item.content ? `Content: ${item.content}` : "",
        ]
          .filter(Boolean)
          .join("\n"),
      )
      .join("\n\n");
    setMcpEvidence(evidence || "MCP returned no text content.");
    setSelectedSkillID("web-mcp");
    setStatus(`MCP evidence loaded (${results.length} result${results.length === 1 ? "" : "s"}).`);
    setIsError(false);
  };

  const selectedText =
    scope?.selectedText?.trim() || contextSummary?.selectedText?.trim() || "";
  const hasPDFContext = Boolean(contextSummary?.fullText || contextSummary?.metadata);

  return (
    <section
      style={{
        ...styles.container,
        background: theme.background,
        color: theme.text,
      }}
    >
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

      <div style={styles.utilityBar}>
        <button
          style={{
            ...styles.button,
            background: theme.surfaceBackground,
            borderColor: theme.buttonBorder,
            color: theme.buttonText,
          }}
          onClick={() => runAction(() => loadFrameElement(frameRef.current, service.url))}
          type="button"
        >
          Reload
        </button>
        <button
          style={{
            ...styles.button,
            background: theme.surfaceBackground,
            borderColor: theme.buttonBorder,
            color: theme.buttonText,
          }}
          onClick={() => openExternalURL(service.url)}
          type="button"
        >
          Open External
        </button>
        <button
          style={{
            ...styles.button,
            background: theme.surfaceBackground,
            borderColor: theme.buttonBorder,
            color: theme.buttonText,
          }}
          onClick={() => runAction(handleImportPDF)}
          type="button"
        >
          Import PDF
        </button>
        <button
          style={{
            ...styles.button,
            background: theme.surfaceBackground,
            borderColor: theme.buttonBorder,
            color: theme.buttonText,
          }}
          onClick={() => imageInputRef.current?.click()}
          type="button"
        >
          Image
        </button>
        <input
          ref={imageInputRef}
          accept="image/*"
          onChange={handleImageInput}
          style={{ display: "none" }}
          type="file"
        />
      </div>

      <div
        style={{
          ...styles.promptPanel,
          background: theme.surfaceBackground,
          borderColor: theme.softBorder,
        }}
      >
        <div style={styles.promptRow}>
          <label style={{ ...styles.fieldLabel, color: theme.mutedText }}>
            Skill
            <select
              onChange={(event) => setSelectedSkillID(event.target.value)}
              style={{
                ...styles.select,
                background: theme.inputBackground,
                borderColor: theme.inputBorder,
                color: theme.text,
              }}
              value={selectedSkill?.id || ""}
            >
              {skills.map((skill) => (
                <option key={skill.id} value={skill.id}>
                  {skill.label}
                </option>
              ))}
            </select>
          </label>
          <label style={{ ...styles.fieldLabel, color: theme.mutedText }}>
            Input
            <select
              onChange={(event) =>
                setSourceMode(event.target.value as PromptSourceMode)
              }
              style={{
                ...styles.select,
                background: theme.inputBackground,
                borderColor: theme.inputBorder,
                color: theme.text,
              }}
              value={sourceMode}
            >
              <option value="paper">PDF / paper context</option>
              <option value="selection">Selected text</option>
              <option value="imported-pdf">Imported PDF</option>
              <option value="image">Image</option>
            </select>
          </label>
        </div>

        <div style={{ ...styles.skillHint, color: theme.mutedText }}>
          {selectedSkill?.description || "Choose a reusable prompt workflow."}
        </div>

        <textarea
          style={{
            ...styles.promptInput,
            background: theme.inputBackground,
            borderColor: theme.inputBorder,
            color: theme.text,
          }}
          onChange={(event) => setUserInstruction(event.target.value)}
          placeholder="Write your question, reading goal, or extra instruction. Reader selected text will also appear here after you use the popup."
          value={userInstruction}
        />

        <div style={styles.actionBar}>
          <button
            disabled={!hasPDFContext && sourceMode === "paper"}
            style={{
              ...styles.button,
              ...(sourceMode === "paper" ? styles.activeButton : null),
              background: theme.surfaceBackground,
              borderColor: theme.buttonBorder,
              color: theme.buttonText,
            }}
            onClick={() => runAction(() => buildAndCopyPrompt("paper"))}
            type="button"
          >
            Copy PDF Prompt
          </button>
          <button
            disabled={!selectedText}
            style={{
              ...styles.button,
              ...(sourceMode === "selection" ? styles.activeButton : null),
              background: theme.surfaceBackground,
              borderColor: theme.buttonBorder,
              color: theme.buttonText,
            }}
            onClick={() => runAction(() => buildAndCopyPrompt("selection"))}
            type="button"
          >
            Copy Selection
          </button>
          <button
            disabled={!importedPDF}
            style={{
              ...styles.button,
              ...(sourceMode === "imported-pdf" ? styles.activeButton : null),
              background: theme.surfaceBackground,
              borderColor: theme.buttonBorder,
              color: theme.buttonText,
            }}
            onClick={() => runAction(() => buildAndCopyPrompt("imported-pdf"))}
            type="button"
          >
            Copy Imported PDF
          </button>
          <button
            disabled={!imageInput}
            style={{
              ...styles.button,
              ...(sourceMode === "image" ? styles.activeButton : null),
              background: theme.surfaceBackground,
              borderColor: theme.buttonBorder,
              color: theme.buttonText,
            }}
            onClick={() => runAction(() => buildAndCopyPrompt("image"))}
            type="button"
          >
            Copy Image Prompt
          </button>
          <button
            style={{
              ...styles.button,
              background: theme.surfaceBackground,
              borderColor: theme.buttonBorder,
              color: theme.buttonText,
            }}
            onClick={() => runAction(handleMCPFetch)}
            type="button"
          >
            MCP
          </button>
        </div>

        {(importedPDF || imageInput || mcpEvidence) && (
          <div style={styles.sourceList}>
            {importedPDF && (
              <div style={{ ...styles.sourceChip, borderColor: theme.softBorder }}>
                PDF: {importedPDF.label}
              </div>
            )}
            {imageInput && (
              <div style={{ ...styles.sourceChip, borderColor: theme.softBorder }}>
                Image: {imageInput.name}
              </div>
            )}
            {mcpEvidence && (
              <div style={{ ...styles.sourceChip, borderColor: theme.softBorder }}>
                MCP evidence loaded
              </div>
            )}
          </div>
        )}

        {imageInput?.previewURL && (
          <img
            alt={imageInput.name}
            src={imageInput.previewURL}
            style={{
              ...styles.imagePreview,
              borderColor: theme.softBorder,
            }}
          />
        )}

        {promptDraft && (
          <textarea
            readOnly
            style={{
              ...styles.generatedPrompt,
              background: theme.inputBackground,
              borderColor: theme.inputBorder,
              color: theme.text,
            }}
            value={promptDraft}
          />
        )}
      </div>

      <div
        style={{
          ...styles.status,
          color: isError ? theme.errorText : theme.mutedText,
        }}
      >
        {status}
      </div>

      <div
        ref={frameHostRef}
        style={{
          ...styles.frameHost,
          background: theme.surfaceBackground,
          borderColor: theme.softBorder,
        }}
      />

      <div style={styles.noteBox}>
        <textarea
          style={{
            ...styles.noteDraft,
            background: theme.inputBackground,
            borderColor: theme.inputBorder,
            color: theme.text,
          }}
          onChange={(event) => setNoteDraft(event.target.value)}
          placeholder="Paste or write the useful web answer here, then save it as a Zotero child note."
          value={noteDraft}
        />
        <div style={styles.noteActions}>
          <button
            style={{
              ...styles.button,
              background: theme.surfaceBackground,
              borderColor: theme.buttonBorder,
              color: theme.buttonText,
            }}
            onClick={() =>
              runAction(async () => {
                await saveDraftNote(scope, service.label, noteDraft, {
                  image: imageInput?.label,
                  importedPDF: importedPDF?.label,
                });
                setStatus("Saved to Zotero note.");
                setIsError(false);
              })
            }
            type="button"
          >
            Save Note
          </button>
          <button
            style={{
              ...styles.button,
              background: theme.surfaceBackground,
              borderColor: theme.buttonBorder,
              color: theme.buttonText,
            }}
            onClick={() => setNoteDraft("")}
            type="button"
          >
            Clear
          </button>
        </div>
      </div>
    </section>
  );
};

function buildWebAISkills(
  scopeType: ScopeContext["type"] | null,
  customPresetsValue: string,
): WebAISkill[] {
  const presets = getAllPresets(customPresetsValue)
    .filter((preset) => isPresetVisibleForScope(preset, scopeType))
    .map((preset) => ({
      description: preset.description,
      id: preset.id,
      label: preset.label,
      promptPrefix: preset.promptPrefix,
    }));

  const byID = new Map<string, WebAISkill>();
  for (const skill of [...presets, ...WEB_ONLY_SKILLS]) {
    byID.set(skill.id, skill);
  }
  return Array.from(byID.values());
}

function isPresetVisibleForScope(
  preset: CommandPreset,
  scopeType: ScopeContext["type"] | null,
): boolean {
  if (!scopeType || !preset.scopeHint) {
    return true;
  }
  return preset.scopeHint.includes(scopeType);
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
  imageInput,
  importedPDF,
  mcpEvidence,
  scope,
  selectedSkill,
  sourceMode,
  userInstruction,
}: {
  contextSummary: AssembledContext | null;
  imageInput: ImageInput | null;
  importedPDF: ImportedPDFInput | null;
  mcpEvidence: string;
  scope: ScopeContext | null;
  selectedSkill: WebAISkill | undefined;
  sourceMode: PromptSourceMode;
  userInstruction: string;
}): string {
  if (!selectedSkill) {
    throw new Error("No skill is available.");
  }

  const title = scope?.label || "Current Zotero context";
  const metadata = contextSummary?.metadata || "";
  const selectedText =
    scope?.selectedText?.trim() || contextSummary?.selectedText?.trim() || "";
  const fullText = truncateText(contextSummary?.fullText || "", PROMPT_TEXT_LIMIT);
  const instruction = userInstruction.trim();
  const parts = [
    selectedSkill.promptPrefix,
    instruction ? `My instruction:\n${instruction}` : "",
    `Zotero context:\n${title}`,
    metadata ? `Metadata:\n${metadata}` : "",
  ];

  if (sourceMode === "selection") {
    if (!selectedText) {
      throw new Error("Select text in the Zotero PDF reader first.");
    }
    parts.push(`Selected passage:\n${selectedText}`);
  } else if (sourceMode === "imported-pdf") {
    if (!importedPDF) {
      throw new Error("Import a PDF first.");
    }
    parts.push(
      [
        "Imported PDF input:",
        `Title: ${importedPDF.label}`,
        `Local path: ${importedPDF.path}`,
        importedPDF.attachmentID
          ? `Zotero attachment itemID: ${importedPDF.attachmentID}`
          : "",
        "If you cannot access local files directly, ask me to upload the PDF in the web chat and then analyze it with the Zotero context.",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } else if (sourceMode === "image") {
    if (!imageInput) {
      throw new Error("Choose an image first.");
    }
    parts.push(
      [
        "Image input:",
        `File: ${imageInput.label}`,
        `Type: ${imageInput.type}`,
        `Size: ${Math.round(imageInput.size / 1024)} KB`,
        "I will upload or paste the image in the web chat. Analyze the image together with the Zotero context.",
      ].join("\n"),
    );
  } else {
    if (!fullText && !metadata) {
      throw new Error("No readable paper context is available yet.");
    }
    parts.push(fullText ? `Paper content:\n${fullText}` : "");
  }

  if (mcpEvidence) {
    parts.push(`MCP evidence:\n${mcpEvidence}`);
  }

  if (contextSummary?.fullText && contextSummary.fullText.length > fullText.length) {
    parts.push(
      "Note: the paper text was truncated by Zotero-WebAI; continue from the available excerpt first.",
    );
  }

  return parts.filter(Boolean).join("\n\n");
}

async function pickPDFPath(hostWindow: Window): Promise<string | null> {
  const filters: [string, string][] = [["PDF (*.pdf)", "*.pdf"]];
  try {
    const selected = await new FilePickerHelper(
      "Import PDF into Zotero-WebAI",
      "open",
      filters,
      "",
      hostWindow,
    ).open();
    return normalizeFilePickerSelection(selected);
  } catch (error) {
    ztoolkit.log("Native PDF file picker failed:", error);
  }

  return null;
}

function normalizeFilePickerSelection(selection: unknown): string | null {
  if (typeof selection === "string") {
    return selection || null;
  }
  if (
    selection &&
    typeof selection === "object" &&
    "path" in selection &&
    typeof (selection as { path?: unknown }).path === "string"
  ) {
    return (selection as { path: string }).path || null;
  }
  return null;
}

function getSelectedLibraryID(): number | undefined {
  const pane = Zotero.getActiveZoteroPane?.() as
    | { getSelectedLibraryID?: () => number }
    | undefined;
  return pane?.getSelectedLibraryID?.() || Zotero.Libraries.userLibraryID;
}

function resolveParentItem(scope: ScopeContext | null): Zotero.Item | null {
  if (!scope) {
    return null;
  }

  if (scope.readerAttachmentId) {
    const attachment = Zotero.Items.get(scope.readerAttachmentId);
    return attachment?.parentItem || attachment || null;
  }

  const firstItemID = scope.itemIds[0];
  if (!firstItemID) {
    return null;
  }

  const item = Zotero.Items.get(firstItemID);
  if (!item) {
    return null;
  }

  if (item.isAttachment?.()) {
    return item.parentItem || item;
  }

  return item;
}

async function saveDraftNote(
  scope: ScopeContext | null,
  serviceLabel: string,
  draft: string,
  inputs: { image?: string; importedPDF?: string },
): Promise<void> {
  const noteText = draft.trim();
  if (!noteText) {
    throw new Error("Note draft is empty.");
  }

  const parentItem = resolveParentItem(scope);
  if (!parentItem) {
    throw new Error("Open a PDF or select one paper before saving a note.");
  }

  const title = parentItem.getDisplayTitle?.() || scope?.label || "Web AI note";
  const note = new Zotero.Item("note");
  note.parentID = parentItem.id;
  note.setNote(buildNoteHTML(title, serviceLabel, noteText, inputs));
  note.addTag("Web AI");
  note.addTag(serviceLabel);
  await note.saveTx();
}

function buildNoteHTML(
  title: string,
  serviceLabel: string,
  draft: string,
  inputs: { image?: string; importedPDF?: string },
): string {
  const paragraphs = draft
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => `<p>${escapeHTML(paragraph).replace(/\n/g, "<br/>")}</p>`)
    .join("");

  return [
    `<h1>Zotero-WebAI Note - ${escapeHTML(title)}</h1>`,
    `<p><strong>Service:</strong> ${escapeHTML(serviceLabel)}</p>`,
    inputs.importedPDF
      ? `<p><strong>Imported PDF:</strong> ${escapeHTML(inputs.importedPDF)}</p>`
      : "",
    inputs.image ? `<p><strong>Image:</strong> ${escapeHTML(inputs.image)}</p>` : "",
    paragraphs,
  ].join("");
}

function getBrowserFileLabel(file: File): string {
  const path = (file as File & { mozFullPath?: string }).mozFullPath;
  return path || file.name;
}

function getFileName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() || path;
}

function escapeHTML(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
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
  serviceBar: {
    display: "grid",
    gap: "6px",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  },
  serviceButton: {
    appearance: "none",
    border: "1px solid #c9c9c9",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: typography.label,
    fontWeight: 600,
    minHeight: "30px",
    padding: "4px 8px",
    whiteSpace: "normal",
  },
  utilityBar: {
    display: "grid",
    gap: "6px",
    gridTemplateColumns: "repeat(4, minmax(0, 1fr))",
  },
  promptPanel: {
    border: "1px solid #e0e0e0",
    borderRadius: "6px",
    display: "flex",
    flex: "0 0 auto",
    flexDirection: "column",
    gap: "7px",
    padding: "8px",
  },
  promptRow: {
    display: "grid",
    gap: "6px",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  },
  fieldLabel: {
    display: "flex",
    flexDirection: "column",
    fontSize: typography.meta,
    fontWeight: 600,
    gap: "4px",
    lineHeight: 1.3,
    minWidth: 0,
  },
  select: {
    border: "1px solid #d4d4d4",
    borderRadius: "4px",
    boxSizing: "border-box",
    font: "inherit",
    minHeight: "30px",
    padding: "4px 6px",
    width: "100%",
  },
  skillHint: {
    fontSize: typography.meta,
    lineHeight: 1.35,
    overflowWrap: "anywhere",
  },
  promptInput: {
    border: "1px solid #d4d4d4",
    borderRadius: "4px",
    boxSizing: "border-box",
    font: "inherit",
    fontSize: typography.body,
    lineHeight: 1.45,
    minHeight: "62px",
    padding: "7px 8px",
    resize: "vertical",
    width: "100%",
  },
  actionBar: {
    display: "grid",
    gap: "6px",
    gridTemplateColumns: "repeat(5, minmax(0, 1fr))",
  },
  button: {
    appearance: "none",
    border: "1px solid #c9c9c9",
    borderRadius: "4px",
    cursor: "pointer",
    fontSize: typography.label,
    fontWeight: 500,
    lineHeight: 1.25,
    minHeight: "28px",
    minWidth: 0,
    padding: "4px 7px",
    whiteSpace: "normal",
  },
  activeButton: {
    fontWeight: 700,
  },
  sourceList: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
  },
  sourceChip: {
    border: "1px solid #d4d4d4",
    borderRadius: "4px",
    fontSize: typography.meta,
    lineHeight: 1.3,
    maxWidth: "100%",
    overflowWrap: "anywhere",
    padding: "3px 6px",
  },
  imagePreview: {
    alignSelf: "flex-start",
    border: "1px solid #d4d4d4",
    borderRadius: "4px",
    maxHeight: "120px",
    maxWidth: "100%",
    objectFit: "contain",
  },
  generatedPrompt: {
    border: "1px solid #d4d4d4",
    borderRadius: "4px",
    boxSizing: "border-box",
    font: "inherit",
    fontSize: typography.meta,
    lineHeight: 1.4,
    maxHeight: "130px",
    minHeight: "76px",
    padding: "7px 8px",
    resize: "vertical",
    width: "100%",
  },
  status: {
    fontSize: typography.meta,
    lineHeight: 1.35,
    minHeight: "18px",
    overflowWrap: "anywhere",
  },
  frameHost: {
    border: "1px solid #e0e0e0",
    borderRadius: "4px",
    display: "flex",
    flex: "1 1 360px",
    minHeight: "300px",
    minWidth: 0,
    overflow: "hidden",
  },
  noteBox: {
    display: "flex",
    flex: "0 0 auto",
    flexDirection: "column",
    gap: "6px",
  },
  noteDraft: {
    border: "1px solid #d4d4d4",
    borderRadius: "4px",
    boxSizing: "border-box",
    color: "#222",
    font: "inherit",
    fontSize: typography.body,
    lineHeight: 1.45,
    minHeight: "78px",
    padding: "7px 8px",
    resize: "vertical",
    width: "100%",
  },
  noteActions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
  },
};
