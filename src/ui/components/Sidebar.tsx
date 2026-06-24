import React, { useEffect, useRef, useState } from "react";
import {
  assembleContext,
  type AssembledContext,
} from "../../services/contextAssembler";
import { getCurrentScope } from "../../services/scopeResolver";
import { getSettings, type Settings } from "../../services/settingsManager";
import type { ScopeContext } from "../../types/scope";
import { createHostEvent } from "../../utils/domEvents";
import { debugLog } from "../../utils/debugLog";
import { getRequestedLanguage, isChineseLocale } from "../../utils/locale";
import {
  buildReaderActionDraft,
  mergeReaderActionScope,
  type ReaderActionDetail,
} from "../readerActionFlow";
import { isSidebarLocationSelected } from "../sidebarSection";
import { getSidebarTheme } from "../theme";
import { typography } from "../typography";
import {
  WebAIWorkspace,
  type IncomingWebPrompt,
} from "./WebAIWorkspace";

interface SidebarProps {
  eventBus: EventTarget;
  hostWindow: Window;
  location: "library" | "reader";
}

export const Sidebar: React.FC<SidebarProps> = ({
  eventBus,
  hostWindow,
  location,
}) => {
  const [scope, setScope] = useState<ScopeContext | null>(null);
  const [contextSummary, setContextSummary] = useState<AssembledContext | null>(
    null,
  );
  const [settings, setSettings] = useState<Settings>(getSettings);
  const [incomingPrompt, setIncomingPrompt] =
    useState<IncomingWebPrompt | null>(null);
  const [themeRefreshKey, setThemeRefreshKey] = useState(0);
  const scopeSyncVersionRef = useRef(0);
  const theme = getSidebarTheme(hostWindow);
  const isZh = isChineseLocale(getRequestedLanguage());

  const syncSidebarScope = async (
    nextScope: ScopeContext | null,
  ): Promise<void> => {
    const version = ++scopeSyncVersionRef.current;
    setScope(nextScope);
    const summary = await summarizeScope(nextScope);
    if (version === scopeSyncVersionRef.current) {
      setContextSummary(summary);
    }
  };

  const syncResolvedScope = () => {
    void syncSidebarScope(getCurrentScope());
  };

  useEffect(() => {
    const refreshSettings = () => {
      setSettings(getSettings());
      if (location === "reader") {
        syncResolvedScope();
      }
    };

    refreshSettings();
    const handleSettingsChange = () => {
      refreshSettings();
    };
    hostWindow.addEventListener("focus", refreshSettings);
    eventBus.addEventListener("settingsChange", handleSettingsChange);
    return () => {
      hostWindow.removeEventListener("focus", refreshSettings);
      eventBus.removeEventListener("settingsChange", handleSettingsChange);
    };
  }, [eventBus, hostWindow, location]);

  useEffect(() => {
    const mediaQuery = hostWindow.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mediaQuery) {
      return;
    }

    const handleThemeChange = () => {
      setThemeRefreshKey((value) => value + 1);
    };

    mediaQuery.addEventListener?.("change", handleThemeChange);
    mediaQuery.addListener?.(handleThemeChange);

    return () => {
      mediaQuery.removeEventListener?.("change", handleThemeChange);
      mediaQuery.removeListener?.(handleThemeChange);
    };
  }, [hostWindow]);

  useEffect(() => {
    const handleScopeChange = (event: Event) => {
      const nextScope = (event as CustomEvent).detail as ScopeContext | null;
      void syncSidebarScope(nextScope);
    };

    eventBus.addEventListener("scopeChange", handleScopeChange);
    return () => eventBus.removeEventListener("scopeChange", handleScopeChange);
  }, [eventBus]);

  useEffect(() => {
    const handleReaderSelectionAction = (event: Event) => {
      const selectedType = Zotero.getMainWindow()?.Zotero_Tabs?.selectedType;
      const detail = (event as CustomEvent).detail as ReaderActionDetail;
      if (!isSidebarLocationSelected(`${selectedType || ""}`, location)) {
        debugLog.debug("sidebar.readerAction.ignored", {
          action: detail?.action,
          location,
          reason: "surface-mismatch",
          selectedType,
          surface: "sidebar",
          traceId: detail?.traceId,
        });
        return;
      }

      const prompt = buildReaderActionDraft(detail);
      const currentScope = mergeReaderActionScope(getCurrentScope(), detail);
      void (async () => {
        await syncSidebarScope(currentScope);
        setIncomingPrompt({
          id: detail.traceId || `reader-${Date.now()}`,
          label: detail.action === "explain" ? "Selection explain" : "Selection ask",
          prompt,
          sourceMode: "selection",
        });
        debugLog.info("sidebar.readerAction.webPrompt", {
          action: detail.action,
          messageChars: prompt.length,
          scopeId: currentScope?.id,
          scopeType: currentScope?.type,
          surface: "sidebar",
          traceId: detail.traceId,
        });
      })().catch((error) => {
        debugLog.error("sidebar.readerAction.error", error, {
          action: detail.action,
          surface: "sidebar",
          traceId: detail.traceId,
        });
        ztoolkit.log("Failed to handle reader selection action:", error);
      });
    };

    eventBus.addEventListener(
      "readerSelectionAction",
      handleReaderSelectionAction,
    );
    return () =>
      eventBus.removeEventListener(
        "readerSelectionAction",
        handleReaderSelectionAction,
      );
  }, [eventBus, location]);

  useEffect(() => {
    syncResolvedScope();

    if (location !== "reader") {
      return;
    }

    const retry = hostWindow.setTimeout(() => {
      syncResolvedScope();
    }, 150);

    return () => {
      hostWindow.clearTimeout(retry);
    };
  }, [hostWindow, location]);

  const handleRefreshScope = () => {
    syncResolvedScope();
    setSettings(getSettings());
    eventBus.dispatchEvent(createHostEvent("settingsChange", hostWindow));
  };

  return (
    <SidebarErrorBoundary>
      <div
        className="zotero-webai-shell"
        data-layout={settings.workspaceLayout}
        data-location={location}
        key={themeRefreshKey}
        style={{
          ...styles.container,
          background: theme.background,
          color: theme.text,
        }}
      >
        <header
          className="zotero-webai-shell-header"
          style={{
            ...styles.shellHeader,
            background: theme.surfaceBackground,
            borderColor: theme.softBorder,
          }}
        >
          <div style={styles.shellHeaderTop}>
            <div style={styles.shellTitleBlock}>
              <span style={{ ...styles.shellTitle, color: theme.text }}>
                Zotero WebAI
              </span>
              <span style={{ ...styles.shellMeta, color: theme.mutedText }}>
                {isZh ? "网页 AI 阅读工作区" : "Web AI reading workspace"}
              </span>
            </div>
            <span
              className="zotero-webai-shell-chip"
              style={{
                ...styles.shellBadge,
                background: theme.badgeBackground,
                borderColor: theme.badgeBorder,
                color: theme.badgeText,
              }}
              title={isZh ? "当前工作区布局" : "Current workspace layout"}
            >
              {formatLayoutBadge(settings.workspaceLayout, isZh)}
            </span>
          </div>
          <div
            className="zotero-webai-shell-scope"
            style={{
              ...styles.scopeCard,
              background: theme.panelBackground,
              borderColor: theme.softBorder,
            }}
          >
            <div style={styles.scopeMainLine}>
              <span style={{ ...styles.scopeEyebrow, color: theme.mutedText }}>
                {isZh ? "当前范围" : "Current Scope"}
              </span>
              <span style={{ ...styles.scopeSurface, color: theme.badgeText }}>
                {location === "reader"
                  ? isZh
                    ? "阅读器"
                    : "Reader"
                  : isZh
                    ? "条目栏"
                    : "Library"}
              </span>
            </div>
            <div style={{ ...styles.scopeTitle, color: theme.text }}>
              {scope?.label || (isZh ? "未选择条目" : "No item selected")}
            </div>
            <div style={{ ...styles.scopeMeta, color: theme.mutedText }}>
              {formatContextState(contextSummary, scope, isZh)}
            </div>
          </div>
        </header>
        <div
          className="zotero-webai-shell-body"
          style={{
            ...styles.webWorkspacePane,
            ...(settings.workspaceLayout === "compact"
              ? styles.compactWorkspacePane
              : {}),
          }}
        >
          <WebAIWorkspace
            contextSummary={contextSummary}
            customPresets={settings.customPresets}
            hostWindow={hostWindow}
            incomingPrompt={incomingPrompt}
            location={location}
            onIncomingPromptHandled={(id) => {
              setIncomingPrompt((current) =>
                current?.id === id ? null : current,
              );
            }}
            onScopeRefresh={handleRefreshScope}
            scope={scope}
            settings={settings}
          />
        </div>
      </div>
    </SidebarErrorBoundary>
  );
};

class SidebarErrorBoundary extends React.Component<
  { children: React.ReactNode },
  { message: string | null }
> {
  state = { message: null };

  static getDerivedStateFromError(error: unknown) {
    return {
      message:
        error instanceof Error && error.message
          ? error.message
          : "Unknown sidebar render failure",
    };
  }

  componentDidCatch(error: unknown) {
    debugLog.error("sidebar.render.error", error, {
      surface: "sidebar",
    });
  }

  render() {
    if (this.state.message) {
      return (
        <div style={styles.errorBoundary}>
          <div style={styles.errorBoundaryTitle}>
            Zotero WebAI sidebar unavailable
          </div>
          <div style={styles.errorBoundaryMessage}>{this.state.message}</div>
        </div>
      );
    }

    return this.props.children;
  }
}

function formatLayoutBadge(
  layout: Settings["workspaceLayout"],
  isZh = false,
): string {
  if (layout === "split") {
    return isZh ? "Split 分栏" : "Split";
  }
  if (layout === "compact") {
    return isZh ? "Compact 紧凑" : "Compact";
  }
  return isZh ? "Stacked 堆叠" : "Stacked";
}

function formatContextState(
  contextSummary: AssembledContext | null,
  scope: ScopeContext | null,
  isZh: boolean,
): string {
  if (!scope) {
    return isZh ? "等待 Zotero 当前条目或 PDF" : "Waiting for the current Zotero item or PDF";
  }
  if (!contextSummary) {
    return isZh ? `${formatScopeType(scope.type, isZh)} - 正在读取上下文` : `${formatScopeType(scope.type, isZh)} - reading context`;
  }

  const parts = [formatScopeType(scope.type, isZh)];
  if (contextSummary.fullText) {
    parts.push(
      isZh
        ? `全文 ${contextSummary.fullText.length.toLocaleString()} 字符`
        : `Full text ${contextSummary.fullText.length.toLocaleString()} chars`,
    );
  } else if (contextSummary.metadata) {
    parts.push(isZh ? "元数据可用" : "metadata ready");
  } else {
    parts.push(isZh ? "上下文待加载" : "context pending");
  }
  if (contextSummary.selectedText) {
    parts.push(
      isZh
        ? `选区 ${contextSummary.selectedText.length.toLocaleString()} 字符`
        : `selection ${contextSummary.selectedText.length.toLocaleString()} chars`,
    );
  }
  if (contextSummary.blockingMessage) {
    parts.push(isZh ? "需要检查全文" : "full text needs attention");
  }
  return parts.join(" - ");
}

function formatScopeType(type: ScopeContext["type"], isZh: boolean): string {
  if (type === "pdf") return isZh ? "PDF" : "PDF";
  if (type === "paper") return isZh ? "论文" : "Paper";
  if (type === "collection") return isZh ? "集合" : "Collection";
  return isZh ? "手动选择" : "Manual selection";
}

async function summarizeScope(
  scope: ScopeContext | null,
): Promise<AssembledContext | null> {
  if (!scope) {
    return null;
  }

  try {
    return await assembleContext(scope);
  } catch (error) {
    ztoolkit.log("Failed to summarize scope context:", error);
    return null;
  }
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    background: "#f7f7f7",
    boxSizing: "border-box",
    color: "#222",
    display: "flex",
    flexDirection: "column",
    height: "100%",
    maxWidth: "100%",
    minHeight: "0",
    minWidth: 0,
    overflowX: "hidden",
    width: "100%",
  },
  webWorkspacePane: {
    boxSizing: "border-box",
    display: "flex",
    flex: "1 1 auto",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    padding: 0,
  },
  compactWorkspacePane: {
    fontSize: "0.96em",
  },
  shellHeader: {
    alignItems: "stretch",
    borderBottom: "1px solid #e0e0e0",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    flex: "0 0 auto",
    gap: "8px",
    minWidth: 0,
    padding: "10px",
  },
  shellHeaderTop: {
    alignItems: "center",
    display: "flex",
    gap: "8px",
    justifyContent: "space-between",
    minWidth: 0,
  },
  shellTitleBlock: {
    display: "flex",
    flex: "1 1 auto",
    flexDirection: "column",
    gap: "2px",
    minWidth: 0,
  },
  shellTitle: {
    fontSize: typography.body,
    fontWeight: 800,
    lineHeight: 1.25,
  },
  shellMeta: {
    fontSize: typography.caption,
    lineHeight: 1.25,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  shellBadge: {
    border: "1px solid #d6e5f4",
    borderRadius: "999px",
    flex: "0 0 auto",
    fontSize: typography.caption,
    fontWeight: 700,
    lineHeight: 1.2,
    padding: "3px 8px",
    whiteSpace: "nowrap",
  },
  scopeCard: {
    border: "1px solid #e0e0e0",
    borderRadius: "8px",
    boxSizing: "border-box",
    display: "flex",
    flexDirection: "column",
    gap: "3px",
    minWidth: 0,
    padding: "8px 9px",
  },
  scopeMainLine: {
    alignItems: "center",
    display: "flex",
    gap: "6px",
    justifyContent: "space-between",
    minWidth: 0,
  },
  scopeEyebrow: {
    fontSize: typography.caption,
    fontWeight: 700,
    letterSpacing: 0,
    lineHeight: 1.2,
    textTransform: "uppercase",
  },
  scopeSurface: {
    fontSize: typography.caption,
    fontWeight: 700,
    lineHeight: 1.2,
    whiteSpace: "nowrap",
  },
  scopeTitle: {
    fontSize: typography.body,
    fontWeight: 700,
    lineHeight: 1.3,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  scopeMeta: {
    fontSize: typography.caption,
    lineHeight: 1.3,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  errorBoundary: {
    background: "#fbf1f1",
    boxSizing: "border-box",
    color: "#7f1d1d",
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    height: "100%",
    overflow: "auto",
    padding: "12px",
  },
  errorBoundaryTitle: {
    fontSize: typography.headingSm,
    fontWeight: 700,
    lineHeight: 1.3,
  },
  errorBoundaryMessage: {
    fontSize: typography.body,
    lineHeight: 1.45,
    overflowWrap: "anywhere",
  },
};
