import React from "react";
import { config } from "../../package.json";
import { EventBus } from "../utils/eventBus";
import { Sidebar } from "../ui/components/Sidebar";
import { getSettings } from "../services/settingsManager";

type ReactRoot = import("react-dom/client").Root;

export interface ReaderWebAIReaderLike {
  _iframe?: Element & { style?: CSSStyleDeclaration };
  _iframeWindow?: Window;
  _instanceID?: number | string;
  _tabContainer?: Element & { style?: CSSStyleDeclaration };
  _window?: Window;
  itemID?: number;
  tabID?: number | string;
  type?: string;
}

interface ReaderPanelState {
  bootstrapped: boolean;
  bootstrappingPromise: Promise<void> | null;
  closeButton: HTMLElement;
  hostDocument: Document;
  mainWindow: Window;
  navButton: HTMLElement;
  panel: HTMLElement;
  parent: Element;
  previousIframeBoxSizing: string | null;
  previousIframeDisplay: string | null;
  previousIframeFlex: string | null;
  previousIframeHeight: string | null;
  previousIframeMinWidth: string | null;
  previousIframeMarginRight: string | null;
  previousIframeMaxWidth: string | null;
  previousIframeOrder: string | null;
  previousIframeWidth: string | null;
  previousParentAlignItems: string | null;
  previousParentDisplay: string | null;
  previousParentFlexDirection: string | null;
  previousParentGap: string | null;
  previousParentMinWidth: string | null;
  previousParentOverflow: string | null;
  previousParentPosition: string | null;
  previousViewerContainerPaddingRight: string | null;
  previousViewerPaddingRight: string | null;
  previousViewerMarginRight: string | null;
  reactRoot: ReactRoot | null;
  reactRootElement: HTMLDivElement;
  reader: ReaderWebAIReaderLike;
  readerDocument: Document;
  readerWindow: Window;
  resizeObserver: ResizeObserver | null;
  rail: HTMLElement | null;
}

const HTML_NS = "http://www.w3.org/1999/xhtml";
const PANEL_ID = "zotero-webai-reader-panel";
const PANEL_ROOT_ID = "zotero-webai-reader-panel-root";
const READER_RAIL_ID = "zotero-webai-reader-rail";
const READER_BUTTON_ID = "zotero-webai-reader-side-button";
const HOST_STYLE_ID = "zotero-webai-reader-host-style";
const READER_CONTENT_STYLE_ID = "zotero-webai-reader-content-style";
const LAYOUT_HOST_CLASS = "zotero-webai-reader-layout-host";
const LAYOUT_FRAME_CLASS = "zotero-webai-reader-layout-frame";
const DEFAULT_PANEL_WIDTH = 440;
const MIN_PANEL_WIDTH = 320;
const MAX_PANEL_WIDTH = 720;
const ICON_SRC = `chrome://${config.addonRef}/content/icons/icon-20.png`;
const READER_SIDE_NAV_SELECTORS = [
  "#zotero-context-pane-sidenav",
  "#zotero-view-item-sidenav",
  "#zotero-reader-sidenav",
  "#zotero-reader-side-nav",
  "#zotero-reader-sidebar-sidenav",
  "#zotero-reader-sidebar nav",
  "#zotero-reader-sidebar .sidenav",
  ".zotero-context-pane-sidenav",
  ".zotero-view-item-sidenav",
  ".zotero-reader-sidenav",
  ".zotero-reader-side-nav",
  ".zotero-reader-sidebar-sidenav",
  ".reader-sidebar-sidenav",
  ".reader-side-nav",
  ".reader-sidebar nav",
  ".reader-sidebar .sidenav",
  ".reader-sidebar-toolbar",
  "sidenav",
];
const READER_HOST_SELECTORS = [
  "#zotero-reader",
  "#reader",
  "#reader-container",
  "#zotero-reader-container",
  "[id*='reader']",
  ".zotero-reader",
  ".reader",
  ".reader-tab",
  ".reader-container",
];

const statesByReaderWindow = new WeakMap<Window, ReaderPanelState>();
const panelStates = new Set<ReaderPanelState>();
let reactDomClientPromise: Promise<typeof import("react-dom/client")> | null =
  null;

export function ensureReaderWebAIPanel(
  reader?: ReaderWebAIReaderLike | null,
  readerDocument?: Document | null,
): ReaderPanelState | null {
  if (!reader || (reader.type && reader.type !== "pdf")) {
    return null;
  }

  const readerWindow = reader._iframeWindow || readerDocument?.defaultView;
  const doc = readerDocument || readerWindow?.document || null;
  const mainWindow = reader._window || Zotero.getMainWindow?.() || null;
  if (!readerWindow || !doc || !mainWindow) {
    return null;
  }

  const existing = statesByReaderWindow.get(readerWindow);
  if (
    existing &&
    existing.hostDocument.contains(existing.panel) &&
    existing.hostDocument.contains(existing.navButton)
  ) {
    existing.reader = reader;
    ensureReaderButtonPlacement(existing);
    return existing;
  }

  const hostDocument = mainWindow.document;
  const parent = resolveReaderPanelParent(reader, hostDocument);
  if (!parent) {
    return null;
  }

  ensureHostStyle(hostDocument);

  const panel = createPanel(hostDocument);
  const closeButton = createCloseButton(hostDocument);
  const reactRootElement = createHTMLElement(hostDocument, "div");
  reactRootElement.id = PANEL_ROOT_ID;
  reactRootElement.className = "zotero-webai-reader-panel-root ai-assistant-pane";

  panel.append(closeButton, reactRootElement);
  parent.appendChild(panel);

  const navButton = createReaderButton(hostDocument);
  const state: ReaderPanelState = {
    bootstrapped: false,
    bootstrappingPromise: null,
    closeButton,
    hostDocument,
    mainWindow,
    navButton,
    panel,
    parent,
    previousIframeBoxSizing: null,
    previousIframeDisplay: null,
    previousIframeFlex: null,
    previousIframeHeight: null,
    previousIframeMinWidth: null,
    previousIframeMarginRight: null,
    previousIframeMaxWidth: null,
    previousIframeOrder: null,
    previousIframeWidth: null,
    previousParentAlignItems: null,
    previousParentDisplay: null,
    previousParentFlexDirection: null,
    previousParentGap: null,
    previousParentMinWidth: null,
    previousParentOverflow: null,
    previousParentPosition: null,
    previousViewerContainerPaddingRight: null,
    previousViewerPaddingRight: null,
    previousViewerMarginRight: null,
    reactRoot: null,
    reactRootElement,
    reader,
    readerDocument: doc,
    readerWindow,
    resizeObserver: null,
    rail: null,
  };

  closeButton.addEventListener("click", () => {
    setReaderPanelOpen(state, false);
  });
  navButton.addEventListener("click", () => {
    void toggleReaderPanelState(state);
  });

  statesByReaderWindow.set(readerWindow, state);
  panelStates.add(state);
  preparePanelParent(state);
  ensureReaderButtonPlacement(state);
  setReaderPanelOpen(state, false);
  installResizeObserver(state);
  return state;
}

export async function openReaderWebAIPanel(
  reader?: ReaderWebAIReaderLike | null,
  readerDocument?: Document | null,
): Promise<boolean> {
  const state = ensureReaderWebAIPanel(reader, readerDocument);
  if (!state) {
    return false;
  }

  setReaderPanelOpen(state, true);
  await ensurePanelBootstrapped(state);
  focusPanel(state);
  return true;
}

export async function toggleReaderWebAIPanel(
  reader?: ReaderWebAIReaderLike | null,
  readerDocument?: Document | null,
): Promise<boolean> {
  const state = ensureReaderWebAIPanel(reader, readerDocument);
  if (!state) {
    return false;
  }
  await toggleReaderPanelState(state);
  return true;
}

export function syncActiveReaderWebAIPanel(): void {
  const reader = getActiveReader();
  if (!reader) {
    return;
  }
  ensureReaderWebAIPanel(reader, reader._iframeWindow?.document || null);
}

export function cleanupReaderWebAIPanels(): void {
  for (const state of Array.from(panelStates)) {
    cleanupReaderWebAIPanelState(state);
  }
}

export function cleanupReaderWebAIPanelsForWindow(win: Window): void {
  for (const state of Array.from(panelStates)) {
    if (state.mainWindow === win) {
      cleanupReaderWebAIPanelState(state);
    }
  }
}

async function toggleReaderPanelState(state: ReaderPanelState): Promise<void> {
  const shouldOpen =
    Boolean(state.panel.hidden) || state.panel.dataset.open !== "true";
  setReaderPanelOpen(state, shouldOpen);
  if (shouldOpen) {
    await ensurePanelBootstrapped(state);
    focusPanel(state);
  }
}

function setReaderPanelOpen(state: ReaderPanelState, open: boolean): void {
  state.panel.hidden = !open;
  state.panel.dataset.open = open ? "true" : "false";
  state.panel.style.display = open ? "flex" : "none";
  state.navButton.classList.toggle("is-active", open);
  state.navButton.setAttribute("aria-pressed", open ? "true" : "false");
  state.hostDocument.documentElement?.classList.toggle(
    "zotero-webai-reader-panel-open",
    open,
  );
  (state.parent as HTMLElement).classList?.toggle(
    "zotero-webai-reader-panel-open",
    open,
  );
  state.readerDocument.documentElement?.classList.toggle(
    "zotero-webai-reader-panel-open",
    open,
  );
  const keepEmbeddedRailLayout = state.rail?.dataset.placement === "embedded";
  if (open) {
    applyEmbeddedReaderLayout(state);
  } else {
    if (keepEmbeddedRailLayout) {
      applyEmbeddedReaderLayout(state);
    } else {
      restoreEmbeddedReaderLayout(state);
    }
    restoreReaderContentCompaction(state);
  }
  syncReaderRailPosition(state);
}

async function ensurePanelBootstrapped(
  state: ReaderPanelState,
): Promise<void> {
  if (state.bootstrapped) {
    return;
  }
  if (state.bootstrappingPromise) {
    return state.bootstrappingPromise;
  }

  state.bootstrappingPromise = (async () => {
    const { createRoot } = await getReactDomClient(state.mainWindow);
    if (!state.reactRoot) {
      state.reactRoot = createRoot(state.reactRootElement);
    }
    state.reactRoot.render(
      React.createElement(Sidebar, {
        eventBus: EventBus.getInstance(),
        hostWindow: state.mainWindow,
        location: "reader",
      }),
    );
    state.bootstrapped = true;
  })()
    .catch((error) => {
      state.reactRoot?.unmount();
      state.reactRoot = null;
      state.bootstrapped = false;
      throw error;
    })
    .finally(() => {
      state.bootstrappingPromise = null;
    });

  return state.bootstrappingPromise;
}

function getReactDomClient(win: Window) {
  if (!reactDomClientPromise) {
    bindDomGlobals(win);
    reactDomClientPromise = import("react-dom/client");
  }
  return reactDomClientPromise;
}

function bindDomGlobals(win: Window): void {
  const globalScope = globalThis as typeof globalThis & {
    document?: Document;
    navigator?: Navigator;
    window?: Window;
  };
  if (!globalScope.window) {
    globalScope.window = win;
  }
  if (!globalScope.document) {
    globalScope.document = win.document;
  }
  if (!globalScope.navigator && "navigator" in win) {
    globalScope.navigator = win.navigator;
  }
}

function focusPanel(state: ReaderPanelState): void {
  const focusTarget =
    state.reactRootElement.querySelector<HTMLElement>("textarea,button,[tabindex]") ||
    state.panel;
  state.mainWindow.setTimeout(() => focusTarget.focus?.(), 50);
}

function createPanel(doc: Document): HTMLElement {
  const panel = createHTMLElement(doc, "aside");
  panel.id = PANEL_ID;
  panel.className = "zotero-webai-reader-panel";
  panel.setAttribute("aria-label", "Zotero WebAI reader panel");
  panel.setAttribute("role", "complementary");
  return panel;
}

function createCloseButton(doc: Document): HTMLElement {
  const button = createHTMLElement(doc, "button");
  button.className = "zotero-webai-reader-panel-close";
  button.type = "button";
  button.title = "Hide Zotero WebAI";
  button.setAttribute("aria-label", "Hide Zotero WebAI");
  button.textContent = "x";
  return button;
}

function createReaderButton(doc: Document): HTMLElement {
  const button = createHTMLElement(doc, "button");
  button.id = READER_BUTTON_ID;
  button.className = "zotero-webai-reader-nav-button";
  button.type = "button";
  button.title = "Zotero WebAI";
  button.setAttribute("aria-label", "Zotero WebAI");
  button.setAttribute("aria-pressed", "false");

  const icon = createHTMLElement(doc, "img");
  icon.alt = "";
  icon.src = ICON_SRC;
  button.appendChild(icon);
  return button;
}

function ensureReaderButtonPlacement(state: ReaderPanelState): void {
  const iconPlacement = getSettings().iconPlacement;
  if (iconPlacement === "reader-toolbar") {
    state.navButton.remove();
    removeEmptyRail(state.hostDocument);
    state.rail = null;
    return;
  }
  const rail = getOrCreateReaderRail(state);
  state.rail = rail;
  const nativePlacement = rail.dataset.placement === "native";
  const embeddedPlacement = rail.dataset.placement === "embedded";
  state.navButton.classList.add("is-right-rail");
  rail.classList.toggle("is-native", nativePlacement);
  rail.classList.toggle("is-embedded", embeddedPlacement);
  rail.appendChild(state.navButton);
  if (embeddedPlacement) {
    applyEmbeddedReaderLayout(state);
  }
  syncReaderRailPosition(state);
}

function getOrCreateReaderRail(state: ReaderPanelState): HTMLElement {
  const { hostDocument: doc, parent } = state;
  const nativeSideNav = findReaderSideNav(state);
  const railParent = nativeSideNav || parent;
  const placement = nativeSideNav ? "native" : "embedded";
  const existing = doc.getElementById(READER_RAIL_ID) as HTMLElement | null;
  if (existing) {
    existing.dataset.placement = placement;
    if (existing.parentElement !== railParent) {
      railParent.appendChild(existing);
    }
    return existing;
  }
  const rail = createHTMLElement(doc, "div");
  rail.id = READER_RAIL_ID;
  rail.className = "zotero-webai-reader-rail";
  rail.dataset.placement = placement;
  rail.setAttribute("aria-label", "Zotero WebAI reader controls");
  railParent.appendChild(rail);
  return rail;
}

function findReaderSideNav(state: ReaderPanelState): Element | null {
  const searchRoots = collectReaderSearchRoots(state);
  for (const root of searchRoots) {
    for (const selector of READER_SIDE_NAV_SELECTORS) {
      try {
        const candidates = Array.from(root.querySelectorAll(selector)) as Element[];
        const match = candidates.find((candidate) =>
          isUsableReaderSideNav(candidate, state),
        );
        if (match) {
          return match;
        }
      } catch {
        // Mixed XUL/HTML documents can reject a selector; keep probing.
      }
    }
  }
  return null;
}

function collectReaderSearchRoots(state: ReaderPanelState): Element[] {
  const roots: Element[] = [];
  pushUniqueElement(roots, state.parent);

  const iframe = state.reader._iframe;
  let current = iframe?.parentElement ?? null;
  while (current) {
    pushUniqueElement(roots, current);
    if (current === state.parent || current.id?.includes("tab")) {
      break;
    }
    current = current.parentElement;
  }

  for (const selector of READER_HOST_SELECTORS) {
    try {
      (Array.from(state.hostDocument.querySelectorAll(selector)) as Element[])
        .forEach((candidate) => pushUniqueElement(roots, candidate));
    } catch {
      // Ignore selector support gaps in Zotero's chrome document.
    }
  }

  return roots;
}

function pushUniqueElement(elements: Element[], element?: Element | null): void {
  if (element && !elements.includes(element)) {
    elements.push(element);
  }
}

function isUsableReaderSideNav(
  candidate: Element,
  state: ReaderPanelState,
): boolean {
  if (!(candidate instanceof state.mainWindow.Element)) {
    return false;
  }
  if (candidate.id === READER_RAIL_ID || candidate.id === READER_BUTTON_ID) {
    return false;
  }
  if (candidate.closest(`#${PANEL_ID},#${READER_RAIL_ID}`)) {
    return false;
  }

  const label = [
    candidate.id,
    candidate.className,
    candidate.getAttribute("aria-label"),
    candidate.getAttribute("role"),
  ]
    .join(" ")
    .toLowerCase();
  const looksLikeSideNav =
    /sidenav|side-nav|sidebar|reader|context-pane|navigation|nav/.test(label) ||
    candidate.localName === "sidenav" ||
    candidate.localName === "nav";
  if (!looksLikeSideNav) {
    return false;
  }

  const rect = candidate.getBoundingClientRect?.();
  if (!rect || rect.width <= 0 || rect.height <= 0) {
    return false;
  }
  const parentRect = (state.parent as HTMLElement).getBoundingClientRect?.();
  if (!parentRect || parentRect.width <= 0) {
    return true;
  }

  const nearRightEdge = rect.left >= parentRect.right - Math.max(96, rect.width + 32);
  const narrowEnough = rect.width <= Math.min(96, Math.max(40, parentRect.width * 0.2));
  return nearRightEdge && narrowEnough;
}

function removeEmptyRail(doc: Document): void {
  const rail = doc.getElementById(READER_RAIL_ID);
  if (rail && rail.childElementCount === 0) {
    rail.remove();
  }
}

function resolveReaderPanelParent(
  reader: ReaderWebAIReaderLike,
  hostDocument: Document,
): Element | null {
  return (
    reader._iframe?.parentElement ||
    reader._tabContainer ||
    hostDocument.getElementById("zotero-reader") ||
    hostDocument.getElementById("reader") ||
    hostDocument.documentElement
  );
}

function preparePanelParent(state: ReaderPanelState): void {
  const parent = state.parent as HTMLElement;
  if (!parent?.style) {
    return;
  }
  const computed = state.mainWindow.getComputedStyle?.(parent);
  if (!computed || computed.position === "static" || !computed.position) {
    state.previousParentPosition = parent.style.position || "";
    parent.style.position = "relative";
  }
}

function applyEmbeddedReaderLayout(state: ReaderPanelState): void {
  const parent = state.parent as HTMLElement;
  const iframe = state.reader._iframe as HTMLElement | undefined;
  if (!parent?.style || !iframe?.style) {
    return;
  }

  if (state.previousParentDisplay == null) {
    state.previousParentDisplay = parent.style.display || "";
  }
  if (state.previousParentFlexDirection == null) {
    state.previousParentFlexDirection = parent.style.flexDirection || "";
  }
  if (state.previousParentGap == null) {
    state.previousParentGap = parent.style.gap || "";
  }
  if (state.previousParentAlignItems == null) {
    state.previousParentAlignItems = parent.style.alignItems || "";
  }
  if (state.previousParentMinWidth == null) {
    state.previousParentMinWidth = parent.style.minWidth || "";
  }
  if (state.previousParentOverflow == null) {
    state.previousParentOverflow = parent.style.overflow || "";
  }
  if (state.previousIframeBoxSizing == null) {
    state.previousIframeBoxSizing = iframe.style.boxSizing || "";
  }
  if (state.previousIframeDisplay == null) {
    state.previousIframeDisplay = iframe.style.display || "";
  }
  if (state.previousIframeFlex == null) {
    state.previousIframeFlex = iframe.style.flex || "";
  }
  if (state.previousIframeHeight == null) {
    state.previousIframeHeight = iframe.style.height || "";
  }
  if (state.previousIframeMinWidth == null) {
    state.previousIframeMinWidth = iframe.style.minWidth || "";
  }
  if (state.previousIframeMaxWidth == null) {
    state.previousIframeMaxWidth = iframe.style.maxWidth || "";
  }
  if (state.previousIframeOrder == null) {
    state.previousIframeOrder = iframe.style.order || "";
  }
  if (state.previousIframeWidth == null) {
    state.previousIframeWidth = iframe.style.width || "";
  }
  if (state.previousIframeMarginRight == null) {
    state.previousIframeMarginRight = iframe.style.marginRight || "";
  }

  parent.style.display = "flex";
  parent.style.flexDirection = "row";
  parent.style.gap = "0";
  parent.style.alignItems = "stretch";
  parent.style.minWidth = "0";
  parent.style.overflow = "hidden";
  parent.classList.add(LAYOUT_HOST_CLASS);
  iframe.style.boxSizing = "border-box";
  iframe.style.display = "block";
  iframe.style.flex = "1 1 auto";
  iframe.style.height = "100%";
  iframe.style.marginRight = "0";
  iframe.style.maxWidth = "none";
  iframe.style.minWidth = "0";
  iframe.style.order = "0";
  iframe.style.width = "auto";
  iframe.classList.add(LAYOUT_FRAME_CLASS);
  state.panel.style.order = "2";
  if (state.rail?.dataset.placement === "embedded") {
    state.rail.style.order = "3";
  }
  applyReaderContentCompaction(state);
}

function restoreEmbeddedReaderLayout(state: ReaderPanelState): void {
  const parent = state.parent as HTMLElement;
  const iframe = state.reader._iframe as HTMLElement | undefined;
  parent?.classList?.remove(LAYOUT_HOST_CLASS);
  iframe?.classList?.remove(LAYOUT_FRAME_CLASS);
  if (parent?.style) {
    if (state.previousParentDisplay != null) {
      parent.style.display = state.previousParentDisplay;
      state.previousParentDisplay = null;
    }
    if (state.previousParentFlexDirection != null) {
      parent.style.flexDirection = state.previousParentFlexDirection;
      state.previousParentFlexDirection = null;
    }
    if (state.previousParentGap != null) {
      parent.style.gap = state.previousParentGap;
      state.previousParentGap = null;
    }
    if (state.previousParentAlignItems != null) {
      parent.style.alignItems = state.previousParentAlignItems;
      state.previousParentAlignItems = null;
    }
    if (state.previousParentMinWidth != null) {
      parent.style.minWidth = state.previousParentMinWidth;
      state.previousParentMinWidth = null;
    }
    if (state.previousParentOverflow != null) {
      parent.style.overflow = state.previousParentOverflow;
      state.previousParentOverflow = null;
    }
  }
  if (iframe?.style) {
    if (state.previousIframeBoxSizing != null) {
      iframe.style.boxSizing = state.previousIframeBoxSizing;
      state.previousIframeBoxSizing = null;
    }
    if (state.previousIframeDisplay != null) {
      iframe.style.display = state.previousIframeDisplay;
      state.previousIframeDisplay = null;
    }
    if (state.previousIframeFlex != null) {
      iframe.style.flex = state.previousIframeFlex;
      state.previousIframeFlex = null;
    }
    if (state.previousIframeHeight != null) {
      iframe.style.height = state.previousIframeHeight;
      state.previousIframeHeight = null;
    }
    if (state.previousIframeMinWidth != null) {
      iframe.style.minWidth = state.previousIframeMinWidth;
      state.previousIframeMinWidth = null;
    }
    if (state.previousIframeMaxWidth != null) {
      iframe.style.maxWidth = state.previousIframeMaxWidth;
      state.previousIframeMaxWidth = null;
    }
    if (state.previousIframeOrder != null) {
      iframe.style.order = state.previousIframeOrder;
      state.previousIframeOrder = null;
    }
    if (state.previousIframeWidth != null) {
      iframe.style.width = state.previousIframeWidth;
      state.previousIframeWidth = null;
    }
    if (state.previousIframeMarginRight != null) {
      iframe.style.marginRight = state.previousIframeMarginRight;
      state.previousIframeMarginRight = null;
    }
  }
  state.panel.style.order = "";
  if (state.rail?.style) {
    state.rail.style.order = "";
  }
}

function applyReaderContentCompaction(state: ReaderPanelState): void {
  ensureReaderContentStyle(state.readerDocument);
  state.readerDocument.documentElement?.classList.add(
    "zotero-webai-reader-content-compact",
  );

  const viewerContainer = state.readerDocument.getElementById(
    "viewerContainer",
  ) as HTMLElement | null;
  const viewer = state.readerDocument.getElementById("viewer") as HTMLElement | null;

  if (viewerContainer?.style) {
    if (state.previousViewerContainerPaddingRight == null) {
      state.previousViewerContainerPaddingRight =
        viewerContainer.style.paddingRight || "";
    }
    viewerContainer.style.paddingRight = "0px";
  }

  if (viewer?.style) {
    if (state.previousViewerPaddingRight == null) {
      state.previousViewerPaddingRight = viewer.style.paddingRight || "";
    }
    if (state.previousViewerMarginRight == null) {
      state.previousViewerMarginRight = viewer.style.marginRight || "";
    }
    viewer.style.paddingRight = "0px";
    viewer.style.marginRight = "0px";
  }
}

function restoreReaderContentCompaction(state: ReaderPanelState): void {
  state.readerDocument.documentElement?.classList.remove(
    "zotero-webai-reader-content-compact",
  );

  const viewerContainer = state.readerDocument.getElementById(
    "viewerContainer",
  ) as HTMLElement | null;
  const viewer = state.readerDocument.getElementById("viewer") as HTMLElement | null;

  if (viewerContainer?.style && state.previousViewerContainerPaddingRight != null) {
    viewerContainer.style.paddingRight =
      state.previousViewerContainerPaddingRight;
    state.previousViewerContainerPaddingRight = null;
  }

  if (viewer?.style) {
    if (state.previousViewerPaddingRight != null) {
      viewer.style.paddingRight = state.previousViewerPaddingRight;
      state.previousViewerPaddingRight = null;
    }
    if (state.previousViewerMarginRight != null) {
      viewer.style.marginRight = state.previousViewerMarginRight;
      state.previousViewerMarginRight = null;
    }
  }
}

function syncReaderRailPosition(state: ReaderPanelState): void {
  const rail =
    state.rail ||
    (state.hostDocument.getElementById(READER_RAIL_ID) as HTMLElement | null);
  if (!rail?.style) {
    return;
  }
  rail.style.right = "";
}

function installResizeObserver(state: ReaderPanelState): void {
  const ResizeObserverCtor = state.mainWindow.ResizeObserver;
  if (typeof ResizeObserverCtor !== "function") {
    return;
  }
  const observer = new ResizeObserverCtor(() => {
    if (!state.panel.hidden) {
      applyEmbeddedReaderLayout(state);
    }
    syncReaderRailPosition(state);
  });
  observer.observe(state.panel);
  state.resizeObserver = observer;
}

function cleanupReaderWebAIPanelState(state: ReaderPanelState): void {
  restoreEmbeddedReaderLayout(state);
  restoreReaderContentCompaction(state);
  state.hostDocument.documentElement?.classList.remove(
    "zotero-webai-reader-panel-open",
  );
  (state.parent as HTMLElement).classList?.remove(
    "zotero-webai-reader-panel-open",
  );
  state.readerDocument.documentElement?.classList.remove(
    "zotero-webai-reader-panel-open",
  );
  state.resizeObserver?.disconnect();
  state.reactRoot?.unmount();
  state.navButton.remove();
  state.panel.remove();
  removeEmptyRail(state.hostDocument);
  statesByReaderWindow.delete(state.readerWindow);
  if (state.previousParentPosition != null) {
    (state.parent as HTMLElement).style.position = state.previousParentPosition;
  }
  panelStates.delete(state);
}

function ensureHostStyle(doc: Document): void {
  if (doc.getElementById(HOST_STYLE_ID)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = HOST_STYLE_ID;
  style.textContent = `
    #${PANEL_ID}.zotero-webai-reader-panel {
      background: Canvas;
      border-left: 1px solid color-mix(in srgb, currentColor 18%, transparent);
      box-shadow: none;
      box-sizing: border-box;
      color: CanvasText;
      direction: rtl;
      display: flex;
      flex-direction: column;
      flex: 1 1 auto;
      height: 100%;
      max-width: 100%;
      min-width: 0;
      overflow: auto;
      position: relative;
      resize: vertical;
      width: 100%;
      z-index: 1;
    }
    #${PANEL_ID}.zotero-webai-reader-panel > * {
      direction: ltr;
    }
    .zotero-webai-reader-panel-root {
      box-sizing: border-box;
      display: flex;
      flex: 1 1 auto;
      height: 100%;
      min-height: 0;
      min-width: 0;
      overflow: hidden;
      width: 100%;
    }
    .zotero-webai-reader-panel-close {
      align-items: center;
      appearance: none;
      background: color-mix(in srgb, Canvas 82%, CanvasText 8%);
      border: 1px solid color-mix(in srgb, CanvasText 18%, transparent);
      border-radius: 4px;
      color: CanvasText;
      cursor: pointer;
      display: inline-flex;
      font: menu;
      font-size: 18px;
      height: 24px;
      justify-content: center;
      line-height: 1;
      opacity: 0.78;
      padding: 0;
      position: absolute;
      right: 8px;
      top: 8px;
      width: 24px;
      z-index: 2;
    }
    .zotero-webai-reader-panel-close:hover {
      opacity: 1;
    }
    .zotero-webai-reader-nav-button {
      align-items: center;
      appearance: none;
      background: color-mix(in srgb, Canvas 94%, CanvasText 6%);
      border: 1px solid color-mix(in srgb, CanvasText 14%, transparent);
      border-radius: 7px;
      box-sizing: border-box;
      color: inherit;
      cursor: pointer;
      display: inline-flex;
      height: 36px;
      justify-content: center;
      margin: 2px;
      min-width: 36px;
      padding: 5px;
      position: relative;
      touch-action: manipulation;
      vertical-align: middle;
      width: 36px;
      z-index: 2147482999;
    }
    .zotero-webai-reader-nav-button:hover,
    .zotero-webai-reader-nav-button.is-active {
      background: color-mix(in srgb, Highlight 16%, Canvas 84%);
      border-color: color-mix(in srgb, Highlight 42%, CanvasText 16%);
    }
    .zotero-webai-reader-nav-button img {
      display: block;
      height: 20px;
      pointer-events: none;
      width: 20px;
    }
    .zotero-webai-reader-nav-button.is-right-rail {
      background: Canvas;
    }
    .zotero-webai-reader-rail {
      align-items: center;
      border-left: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
      box-sizing: border-box;
      display: flex;
      flex: 0 0 44px;
      flex-direction: column;
      gap: 2px;
      height: 100%;
      justify-content: flex-start;
      min-height: 0;
      padding: 8px 3px;
    }
    .zotero-webai-reader-rail.is-native {
      border-left: 0;
      box-sizing: border-box;
      flex: 0 0 auto;
      height: auto;
      margin-block: 2px;
      padding: 2px 0;
      position: relative;
      z-index: 2147483001;
    }
    .zotero-webai-reader-rail.is-embedded {
      background: Canvas;
      position: relative;
      z-index: 1;
    }
    .${LAYOUT_HOST_CLASS} {
      align-items: stretch !important;
      box-sizing: border-box !important;
      display: flex !important;
      flex-direction: row !important;
      gap: 0 !important;
      height: 100% !important;
      min-height: 0 !important;
      min-width: 0 !important;
      overflow: hidden !important;
    }
    .${LAYOUT_FRAME_CLASS} {
      bottom: auto !important;
      box-sizing: border-box !important;
      display: block !important;
      flex: 1 1 auto !important;
      height: 100% !important;
      inset: auto !important;
      left: auto !important;
      margin-right: 0 !important;
      max-height: none !important;
      max-width: none !important;
      min-height: 0 !important;
      min-width: 0 !important;
      order: 0 !important;
      position: relative !important;
      right: auto !important;
      top: auto !important;
      width: auto !important;
      z-index: auto !important;
    }
  `;
  appendStyle(doc, style);
}

function ensureReaderContentStyle(doc: Document): void {
  if (doc.getElementById(READER_CONTENT_STYLE_ID)) {
    return;
  }
  const style = doc.createElement("style");
  style.id = READER_CONTENT_STYLE_ID;
  style.textContent = `
    html.zotero-webai-reader-content-compact,
    html.zotero-webai-reader-content-compact body {
      overflow-x: hidden !important;
    }
    html.zotero-webai-reader-content-compact #viewerContainer {
      padding-right: 0 !important;
    }
    html.zotero-webai-reader-content-compact #viewer {
      margin-right: 0 !important;
      padding-right: 0 !important;
    }
    html.zotero-webai-reader-content-compact #viewer .page,
    html.zotero-webai-reader-content-compact .pdfViewer .page {
      margin-left: auto !important;
      margin-right: auto !important;
    }
  `;
  appendStyle(doc, style);
}

function appendStyle(doc: Document, style: HTMLStyleElement): void {
  (doc.head || doc.documentElement)?.appendChild(style);
}

function createHTMLElement<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tagName: K,
): HTMLElementTagNameMap[K] {
  return doc.createElementNS(HTML_NS, tagName) as HTMLElementTagNameMap[K];
}

function getActiveReader(): ReaderWebAIReaderLike | null {
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
  const tabID = `${win?.Zotero_Tabs?.selectedID || win?.Zotero_Tabs?._selectedID || ""}`;
  if (!tabID) {
    return null;
  }
  return Zotero.Reader.getByTabID(tabID) as ReaderWebAIReaderLike | null;
}
