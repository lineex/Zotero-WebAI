import React from "react";
import { createRoot } from "react-dom/client";
import type { ReaderActionDetail } from "../ui/readerActionFlow";
import { config } from "../../package.json";
import { getReaderCurrentPage, getReaderSelectedText } from "./readerPrivate";
import { createTraceId, debugLog } from "../utils/debugLog";
import { UIFactory } from "../ui/ui";
import { getSettings } from "../services/settingsManager";
import { EventBus } from "../utils/eventBus";
import { syncActiveReaderWebAIPanel } from "./readerWebAIPanel";
import { SelectionToolbar } from "../ui/components/SelectionToolbar";
import { getSidebarTheme } from "../ui/theme";

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
const TABBAR_BUTTON_ID = "zotero-webai-reader-tabbar-button";
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
let tabbarObserver: MutationObserver | null = null;

let activeDocSelectionListener: {
  doc: Document;
  handler: () => void;
} | null = null;

function dismissSelectionToolbar(doc: Document) {
  const mountPoint = doc.getElementById("zotero-webai-selection-toolbar-mount");
  if (mountPoint) {
    const root = (mountPoint as any)._reactRoot;
    if (root) {
      try {
        root.unmount();
      } catch (err) {
        // Ignore unmount errors
      }
      (mountPoint as any)._reactRoot = null;
    }
    mountPoint.remove();
  }
}

function showSelectionToolbar(
  text: string,
  rect: DOMRect,
  doc: Document,
  page: number,
  readerItemID: number,
  reader: ReaderLike,
) {
  const settings = getSettings();
  if (settings.selectionToolbarEnabled === false) {
    return;
  }

  let mountPoint = doc.getElementById("zotero-webai-selection-toolbar-mount");
  if (!mountPoint) {
    mountPoint = doc.createElement("div");
    mountPoint.id = "zotero-webai-selection-toolbar-mount";
    if (doc.body) {
      doc.body.appendChild(mountPoint);
    } else {
      return;
    }
  }

  const position = {
    top: rect.top,
    left: rect.left + rect.width / 2,
  };

  const mainWindow = Zotero.getMainWindow();
  const themeMode = settings.themeMode || "auto";
  const theme = getSidebarTheme(mainWindow, themeMode);
  const zh = isChineseLocale();

  let root = (mountPoint as any)._reactRoot;
  if (!root) {
    root = createRoot(mountPoint);
    (mountPoint as any)._reactRoot = root;
  }

  const onAction = (actionId: string, selectedText: string) => {
    dispatchReaderAction(actionId as any, selectedText, page, readerItemID, reader, doc);
    dismissSelectionToolbar(doc);
  };

  const onDismiss = () => {
    dismissSelectionToolbar(doc);
  };

  root.render(
    React.createElement(SelectionToolbar, {
      selectedText: text,
      position,
      theme,
      isZh: zh,
      onAction,
      onDismiss,
    })
  );
}

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

  const sel = doc.getSelection();
  let rect: DOMRect | null = null;
  if (sel && sel.rangeCount > 0) {
    rect = sel.getRangeAt(0).getBoundingClientRect();
  }

  const mainWindow = Zotero.getMainWindow?.();
  const eventBus = (mainWindow as any)?.__aiAssistantEventBus;
  if (eventBus && mainWindow) {
    eventBus.dispatchEvent(
      new mainWindow.CustomEvent("selectionTextUpdate", {
        detail: { text: annotationText },
      }),
    );
  }

  if (activeDocSelectionListener) {
    activeDocSelectionListener.doc.removeEventListener(
      "selectionchange",
      activeDocSelectionListener.handler
    );
    activeDocSelectionListener = null;
  }

  const onSelectionChange = () => {
    const currentSel = doc.getSelection();
    if (!currentSel || currentSel.isCollapsed || !currentSel.toString().trim()) {
      if (eventBus && mainWindow) {
        eventBus.dispatchEvent(
          new mainWindow.CustomEvent("selectionTextUpdate", {
            detail: { text: "" },
          }),
        );
      }
      dismissSelectionToolbar(doc);
      doc.removeEventListener("selectionchange", onSelectionChange);
      if (activeDocSelectionListener?.handler === onSelectionChange) {
        activeDocSelectionListener = null;
      }
    }
  };
  doc.addEventListener("selectionchange", onSelectionChange);
  activeDocSelectionListener = { doc, handler: onSelectionChange };

  const settings = getSettings();
  if (settings.selectionToolbarEnabled !== false) {
    if (rect) {
      showSelectionToolbar(annotationText, rect, doc, page, readerItemID, reader);
    }
  } else {
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


function ensureReaderTabbarButton(): boolean {
  const mainWindow = Zotero.getMainWindow?.() as Window | null;
  const doc = mainWindow?.document;
  if (!mainWindow || !doc) {
    return false;
  }

  const existing = doc.getElementById(TABBAR_BUTTON_ID) as HTMLElement | null;
  const iconPlacement = getSettings().iconPlacement;
  const shouldShow = shouldShowToolbarIcon(iconPlacement) && Boolean(getActiveReader());
  if (!shouldShow) {
    existing?.remove();
    return false;
  }

  const tabbar = findMainTabbar(doc);
  if (!tabbar) {
    return false;
  }

  const button = existing || createTabbarButton(doc, mainWindow);
  const anchor = findTabbarDropdownAnchor(tabbar);
  if (anchor && anchor !== button) {
    if (button.parentElement !== tabbar || button.nextSibling !== anchor) {
      tabbar.insertBefore(button, anchor);
    }
  } else if (button.parentElement !== tabbar) {
    tabbar.appendChild(button);
  }
  return true;
}

function ensureReaderToolbarButton(
  doc: Document,
  append?: (...nodes: unknown[]) => void,
): void {
  const mainWindow = Zotero.getMainWindow?.();
  const existing = doc.getElementById(TOOLBAR_BUTTON_ID) as HTMLElement | null;
  const iconPlacement = getSettings().iconPlacement;
  const tabbarButtonReady = ensureReaderTabbarButton();
  if (!shouldShowToolbarIcon(iconPlacement) || tabbarButtonReady) {
    existing?.remove();
    return;
  }
  if (existing) {
    positionReaderToolbarButton(doc, existing);
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
  positionReaderToolbarButton(doc, button);
}

function shouldShowToolbarIcon(iconPlacement: string): boolean {
  return iconPlacement === "both" || iconPlacement === "reader-toolbar";
}

function syncActiveReaderWebAIEntrypoints(
  doc?: Document | null,
  append?: (...nodes: unknown[]) => void,
): void {
  const reader = getActiveReader();
  const tabbarButtonReady = ensureReaderTabbarButton();
  const readerDoc = doc || reader?._iframeWindow?.document || null;
  if (readerDoc && !tabbarButtonReady) {
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


function createTabbarButton(doc: Document, mainWindow: Window): HTMLElement {
  const button = doc.createElement("button");
  button.id = TABBAR_BUTTON_ID;
  button.className = "zotero-webai-reader-toolbar-button zotero-webai-reader-tabbar-button";
  button.type = "button";
  button.title = "Zotero WebAI";
  button.setAttribute("aria-label", "Zotero WebAI");

  const icon = doc.createElement("img");
  icon.alt = "";
  icon.src = ICON_SRC;
  button.appendChild(icon);

  button.addEventListener("click", () => {
    void UIFactory.openSidebarFromReaderToolbar(mainWindow);
  });
  return button;
}

function findMainTabbar(doc: Document): HTMLElement | null {
  const selectors = [
    "#tabs-container",
    "#zotero-tabs",
    "#zotero-tabbar",
    "#tab-bar",
    "#tabs",
    ".tabs-container",
    ".zotero-tabs",
    ".tab-strip",
    "[role='tablist']",
  ];
  for (const selector of selectors) {
    const candidate = doc.querySelector(selector) as HTMLElement | null;
    if (isUsableMainTabbar(candidate)) {
      return candidate;
    }
  }

  const tabs = Array.from(doc.querySelectorAll("[role='tab'],.tab,[class*='tab']")) as HTMLElement[];
  for (const tab of tabs) {
    let current = tab.parentElement as HTMLElement | null;
    let depth = 0;
    while (current && depth < 5) {
      if (isUsableMainTabbar(current)) {
        return current;
      }
      current = (current as HTMLElement).parentElement as HTMLElement | null;
      depth += 1;
    }
  }

  const menuLike = Array.from(
    doc.querySelectorAll(
      "[id*='tabs'][id*='menu'],[id*='tab'][id*='menu'],[class*='tabs-menu'],[class*='alltabs'],[class*='tab'][class*='dropdown'],[class*='tab'][class*='overflow']",
    ),
  ) as HTMLElement[];
  for (const anchor of menuLike) {
    const parent = anchor.parentElement as HTMLElement | null;
    if (isUsableMainTabbar(parent)) {
      return parent;
    }
  }
  return null;
}

function isUsableMainTabbar(element?: HTMLElement | null): element is HTMLElement {
  if (!element) {
    return false;
  }
  const rect = element.getBoundingClientRect?.();
  if (!rect || rect.width < 240 || rect.height < 20 || rect.height > 76) {
    return false;
  }
  const descriptor = [
    element.id,
    element.className,
    element.getAttribute("role"),
    element.getAttribute("aria-label"),
  ]
    .join(" ")
    .toLowerCase();
  return Boolean(
    /tab|tabs/.test(descriptor) ||
      element.querySelector("[role='tab'],.tab,[class*='tab']"),
  );
}

function findTabbarDropdownAnchor(tabbar: HTMLElement): Element | null {
  const selectors = [
    "#tabs-menu-button",
    "#alltabs-button",
    "#zotero-tabs-menu",
    "[id*='tabs'][id*='menu']",
    "[id*='tab'][id*='menu']",
    "[data-l10n-id*='tabs-menu']",
    "[aria-label*='tabs']",
    "[aria-label*='Tabs']",
    "[title*='tabs']",
    "[title*='Tabs']",
    "[class*='tabs-menu']",
    "[class*='alltabs']",
    "[class*='overflow']",
    "[class*='dropdown']",
    "[class*='dropmarker']",
    "[class*='chevron']",
  ];
  for (const selector of selectors) {
    const match = tabbar.querySelector(selector);
    if (match && match.id !== TABBAR_BUTTON_ID) {
      return (match.closest("button,toolbarbutton,[role='button'],div,span") || match) as Element;
    }
  }
  const controls = (Array.from(
    tabbar.querySelectorAll("button,toolbarbutton,[role='button']"),
  ) as Element[]).filter((element) => element.id !== TABBAR_BUTTON_ID);
  return controls[controls.length - 1] || null;
}

function positionReaderToolbarButton(doc: Document, button: HTMLElement): void {
  const parent = button.parentElement;
  if (!parent) {
    const win = doc.defaultView;
    if (win) {
      win.setTimeout(() => {
        positionReaderToolbarButton(doc, button);
      }, 0);
    } else {
      (globalThis as any).setTimeout(() => {
        positionReaderToolbarButton(doc, button);
      }, 0);
    }
    return;
  }

  const toolbar = findReaderToolbar(doc);
  if (parent === toolbar) {
    const anchor = findMiddleToolbarAnchor(toolbar);
    if (anchor && anchor !== button && anchor.nextSibling !== button) {
      toolbar.insertBefore(button, anchor.nextSibling);
    }
    return;
  }

  const positionButton = () => {
    const translateButton = Array.from(parent.children).find((child) => {
      if (child === button) return false;
      const id = child.id?.toLowerCase() || "";
      const className = child.className?.toLowerCase() || "";
      const title = child.getAttribute("title")?.toLowerCase() || "";
      const label = child.getAttribute("aria-label")?.toLowerCase() || "";
      return (
        id.includes("translate") ||
        className.includes("translate") ||
        title.includes("translate") ||
        title.includes("翻译") ||
        label.includes("translate") ||
        label.includes("翻译")
      );
    });
    if (translateButton && button.nextSibling !== translateButton) {
      parent.insertBefore(button, translateButton);
    }
  };

  positionButton();

  const MutationObserverClass = doc.defaultView?.MutationObserver || globalThis.MutationObserver;
  if (typeof MutationObserverClass === "function") {
    const existingObserver = (button as any)._siblingObserver;
    if (existingObserver) {
      try {
        existingObserver.disconnect();
      } catch (e) {
        // ignore
      }
    }
    const observer = new MutationObserverClass(() => {
      positionButton();
    });
    observer.observe(parent, { childList: true });
    (button as any)._siblingObserver = observer;
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
    Zotero.getMainWindow?.()?.setTimeout?.(() => {
      syncActiveReaderWebAIEntrypoints();
    }, 100);
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
  ensureReaderTabbarButton();
  installTabbarObserver();

  debugLog.info("reader.integration.registered", {
    surface: "reader",
  });
  ztoolkit.log("readerIntegration: Registered reader event listeners");
}

export function cleanupReaderIntegration(): void {
  if (activeDocSelectionListener) {
    try {
      activeDocSelectionListener.doc.removeEventListener(
        "selectionchange",
        activeDocSelectionListener.handler
      );
      dismissSelectionToolbar(activeDocSelectionListener.doc);
    } catch {
      // Ignore cleanup issues
    }
    activeDocSelectionListener = null;
  }
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
  tabbarObserver?.disconnect();
  tabbarObserver = null;
  Zotero.getMainWindow?.()?.document?.getElementById(TABBAR_BUTTON_ID)?.remove();
}

function installTabbarObserver(): void {
  const mainWindow = Zotero.getMainWindow?.() as Window | null;
  const doc = mainWindow?.document;
  if (!mainWindow || !doc || tabbarObserver) {
    return;
  }
  const MutationObserverClass =
    mainWindow.MutationObserver || globalThis.MutationObserver;
  if (typeof MutationObserverClass !== "function") {
    return;
  }
  const root = doc.documentElement;
  if (!root) {
    return;
  }
  const observer = new MutationObserverClass(() => {
    ensureReaderTabbarButton();
  });
  observer.observe(root, {
    attributeFilter: ["class", "selected", "aria-selected", "hidden"],
    attributes: true,
    childList: true,
    subtree: true,
  });
  tabbarObserver = observer;
}
