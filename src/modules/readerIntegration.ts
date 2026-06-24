import type { ReaderActionDetail } from "../ui/readerActionFlow";
import { config } from "../../package.json";
import { getReaderCurrentPage, getReaderSelectedText } from "./readerPrivate";
import { createTraceId, debugLog } from "../utils/debugLog";
import { UIFactory } from "../ui/ui";
import { getSettings } from "../services/settingsManager";
import { EventBus } from "../utils/eventBus";
import { syncActiveReaderWebAIPanel } from "./readerWebAIPanel";

type ReaderSelectionPopupEvent = Parameters<
  typeof Zotero.Reader.registerEventListener<"renderTextSelectionPopup">
>[1] extends (event: infer T) => unknown
  ? T
  : never;

type ReaderViewContextMenuEvent = Parameters<
  typeof Zotero.Reader.registerEventListener<"createViewContextMenu">
>[1] extends (event: infer T) => unknown
  ? T
  : never;

type ReaderToolbarEvent = Parameters<
  typeof Zotero.Reader.registerEventListener<"renderToolbar">
>[1] extends (event: infer T) => unknown
  ? T
  : never;

interface ReaderLike {
  itemID?: number;
  type?: string;
  _instanceID?: number | string;
  _iframeWindow?: Window;
  _window?: Window;
  tabID?: number | string;
}

const TOOLBAR_BUTTON_ID = "zotero-webai-reader-toolbar-button";
const ICON_SRC = `chrome://${config.addonRef}/content/icons/icon-20.png`;

function isChineseLocale(): boolean {
  try {
    const locale =
      (globalThis as unknown as { Zotero?: { locale?: string } }).Zotero?.locale ||
      ((globalThis as unknown as { Zotero?: { Prefs?: { get?: (key: string, global?: boolean) => unknown } } }).Zotero?.Prefs?.get?.("intl.accept_languages", true) as string) ||
      "";
    return String(locale).toLowerCase().startsWith("zh");
  } catch {
    return false;
  }
}

let popupHandler:
  | ((event: ReaderSelectionPopupEvent) => void | Promise<void>)
  | null = null;
let contextMenuHandler:
  | ((event: ReaderViewContextMenuEvent) => void | Promise<void>)
  | null = null;
let toolbarHandler:
  | ((event: ReaderToolbarEvent) => void | Promise<void>)
  | null = null;
let settingsHandler: ((event: Event) => void) | null = null;

function dispatchReaderAction(
  action: ReaderActionDetail["action"],
  text: string,
  page: number,
  readerItemID: number,
  reader?: ReaderLike,
  doc?: Document,
): void {
  const traceId = createTraceId(`reader-${action}`);
  const normalizedText = text.trim();
  const win = Zotero.getMainWindow?.() as
    | (Window & { __aiAssistantEventBus?: EventTarget })
    | null;
  const eventBus = win?.__aiAssistantEventBus;
  if (!normalizedText) {
    debugLog.warn("reader.action.blocked", {
      action,
      page,
      readerItemID,
      reason: "empty-selection",
      selectedTextChars: 0,
      surface: "reader",
      traceId,
    });
    return;
  }
  if (!win || !eventBus) {
    debugLog.warn("reader.action.blocked", {
      action,
      page,
      readerItemID,
      reason: "missing-event-bus",
      selectedTextChars: normalizedText.length,
      surface: "reader",
      traceId,
    });
    return;
  }

  const detail: ReaderActionDetail = {
    action,
    text: normalizedText,
    page,
    readerItemID,
    traceId,
  };

  debugLog.info("reader.action.dispatch", {
    action,
    page,
    readerItemID,
    selectedTextChars: normalizedText.length,
    surface: "reader",
    traceId,
  });

  void (async () => {
    try {
      await UIFactory.openSidebarFromReaderToolbar(win);
      await delayForReaderPanelListener(win);
    } catch (error) {
      debugLog.error("reader.action.openPanel.error", error, {
        action,
        page,
        readerItemID,
        surface: "reader",
        traceId,
      });
    }

    eventBus.dispatchEvent(
      new win.CustomEvent("readerSelectionAction", {
        detail,
      }),
    );
  })();
}

function delayForReaderPanelListener(win: Window): Promise<void> {
  return new Promise((resolve) => {
    win.setTimeout(resolve, 80);
  });
}

function onRenderTextSelectionPopup(event: ReaderSelectionPopupEvent): void {
  const { reader, doc, params, append } = event;

  if (reader?.type !== "pdf") {
    debugLog.debug("reader.popup.skip", {
      reason: "non-pdf-reader",
      readerType: String(reader?.type || ""),
      surface: "reader",
    });
    return;
  }

  const annotation = params?.annotation as
    | { pageIndex?: number; text?: string }
    | undefined;
  const annotationText = annotation?.text || "";
  if (!annotationText.trim()) {
    debugLog.warn("reader.popup.skip", {
      hasSelection: false,
      reason: "empty-annotation-text",
      readerItemID: reader?.itemID,
      selectedTextChars: 0,
      surface: "reader",
    });
    return;
  }

  const page = (annotation?.pageIndex ?? 0) + 1;
  const readerItemID = reader?.itemID;
  if (!readerItemID) {
    debugLog.warn("reader.popup.skip", {
      hasSelection: true,
      page,
      reason: "missing-reader-item-id",
      selectedTextChars: annotationText.trim().length,
      surface: "reader",
    });
    return;
  }

  debugLog.info("reader.popup.render", {
    hasSelection: true,
    page,
    readerItemID,
    selectedTextChars: annotationText.trim().length,
    surface: "reader",
  });

  const container = doc.createElement("div");
  container.className = "ai-assistant-selection-popup";
  container.style.cssText = "display: flex; flex-direction: column; gap: 2px;";
  const zh = isChineseLocale();

  const label = doc.createElement("span");
  label.textContent = "Zotero WebAI";
  label.style.cssText =
    "font-size: 0.92em; color: inherit; opacity: 0.72; user-select: none; padding-left: 4px;";
  container.appendChild(label);

  const row = doc.createElement("div");
  row.style.cssText = "display: flex; gap: 4px;";

  const explainBtn = doc.createElement("button");
  explainBtn.className = "toolbar-button wide-button";
  explainBtn.style.cssText = "flex: 1;";
  explainBtn.textContent = zh ? "解释" : "Explain";
  explainBtn.addEventListener("click", () => {
    dispatchReaderAction("explain", annotationText, page, readerItemID, reader, doc);
  });

  const askBtn = doc.createElement("button");
  askBtn.className = "toolbar-button wide-button";
  askBtn.style.cssText = "flex: 1;";
  askBtn.textContent = zh ? "提问..." : "Ask...";
  askBtn.addEventListener("click", () => {
    dispatchReaderAction("ask", annotationText, page, readerItemID, reader, doc);
  });

  row.appendChild(explainBtn);
  row.appendChild(askBtn);
  container.appendChild(row);
  append(container);
}

function onCreateViewContextMenu(event: ReaderViewContextMenuEvent): void {
  const { reader, append } = event;

  if (reader?.type !== "pdf") {
    debugLog.debug("reader.contextMenu.skip", {
      reason: "non-pdf-reader",
      readerType: String(reader?.type || ""),
      surface: "reader",
    });
    return;
  }

  const readerItemID = reader?.itemID;

  const selectedText = getReaderSelectedText(reader);
  const page = getReaderCurrentPage(reader) ?? 1;

  const hasSelection = !!selectedText && selectedText.length > 0;
  const zh = isChineseLocale();

  debugLog.info("reader.contextMenu.create", {
    hasSelection,
    page,
    readerItemID,
    selectedTextChars: selectedText?.length || 0,
    surface: "reader",
  });

  const appendMenuItems = append as unknown as (...items: unknown[]) => void;
  appendMenuItems(
    {
      label: zh ? "用 Zotero WebAI 解释" : "Explain with Zotero WebAI",
      disabled: !hasSelection,
      persistent: true,
      onCommand: () => {
        if (selectedText && readerItemID) {
          dispatchReaderAction("explain", selectedText, page, readerItemID, reader);
          return;
        }
        debugLog.warn("reader.action.blocked", {
          action: "explain",
          page,
          readerItemID,
          reason: selectedText ? "missing-reader-item-id" : "empty-selection",
          selectedTextChars: selectedText?.length || 0,
          surface: "reader",
        });
      },
    },
    {
      label: zh ? "向 Zotero WebAI 提问..." : "Ask Zotero WebAI...",
      disabled: !hasSelection,
      persistent: true,
      onCommand: () => {
        if (selectedText && readerItemID) {
          dispatchReaderAction("ask", selectedText, page, readerItemID, reader);
          return;
        }
        debugLog.warn("reader.action.blocked", {
          action: "ask",
          page,
          readerItemID,
          reason: selectedText ? "missing-reader-item-id" : "empty-selection",
          selectedTextChars: selectedText?.length || 0,
          surface: "reader",
        });
      },
    },
  );
}

function onRenderToolbar(event: ReaderToolbarEvent): void {
  const toolbarEvent = event as ReaderToolbarEvent & {
    append?: (...nodes: unknown[]) => void;
    doc?: Document;
    reader?: ReaderLike;
  };
  const { append, doc, reader } = toolbarEvent;
  if (!doc) {
    return;
  }

  void reader;
  syncActiveReaderWebAIEntrypoints(doc, append);
}

function ensureReaderToolbarButton(
  doc: Document,
  append?: (...nodes: unknown[]) => void,
): void {
  const mainWindow = Zotero.getMainWindow?.();
  const existing = doc.getElementById(TOOLBAR_BUTTON_ID) as HTMLElement | null;
  const iconPlacement = getSettings().iconPlacement;
  if (!shouldShowToolbarIcon(iconPlacement)) {
    existing?.remove();
    return;
  }
  if (existing) {
    moveToolbarButtonToMiddle(doc, existing);
    return;
  }

  const button = doc.createElement("button");
  button.id = TOOLBAR_BUTTON_ID;
  button.className = "toolbar-button zotero-webai-reader-toolbar-button";
  button.type = "button";
  button.title = "Zotero WebAI";
  button.setAttribute("aria-label", "Zotero WebAI");

  const icon = doc.createElement("img");
  icon.alt = "";
  icon.src = ICON_SRC;
  button.appendChild(icon);

  button.addEventListener("click", () => {
    if (mainWindow) {
      void UIFactory.openSidebarFromReaderToolbar(mainWindow);
    }
  });

  if (append) {
    append(button);
  } else {
    const toolbar = findReaderToolbar(doc);
    toolbar?.appendChild(button);
  }
  moveToolbarButtonToMiddle(doc, button);
}

function shouldShowToolbarIcon(iconPlacement: string): boolean {
  return iconPlacement === "both" || iconPlacement === "reader-toolbar";
}

function syncActiveReaderWebAIEntrypoints(
  doc?: Document | null,
  append?: (...nodes: unknown[]) => void,
): void {
  const reader = getActiveReader();
  const readerDoc = doc || reader?._iframeWindow?.document || null;
  if (readerDoc) {
    ensureReaderToolbarButton(readerDoc, append);
  }
  syncActiveReaderWebAIPanel();
}

function getActiveReader(): ReaderLike | null {
  const win = Zotero.getMainWindow?.() as
    | (Window & {
        Zotero_Tabs?: {
          _selectedID?: string;
          selectedID?: string;
          selectedType?: string;
        };
      })
    | null;
  const selectedType = `${win?.Zotero_Tabs?.selectedType || ""}`.toLowerCase();
  if (!selectedType.includes("reader")) {
    return null;
  }
  const selectedID = `${win?.Zotero_Tabs?.selectedID || win?.Zotero_Tabs?._selectedID || ""}`;
  if (!selectedID) {
    return null;
  }
  return Zotero.Reader.getByTabID(selectedID) as ReaderLike | null;
}

function moveToolbarButtonToMiddle(doc: Document, button: HTMLElement): void {
  const toolbar = findReaderToolbar(doc);
  if (!toolbar || button.parentElement !== toolbar) {
    return;
  }

  const anchor = findMiddleToolbarAnchor(toolbar);
  if (anchor && anchor !== button && anchor.nextSibling !== button) {
    toolbar.insertBefore(button, anchor.nextSibling);
  }
}

function findReaderToolbar(doc: Document): HTMLElement | null {
  const selectors = [
    "#toolbarContainer #toolbarViewer",
    "#toolbarViewer",
    "#viewer-toolbar",
    ".reader-toolbar",
    ".toolbar",
    "[role='toolbar']",
  ];

  for (const selector of selectors) {
    const match = doc.querySelector(selector) as HTMLElement | null;
    if (match) {
      return match;
    }
  }
  return null;
}

function findMiddleToolbarAnchor(toolbar: HTMLElement): Element | null {
  const selectors = [
    "[data-l10n-id*='page']",
    "[aria-label*='Page']",
    "[title*='Page']",
    "[aria-label*='PDF']",
    "[title*='PDF']",
    "input[type='number']",
  ];

  for (const selector of selectors) {
    const match = toolbar.querySelector(selector);
    if (match) {
      return match.closest("button,toolbarbutton,div,span") || match;
    }
  }

  const controls = Array.from(
    toolbar.querySelectorAll(
      "button,toolbarbutton,[role='button']",
    ) as NodeListOf<Element>,
  );
  const fallback = controls[
    Math.max(0, Math.floor(controls.length / 2) - 1)
  ] as Element | undefined;
  return fallback || null;
}
export function initReaderIntegration(): void {
  if (typeof Zotero?.Reader?.registerEventListener !== "function") {
    debugLog.warn("reader.integration.skip", {
      reason: "reader-api-unavailable",
      surface: "reader",
    });
    ztoolkit.log("readerIntegration: Reader API not available, skipping");
    return;
  }

  cleanupReaderIntegration();

  popupHandler = onRenderTextSelectionPopup;
  contextMenuHandler = onCreateViewContextMenu;
  toolbarHandler = onRenderToolbar;
  settingsHandler = () => {
    syncActiveReaderWebAIEntrypoints();
  };

  Zotero.Reader.registerEventListener(
    "renderTextSelectionPopup",
    popupHandler,
    config.addonID,
  );
  Zotero.Reader.registerEventListener(
    "createViewContextMenu",
    contextMenuHandler,
    config.addonID,
  );
  Zotero.Reader.registerEventListener(
    "renderToolbar",
    toolbarHandler,
    config.addonID,
  );
  EventBus.getInstance().addEventListener("settingsChange", settingsHandler);

  debugLog.info("reader.integration.registered", {
    surface: "reader",
  });
  ztoolkit.log("readerIntegration: Registered reader event listeners");
}

export function cleanupReaderIntegration(): void {
  if (popupHandler) {
    Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", popupHandler);
    popupHandler = null;
  }
  if (contextMenuHandler) {
    Zotero.Reader.unregisterEventListener("createViewContextMenu", contextMenuHandler);
    contextMenuHandler = null;
  }
  if (toolbarHandler) {
    Zotero.Reader.unregisterEventListener("renderToolbar", toolbarHandler);
    toolbarHandler = null;
  }
  if (settingsHandler) {
    EventBus.getInstance().removeEventListener("settingsChange", settingsHandler);
    settingsHandler = null;
  }
}
