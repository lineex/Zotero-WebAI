import React from "react";
import { config } from "../../package.json";
import { createHostCustomEvent } from "../utils/domEvents";
import { EventBus } from "../utils/eventBus";
import { getLocaleID } from "../utils/locale";
import { Sidebar } from "./components/Sidebar";
import { getCurrentScope } from "../services/scopeResolver";
import { getSettings } from "../services/settingsManager";
import {
  attachSidebarHost,
  createFallbackSidebarHost,
  createSectionSidebarHost,
  resolveSidebarLocation,
  type SidebarHostState,
  type SidebarLocation,
  type SidebarSurfaceHost,
} from "./sidebarSection";
import { registerSidebarRefreshHandler } from "./sidebarRuntime";
import { typography } from "./typography";
import {
  cleanupReaderWebAIPanelsForWindow,
  syncActiveReaderWebAIPanel,
  type ReaderWebAIReaderLike,
} from "../modules/readerWebAIPanel";

interface ItemMessagePaneLike extends HTMLElement {
  renderCustomHead?(
    callback?: (args: {
      append: (...nodes: unknown[]) => void;
      doc: Document;
    }) => void,
  ): void;
}

interface SectionRenderBody {
  appendChild?(node: unknown): unknown;
  closest?(selector: string): Element | null;
  contains(node: unknown): boolean;
  ownerDocument: Document;
  replaceChildren(...nodes: unknown[]): void;
}

interface ContextPaneLike {
  focus?: () => void;
  sidenav?: Element;
  splitter?: Element;
  togglePane?: () => void;
}

const SECTION_PANE_ID = "ai-assistant-sidebar";
const LIBRARY_HOST_ID = "ai-assistant-pane-library-mount";
const READER_HOST_ID = "ai-assistant-pane-reader-mount";
const FOCUS_MODE_CLASS = "zotero-webai-focus-mode";
const FOCUS_SECTION_CLASS = "zotero-webai-focus-section";
const LEGACY_STANDALONE_ARTIFACT_IDS = [
  "ai-assistant-library-empty-state",
  "ai-assistant-library-empty-state-sidenav-btn",
  "zotero-ai-assistant-tb-chat-toggle",
];

const windowHosts = new WeakMap<Window, SidebarHostState>();
const windowRefreshCleanup = new WeakMap<Window, () => void>();
const windowSectionRefresh = new WeakMap<
  Window,
  () => Promise<void>
>();
const windowScopeRetryTimer = new WeakMap<Window, number>();
const windowLibraryEmptyStateRetryTimer = new WeakMap<
  Window,
  number
>();
const windowLibraryEmptyStateRetryBudget = new WeakMap<
  Window,
  number
>();
const windowReaderSectionWasExpanded = new WeakMap<Window, boolean>();
const BRANDED_SECTION_ICON =
  `chrome://${config.addonRef}/content/icons/icon-20.png`;

let sectionRegistered = false;
let reactDomClientPromise: Promise<typeof import("react-dom/client")> | null =
  null;

export class UIFactory {
  static registerChatPanel(win: Window) {
    this.removeLegacyStandaloneArtifacts(win);
    this.registerSection();
    this.removeTabBarButton(win);
    this.clearWebAIFocusMode(win);
    this.ensureWindowRefreshRegistration(win);
    this.ensureTabSelectionRefreshRegistration(win);
  }

  static removeChatPanel(win: Window) {
    const hosts = windowHosts.get(win);
    if (hosts) {
      [hosts.library, hosts.reader].forEach((hostState) => {
        hostState?.reactRoot?.unmount();
        if (hostState?.attachmentTarget !== "section-body") {
          hostState?.mountPoint.remove();
        }
      });
      windowHosts.delete(win);
    }

    this.clearScopeRetryTimer(win);
    this.clearLibraryEmptyStateRetryTimer(win);
    this.clearTabBarButtonRetryTimer(win);
    windowLibraryEmptyStateRetryBudget.delete(win);
    windowReaderSectionWasExpanded.delete(win);
    this.renderLibraryEmptyStateHead(win, false);
    this.removeTabSelectionRefreshRegistration(win);
    windowRefreshCleanup.get(win)?.();
    windowRefreshCleanup.delete(win);
    windowSectionRefresh.delete(win);
    this.removeTabBarButton(win);
    cleanupReaderWebAIPanelsForWindow(win);
    this.clearWebAIFocusMode(win);
    this.removeLegacyStandaloneArtifacts(win);
  }

  static refreshWindow(win: Window) {
    this.removeTabBarButton(win);
    void this.requestSectionRefresh(win);
    this.syncLibraryEmptyStateHost(win);
    if (this.getSelectedLocation(win) === "reader") {
      syncActiveReaderWebAIPanel();
    }
  }

  static refreshAllWindows() {
    for (const win of Zotero.getMainWindows()) {
      this.refreshWindow(win);
    }
  }

  static shutdown() {
    for (const win of Zotero.getMainWindows()) {
      try {
        this.removeChatPanel(win);
      } catch {
        // Ignore teardown issues while shutting down.
      }
    }

    if (sectionRegistered) {
      this.unregisterLegacySection();
    }
  }

  private static unregisterLegacySection(): void {
    try {
      Zotero.ItemPaneManager.unregisterSection(SECTION_PANE_ID);
    } catch {
      // Ignore unregister failures while moving the UI out of the item pane.
    }
    sectionRegistered = false;
  }

  private static registerSection() {
    if (sectionRegistered) {
      return;
    }

    Zotero.ItemPaneManager.registerSection({
      paneID: SECTION_PANE_ID,
      pluginID: config.addonID,
      header: {
        l10nID: getLocaleID("ai-assistant-sidebar-title"),
        icon: BRANDED_SECTION_ICON,
      },
      sidenav: {
        l10nID: getLocaleID("ai-assistant-sidebar-sidenav"),
        icon: BRANDED_SECTION_ICON,
      },
      onInit: ({ setEnabled, tabType, body, refresh }) => {
        setEnabled(
          this.shouldEnableSection(tabType || "", body as SectionRenderBody),
        );
        this.registerSectionRefresh(body as SectionRenderBody, refresh);
      },
      onItemChange: ({ setEnabled, tabType, body }) => {
        setEnabled(
          this.shouldEnableSection(tabType || "", body as SectionRenderBody),
        );
        this.syncSectionScope(body as SectionRenderBody, tabType || "");
        this.restoreReaderSectionExpansion(
          body as SectionRenderBody,
          tabType || "",
        );
        this.renderReaderSectionBodyOnItemChange(
          body as SectionRenderBody,
          tabType || "",
        );
        return true;
      },
      onRender: ({ body, tabType }) => {
        this.renderSectionBody(body as SectionRenderBody, tabType || "");
      },
      onAsyncRender: async ({ body, tabType }) => {
        this.renderSectionBody(body as SectionRenderBody, tabType || "");
      },
    });

    sectionRegistered = true;
  }

  private static shouldEnableSection(
    tabType: string,
    body?: SectionRenderBody,
  ): boolean {
    const location = this.resolveSectionLocation(tabType, body);
    if (!location) {
      return false;
    }
    if (location === "library" && !getSettings().itemPaneButtonEnabled) {
      return false;
    }
    return true;
  }

  private static renderSectionBody(body: SectionRenderBody, tabType: string) {
    const location = this.resolveSectionLocation(tabType, body);
    if (!location) {
      body.replaceChildren();
      return;
    }

    const win = body.ownerDocument.defaultView as Window | null;
    if (!win) {
      const host = createFallbackSidebarHost(location, body.ownerDocument);
      attachSidebarHost(body, host);
      this.renderBootstrapFailure(
        host,
        location,
        new Error(
          "Zotero WebAI could not access the Zotero window while rendering.",
        ),
      );
      return;
    }

    const hosts = this.ensureWindowHosts(win);
    const existing = hosts[location];
    const sectionBody = body as unknown as HTMLDivElement;
    if (existing && existing.mountPoint !== sectionBody) {
      existing.reactRoot?.unmount();
      delete hosts[location];
    }

    const host = hosts[location] ?? {
      attachmentTarget: "section-body" as const,
      mountPoint: sectionBody,
      reactRoot: null,
      reactRootElement: sectionBody,
      bootstrapped: false,
      bootstrappingPromise: null,
    };
    host.attachmentTarget = "section-body";
    hosts[location] = host;

    host.mountPoint.style.display = "flex";
    this.rememberReaderSectionExpansion(win, body, location);

    void this.ensureHostBootstrapped(win, host, location).catch((error) => {
      ztoolkit.log(
        `Failed to bootstrap Zotero WebAI ${location} section host:`,
        error,
      );
      this.renderBootstrapFailure(host, location, error);
    });
  }

  private static ensureWindowRefreshRegistration(win: Window) {
    if (windowRefreshCleanup.has(win)) {
      return;
    }

    const unregister = registerSidebarRefreshHandler(() => {
      if (!win.closed) {
        void this.requestSectionRefresh(win);
        this.refreshWindow(win);
      }
    });
    windowRefreshCleanup.set(win, unregister);
  }

  private static ensureTabSelectionRefreshRegistration(win: Window) {
    if (win.__aiAssistantTabObserverId) {
      return;
    }

    const callback = {
      notify: (event: string, type: string) => {
        if (event === "select" && type === "tab" && !win.closed) {
          void this.requestSectionRefresh(win);
          this.refreshWindow(win);
        }
      },
    };

    try {
      win.__aiAssistantTabObserverId = Zotero.Notifier.registerObserver(
        callback,
        ["tab"],
        `${config.addonID}-ui-tab-refresh`,
      );
    } catch (error) {
      ztoolkit.log(
        "Failed to register Zotero WebAI tab refresh observer:",
        error,
      );
      win.__aiAssistantTabObserverId = null;
    }
  }

  private static removeTabSelectionRefreshRegistration(win: Window) {
    const observerId = win.__aiAssistantTabObserverId;
    if (!observerId) {
      return;
    }

    try {
      Zotero.Notifier.unregisterObserver(observerId);
    } catch {
      // Ignore stale observer cleanup errors.
    }
    win.__aiAssistantTabObserverId = null;
  }

  private static clearTabBarButtonRetryTimer(win: Window): void {
    void win;
  }

  private static removeTabBarButton(win: Window): void {
    win.document.getElementById("zotero-webai-tabbar-button")?.remove();
    win.document.getElementById("zotero-webai-tabbar-actions")?.remove();
  }

  static async openSidebarFromReaderToolbar(win: Window): Promise<void> {
    try {
      this.registerSection();
      await this.requestSectionRefresh(win);
      this.ensureRightSidebarOpen(win);
      this.clickSidebarSectionButton(win);
      await this.requestSectionRefresh(win);
      this.focusWebAISection(win);
    } catch (error) {
      ztoolkit.log("Failed to open Zotero WebAI reader sidebar:", error);
    }
  }

  private static getSelectedReader(win: Window): ReaderWebAIReaderLike | null {
    const selectedType = `${win.Zotero_Tabs?.selectedType || ""}`.toLowerCase();
    if (!selectedType.includes("reader")) {
      return null;
    }
    const selectedID = `${win.Zotero_Tabs?.selectedID || ""}`;
    if (!selectedID) {
      return null;
    }
    return Zotero.Reader.getByTabID(selectedID) as ReaderWebAIReaderLike | null;
  }

  private static ensureRightSidebarOpen(win: Window): void {
    const location = this.getSelectedLocation(win);
    if (location === "reader") {
      const contextPane = this.getReaderContextPane(win);
      if (contextPane) {
        this.ensureContextPaneOpen(contextPane);
        contextPane.focus?.();
      }
      return;
    }

    const itemPane = win.ZoteroPane?.itemPane as
      | {
          collapsed?: boolean;
          hidden?: boolean;
          togglePane?: () => void;
        }
      | undefined;
    if (itemPane?.collapsed && typeof itemPane.togglePane === "function") {
      itemPane.togglePane();
    } else if (itemPane) {
      itemPane.collapsed = false;
      itemPane.hidden = false;
    }
  }

  private static getReaderContextPane(win: Window): ContextPaneLike | null {
    const pane = (win as Window & { ZoteroContextPane?: ContextPaneLike })
      .ZoteroContextPane;
    if (pane?.sidenav) {
      return pane;
    }

    const sidenav = this.findSidebarSidenav(win.document);
    if (!sidenav && !pane) {
      return null;
    }

    return {
      ...pane,
      sidenav: pane?.sidenav || sidenav || undefined,
    };
  }

  private static ensureContextPaneOpen(contextPane: ContextPaneLike): void {
    const paneRoot = contextPane.sidenav?.closest?.(
      "zotero-context-pane,#zotero-context-pane,.zotero-context-pane",
    ) as HTMLElement | null;
    const collapsed =
      contextPane.sidenav?.getAttribute("collapsed") === "true" ||
      (contextPane.sidenav as HTMLElement | undefined)?.hidden ||
      contextPane.splitter?.getAttribute("state") === "collapsed" ||
      paneRoot?.getAttribute("collapsed") === "true" ||
      paneRoot?.hidden;

    if (collapsed) {
      contextPane.togglePane?.();
    }
  }

  private static clickSidebarSectionButton(win: Window): void {
    const sidenav = this.findSidebarSidenav(win.document);
    if (!sidenav) {
      return;
    }

    const target = this.findSectionSidenavButton(sidenav);
    if ((target as HTMLElement | null)?.click) {
      (target as HTMLElement).click();
      return;
    }

    target?.dispatchEvent(
      new win.MouseEvent("click", {
        bubbles: true,
        cancelable: true,
      }),
    );
  }

  private static focusWebAISection(win: Window): void {
    const mount = this.findWebAISectionMount(win.document);
    if (!mount) {
      return;
    }

    const paneRoot = mount.closest(
      "zotero-context-pane,#zotero-context-pane,.zotero-context-pane,#zotero-item-pane",
    ) as HTMLElement | null;
    if (paneRoot) {
      paneRoot.classList.add(FOCUS_MODE_CLASS);
      paneRoot.scrollTop = 0;
    }
    const section = this.findSectionContainer(mount as unknown as SectionRenderBody);
    section?.classList.add(FOCUS_SECTION_CLASS);

    const scrollContainers = Array.from(
      mount.querySelectorAll(
        ".ai-assistant-pane,.ai-assistant-pane-mount",
      ) as NodeListOf<Element>,
    ).filter(
      (node): node is HTMLElement =>
        typeof node === "object" && node !== null && "scrollTop" in node,
    );
    scrollContainers.forEach((container) => {
      container.scrollTop = 0;
    });

    const focusTarget =
      mount.querySelector<HTMLElement>("textarea,button,[tabindex]") || mount;
    focusTarget.focus?.();
  }

  private static clearWebAIFocusMode(win: Window): void {
    try {
      win.document
        .querySelectorAll(`.${FOCUS_MODE_CLASS},.${FOCUS_SECTION_CLASS}`)
        .forEach((node: Element) => {
          node.classList.remove(FOCUS_MODE_CLASS, FOCUS_SECTION_CLASS);
        });
    } catch {
      // Ignore mixed XUL/HTML selector quirks during teardown.
    }
  }

  private static findWebAISectionMount(doc: Document): HTMLElement | null {
    return (
      (doc.getElementById(READER_HOST_ID) as HTMLElement | null) ||
      (doc.getElementById(LIBRARY_HOST_ID) as HTMLElement | null) ||
      (doc.getElementById("ai-assistant-pane-reader") as HTMLElement | null) ||
      (doc.getElementById("ai-assistant-pane-library") as HTMLElement | null)
    );
  }

  private static findSidebarSidenav(doc: Document): Element | null {
    const selectors = [
      "#zotero-view-item-sidenav",
      "#zotero-item-pane-sidenav",
      "#zotero-context-pane-sidenav",
      "zotero-context-pane sidenav",
      ".zotero-context-pane-sidenav",
      ".zotero-item-pane-sidenav",
    ];

    for (const selector of selectors) {
      try {
        const match = doc.querySelector(selector);
        if (match) {
          return match;
        }
      } catch {
        // Ignore selector support gaps in Zotero's mixed XUL/HTML document.
      }
    }

    return null;
  }

  private static findSectionSidenavButton(sidenav: Element): Element | null {
    const selectors = [
      `[data-pane-id="${SECTION_PANE_ID}"]`,
      `[data-paneid="${SECTION_PANE_ID}"]`,
      `[pane-id="${SECTION_PANE_ID}"]`,
      `[paneid="${SECTION_PANE_ID}"]`,
      `[value="${SECTION_PANE_ID}"]`,
      `[aria-controls="${SECTION_PANE_ID}"]`,
      `#${SECTION_PANE_ID}`,
    ];

    for (const selector of selectors) {
      try {
        const target = sidenav.querySelector(selector);
        if (target) {
          return target;
        }
      } catch {
        // Ignore selector support differences between XUL and HTML elements.
      }
    }

    try {
      const candidates = Array.from(
        sidenav.querySelectorAll("button, toolbarbutton, div, span"),
      ) as Element[];
      return (
        candidates.find((candidate) => {
          const element = candidate as HTMLElement;
          return String(
            element.dataset?.paneId ||
              element.getAttribute("aria-label") ||
              element.getAttribute("title") ||
              element.textContent ||
              "",
          )
            .toLowerCase()
            .includes("zotero-webai");
        }) || null
      );
    } catch {
      return null;
    }
  }

  private static isChineseLocale(): boolean {
    try {
      const locale =
        (globalThis as unknown as { Zotero?: { locale?: string } }).Zotero
          ?.locale ||
        ((globalThis as unknown as {
          Zotero?: {
            Prefs?: { get?: (key: string, global?: boolean) => unknown };
          };
        }).Zotero?.Prefs?.get?.("intl.accept_languages", true) as string) ||
        "";
      return String(locale).toLowerCase().startsWith("zh");
    } catch {
      return false;
    }
  }

  private static ensureWindowHosts(win: Window): SidebarHostState {
    const existing = windowHosts.get(win);
    if (existing) {
      return existing;
    }

    const nextHosts: SidebarHostState = {};
    windowHosts.set(win, nextHosts);
    return nextHosts;
  }

  private static registerSectionRefresh(
    body: SectionRenderBody,
    refresh: (() => Promise<void>) | undefined,
  ) {
    if (!refresh) {
      return;
    }

    const win = body.ownerDocument.defaultView as Window | null;
    if (!win) {
      return;
    }

    windowSectionRefresh.set(win, refresh);
  }

  private static syncSectionScope(body: SectionRenderBody, tabType: string) {
    const win = body.ownerDocument.defaultView as Window | null;
    const eventBus = win?.__aiAssistantEventBus ?? EventBus.getInstance();
    const initialScope = getCurrentScope();
    this.dispatchScopeChange(eventBus, initialScope, win);

    const location = this.resolveSectionLocation(tabType, body);
    if (!win || (location !== "library" && location !== "reader")) {
      return;
    }

    this.clearScopeRetryTimer(win);
    const retryTimer = win.setTimeout(() => {
      this.clearScopeRetryTimer(win);
      const retriedScope = getCurrentScope();
      if (!this.areScopesEquivalent(initialScope, retriedScope)) {
        this.dispatchScopeChange(eventBus, retriedScope, win);
      }
    }, location === "reader" ? 150 : 100);
    windowScopeRetryTimer.set(win, retryTimer);
  }

  private static renderReaderSectionBodyOnItemChange(
    body: SectionRenderBody,
    tabType: string,
  ): void {
    if (this.resolveSectionLocation(tabType, body) !== "reader") {
      return;
    }

    this.renderSectionBody(body, tabType);
  }

  private static rememberReaderSectionExpansion(
    win: Window,
    body: SectionRenderBody,
    location: SidebarLocation,
  ): void {
    if (location !== "reader") {
      return;
    }

    const section = this.findSectionContainer(body);
    if (!section || this.isSectionCollapsed(section)) {
      return;
    }

    windowReaderSectionWasExpanded.set(win, true);
  }

  private static restoreReaderSectionExpansion(
    body: SectionRenderBody,
    tabType: string,
  ): void {
    if (this.resolveSectionLocation(tabType, body) !== "reader") {
      return;
    }

    const win = body.ownerDocument.defaultView as Window | null;
    if (!win || !windowReaderSectionWasExpanded.get(win)) {
      return;
    }

    const section = this.findSectionContainer(body);
    if (!section || !this.isSectionCollapsed(section)) {
      return;
    }

    section.removeAttribute("collapsed");
    section.setAttribute("open", "true");
    section.setAttribute("aria-expanded", "true");
  }

  private static findSectionContainer(
    body: SectionRenderBody,
  ): Element | null {
    const selectors = [
      `[data-pane-id="${SECTION_PANE_ID}"]`,
      `[paneid="${SECTION_PANE_ID}"]`,
      `[data-paneid="${SECTION_PANE_ID}"]`,
      `#${SECTION_PANE_ID}`,
    ];

    for (const selector of selectors) {
      try {
        const match = body.closest?.(selector);
        if (match) {
          return match;
        }
      } catch {
        // Ignore selector support differences between XUL and HTML elements.
      }
    }

    let current = (body as unknown as Element | null)?.parentElement ?? null;
    while (current) {
      if (
        current.id === SECTION_PANE_ID ||
        current.getAttribute?.("data-pane-id") === SECTION_PANE_ID ||
        current.getAttribute?.("paneid") === SECTION_PANE_ID ||
        current.getAttribute?.("data-paneid") === SECTION_PANE_ID
      ) {
        return current;
      }
      current = current.parentElement;
    }

    return null;
  }

  private static isSectionCollapsed(section: Element): boolean {
    return (
      section.getAttribute("collapsed") === "true" ||
      section.getAttribute("aria-expanded") === "false" ||
      section.getAttribute("open") === "false"
    );
  }

  private static dispatchScopeChange(
    eventBus: EventTarget,
    scope: ReturnType<typeof getCurrentScope>,
    win?: Window | null,
  ) {
    eventBus.dispatchEvent(createHostCustomEvent("scopeChange", scope, win));
  }

  private static areScopesEquivalent(
    left: ReturnType<typeof getCurrentScope>,
    right: ReturnType<typeof getCurrentScope>,
  ): boolean {
    return left?.type === right?.type && left?.id === right?.id;
  }

  private static clearScopeRetryTimer(win: Window) {
    const retryTimer = windowScopeRetryTimer.get(win);
    if (retryTimer == null) {
      return;
    }

    win.clearTimeout(retryTimer);
    windowScopeRetryTimer.delete(win);
  }

  private static async requestSectionRefresh(
    win: Window,
  ): Promise<void> {
    try {
      await windowSectionRefresh.get(win)?.();
    } catch (error) {
      ztoolkit.log("Failed to refresh Zotero WebAI section state:", error);
    }
  }

  private static syncLibraryEmptyStateHost(win: Window): void {
    const selectedLocation = this.getSelectedLocation(win);
    if (selectedLocation !== "library") {
      this.clearLibraryEmptyStateRetryTimer(win);
      windowLibraryEmptyStateRetryBudget.delete(win);
      this.renderLibraryEmptyStateHead(win, false);
      return;
    }

    const selectedItems = win.ZoteroPane?.getSelectedItems?.() ?? [];
    const shouldRender = selectedItems.length === 0;
    const didRender = this.renderLibraryEmptyStateHead(win, shouldRender);

    if (!shouldRender || didRender) {
      this.clearLibraryEmptyStateRetryTimer(win);
      windowLibraryEmptyStateRetryBudget.delete(win);
      return;
    }

    this.scheduleLibraryEmptyStateRetry(win);
  }

  private static renderLibraryEmptyStateHead(
    win: Window,
    shouldRender: boolean,
  ): boolean {
    const messagePane = this.getLibraryMessagePane(win.document);
    if (!messagePane?.renderCustomHead) {
      return false;
    }

    const libraryHost = windowHosts.get(win)?.library;
    if (!shouldRender) {
      messagePane.renderCustomHead();
      if (libraryHost?.attachmentTarget === "message-head") {
        libraryHost.reactRoot?.unmount();
        libraryHost.reactRoot = null;
        libraryHost.bootstrapped = false;
        libraryHost.bootstrappingPromise = null;
        libraryHost.attachmentTarget = null;
      }
      return true;
    }

    const host = this.getOrCreateLibraryMessageHeadHost(win);
    messagePane.renderCustomHead(({ append }) => {
      append(host.mountPoint);
      host.attachmentTarget = "message-head";
    });

    void this.ensureHostBootstrapped(win, host, "library").catch((error) => {
      ztoolkit.log(
        "Failed to bootstrap Zotero WebAI library empty-state host:",
        error,
      );
      this.renderBootstrapFailure(host, "library", error);
    });
    return true;
  }

  private static getOrCreateLibraryMessageHeadHost(
    win: Window,
  ): SidebarSurfaceHost {
    const hosts = this.ensureWindowHosts(win);
    const existing = hosts.library;
    if (existing?.attachmentTarget === "message-head") {
      return existing;
    }

    if (existing) {
      existing.reactRoot?.unmount();
    }

    const host = createSectionSidebarHost(
      "library",
      win.document as unknown as Document,
    );
    hosts.library = host;
    return host;
  }

  private static getLibraryMessagePane(
    doc: Pick<Document, "getElementById">,
  ): ItemMessagePaneLike | null {
    return doc.getElementById(
      "zotero-item-message",
    ) as ItemMessagePaneLike | null;
  }

  private static scheduleLibraryEmptyStateRetry(win: Window): void {
    if (windowLibraryEmptyStateRetryTimer.has(win)) {
      return;
    }

    const retries = windowLibraryEmptyStateRetryBudget.get(win) ?? 0;
    if (retries >= 5) {
      return;
    }
    windowLibraryEmptyStateRetryBudget.set(win, retries + 1);

    const timer = win.setTimeout(() => {
      windowLibraryEmptyStateRetryTimer.delete(win);
      this.syncLibraryEmptyStateHost(win);
    }, 100);
    windowLibraryEmptyStateRetryTimer.set(win, timer);
  }

  private static clearLibraryEmptyStateRetryTimer(
    win: Window,
  ): void {
    const retryTimer = windowLibraryEmptyStateRetryTimer.get(win);
    if (retryTimer == null) {
      return;
    }

    win.clearTimeout(retryTimer);
    windowLibraryEmptyStateRetryTimer.delete(win);
  }

  private static ensureHostBootstrapped(
    win: Window,
    hostState: SidebarSurfaceHost,
    location: SidebarLocation,
  ): Promise<void> {
    if (hostState.bootstrapped) {
      return Promise.resolve();
    }

    if (hostState.bootstrappingPromise) {
      return hostState.bootstrappingPromise;
    }

    hostState.bootstrappingPromise = (async () => {
      const { createRoot } = await this.getReactDomClient(win);
      if (!hostState.reactRoot) {
        hostState.reactRoot = createRoot(hostState.reactRootElement);
      }

      hostState.reactRoot.render(
        React.createElement(Sidebar, {
          eventBus: EventBus.getInstance(),
          hostWindow: win,
          location,
        }),
      );
      hostState.bootstrapped = true;
    })()
      .catch((error) => {
        hostState.reactRoot?.unmount();
        hostState.reactRoot = null;
        hostState.bootstrapped = false;
        throw error;
      })
      .finally(() => {
        hostState.bootstrappingPromise = null;
      });

    return hostState.bootstrappingPromise;
  }

  private static resolveSectionLocation(
    tabType: string,
    body?: SectionRenderBody,
  ): SidebarLocation | null {
    const direct = resolveSidebarLocation(tabType);
    if (direct) {
      return direct;
    }

    const win = body?.ownerDocument?.defaultView as
      | Window
      | null
      | undefined;
    return win ? this.getSelectedLocation(win) : null;
  }

  private static getSelectedLocation(
    win: Window,
  ): SidebarLocation | null {
    return resolveSidebarLocation(win.Zotero_Tabs?.selectedType || "");
  }

  private static async getReactDomClient(win: Window) {
    if (!reactDomClientPromise) {
      this.bindDomGlobals(win);
      reactDomClientPromise = import("react-dom/client");
    }
    return reactDomClientPromise;
  }

  private static bindDomGlobals(win: Window) {
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

  private static removeStaleMounts(
    win: Window,
    mountId: string,
    keepMount: HTMLElement,
  ) {
    const root = (win.document.documentElement ||
      win.document.body) as ParentNode | null;
    const staleMounts = this.collectElementsById(root, mountId).filter(
      (element) => element !== keepMount,
    );

    staleMounts.forEach((staleMount) => {
      staleMount.remove();
    });
  }

  private static removeLegacyStandaloneArtifacts(win: Window) {
    const root = (win.document.documentElement ||
      win.document.body) as ParentNode | null;
    for (const artifactId of LEGACY_STANDALONE_ARTIFACT_IDS) {
      this.collectElementsById(root, artifactId).forEach((element) => {
        element.remove();
      });
    }
  }

  private static collectElementsById(
    root: ParentNode | null,
    id: string,
  ): HTMLElement[] {
    if (!root || !("children" in root)) {
      return [];
    }

    const matches: HTMLElement[] = [];
    const stack = Array.from((root as Element).children);

    while (stack.length > 0) {
      const next = stack.shift();
      if (!next || typeof next !== "object" || !("children" in next)) {
        continue;
      }

      if ((next as HTMLElement).id === id) {
        matches.push(next as HTMLElement);
      }

      stack.unshift(...Array.from((next as Element).children));
    }

    return matches;
  }

  private static renderBootstrapFailure(
    hostState: SidebarSurfaceHost,
    location: SidebarLocation,
    error: unknown,
  ) {
    const message =
      error instanceof Error && error.message
        ? error.message
        : "Unknown sidebar bootstrap failure";

    if (hostState.reactRoot) {
      try {
        hostState.reactRoot.render(
          React.createElement(SectionErrorCard, { location, message }),
        );
        return;
      } catch {
        // Fall back to direct DOM content below.
      }
    }

    const root = hostState.reactRootElement;
    const doc = root.ownerDocument;
    if (!doc) {
      root.textContent = message;
      return;
    }
    root.replaceChildren();

    const title = doc.createElement("div");
    title.textContent = `${location === "reader" ? "Reader" : "Library"} panel unavailable`;
    Object.assign(title.style, {
      color: "#7f1d1d",
      fontSize: typography.headingSm,
      fontWeight: "700",
      marginBottom: "8px",
    });

    const detail = doc.createElement("div");
    detail.textContent = message;
    Object.assign(detail.style, {
      color: "#991b1b",
      fontSize: typography.meta,
      lineHeight: "1.5",
    });

    Object.assign(root.style, {
      background: "#fff1f2",
      border: "1px solid #fecdd3",
      borderRadius: "14px",
      boxSizing: "border-box",
      margin: "12px",
      padding: "12px",
    });
    root.appendChild(title);
    root.appendChild(detail);
  }
}

function SectionErrorCard({
  location,
  message,
}: {
  location: SidebarLocation;
  message: string;
}) {
  return React.createElement(
    "div",
    {
      style: {
        background: "#fff1f2",
        border: "1px solid #fecdd3",
        borderRadius: "14px",
        boxSizing: "border-box",
        color: "#881337",
        display: "flex",
        flexDirection: "column",
        gap: "8px",
        height: "100%",
        margin: "12px",
        padding: "14px",
      },
    },
    React.createElement(
      "div",
      {
        style: {
          fontSize: typography.headingSm,
          fontWeight: 700,
        },
      },
      `${location === "reader" ? "Reader" : "Library"} sidebar fallback`,
    ),
    React.createElement(
      "div",
      {
        style: {
          fontSize: typography.meta,
          lineHeight: 1.5,
        },
      },
      message,
    ),
  );
}
