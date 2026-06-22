import React, { useEffect, useRef, useState } from "react";
import { config } from "../../../package.json";
import {
  assembleContext,
  type AssembledContext,
} from "../../services/contextAssembler";
import { getCurrentScope } from "../../services/scopeResolver";
import {
  PREFERENCES_PANE_ID,
  getSettings,
  type Settings,
} from "../../services/settingsManager";
import type { ScopeContext } from "../../types/scope";
import { createHostEvent } from "../../utils/domEvents";
import { debugLog } from "../../utils/debugLog";
import { isChineseLocale } from "../../utils/locale";
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

const BRAND_ICON_SRC =
  `chrome://${config.addonRef}/content/icons/deepseek-favicon.png`;

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
  const zh = isChineseLocale();
  const theme = getSidebarTheme(hostWindow);

  const refreshContextSummary = async (nextScope: ScopeContext | null) => {
    const summary = await summarizeScope(nextScope);
    setContextSummary(summary);
  };

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

  const handleOpenSettings = () => {
    try {
      Zotero.Utilities.Internal.openPreferences(PREFERENCES_PANE_ID);
    } catch (error) {
      ztoolkit.log("Failed to open plugin preferences:", error);
    }
  };

  const handleRefreshScope = () => {
    syncResolvedScope();
    setSettings(getSettings());
    eventBus.dispatchEvent(createHostEvent("settingsChange", hostWindow));
  };

  const locationLabel =
    location === "reader" ? (zh ? "阅读器" : "Reader") : zh ? "文库" : "Library";
  const scopeLabel = scope?.label || (zh ? "未选择文献" : "No item selected");
  const scopeTypeLabel = scope ? getScopeTypeLabel(scope.type, zh) : locationLabel;
  const contextStatus = getContextStatus(contextSummary, zh);

  return (
    <SidebarErrorBoundary>
      <div
        key={themeRefreshKey}
        style={{
          ...styles.container,
          background: theme.background,
          color: theme.text,
        }}
      >
        <div
          style={{
            ...styles.header,
            background: theme.background,
            borderBottomColor: theme.border,
          }}
        >
          <div style={styles.headerMain}>
            <div style={styles.headerBrand}>
              <img alt="" src={BRAND_ICON_SRC} style={styles.headerBrandIcon} />
              <div style={{ ...styles.headerTitle, color: theme.text }}>
                Zotero-WebAI
              </div>
            </div>
            <div style={{ ...styles.headerMeta, color: theme.mutedText }}>
              {locationLabel} · DeepSeek Web / Z.ai Web
            </div>
          </div>
          <div style={styles.headerActions}>
            <button
              style={{
                ...styles.toolbarButton,
                color: theme.buttonText,
                borderColor: theme.buttonBorder,
              }}
              onClick={handleRefreshScope}
              type="button"
            >
              {zh ? "刷新" : "Refresh"}
            </button>
            <button
              style={{
                ...styles.toolbarButton,
                color: theme.buttonText,
                borderColor: theme.buttonBorder,
              }}
              onClick={handleOpenSettings}
              type="button"
            >
              {zh ? "设置" : "Settings"}
            </button>
          </div>
        </div>

        <div
          style={{
            ...styles.scopeSection,
            background: theme.background,
            borderBottomColor: theme.softBorder,
          }}
        >
          <div style={{ ...styles.sectionLabel, color: theme.mutedText }}>
            {zh ? "上下文" : "Context"}
          </div>
          <div style={styles.scopeHeaderRow}>
            <span style={{ ...styles.scopeType, color: theme.mutedText }}>
              {scopeTypeLabel}
            </span>
            <span
              style={{ ...styles.scopeLabel, color: theme.text }}
              title={scopeLabel}
            >
              {scopeLabel}
            </span>
          </div>
          <div style={styles.scopeMetaRow}>
            {scope?.selectedText && (
              <span
                style={{
                  ...styles.selectionBadge,
                  color: theme.badgeText,
                  background: theme.badgeBackground,
                  borderColor: theme.badgeBorder,
                }}
              >
                {zh ? "已包含划词" : "Selection included"}
              </span>
            )}
            {contextStatus && (
              <span
                style={{
                  ...styles.contextAvailabilityBadge,
                  color: theme.accentText,
                  background: theme.accentBackground,
                  borderColor: theme.accentBorder,
                }}
              >
                {contextStatus}
              </span>
            )}
          </div>
          {contextSummary?.warnings?.length ? (
            <div style={styles.contextWarningList}>
              {contextSummary.warnings.map((warning) => (
                <span
                  key={warning}
                  style={{
                    ...styles.contextWarningBadge,
                    color: theme.warningText,
                    background: theme.warningBackground,
                    borderColor: theme.warningBorder,
                  }}
                >
                  {warning}
                </span>
              ))}
            </div>
          ) : null}
        </div>

        <div style={styles.webWorkspacePane}>
          <WebAIWorkspace
            contextSummary={contextSummary}
            customPresets={settings.customPresets}
            hostWindow={hostWindow}
            incomingPrompt={incomingPrompt}
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
            Zotero-WebAI sidebar unavailable
          </div>
          <div style={styles.errorBoundaryMessage}>{this.state.message}</div>
        </div>
      );
    }

    return this.props.children;
  }
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

function getScopeTypeLabel(type: ScopeContext["type"], zh: boolean): string {
  const en: Record<ScopeContext["type"], string> = {
    collection: "Collection",
    "manual-selection": "Selection",
    paper: "Paper",
    pdf: "PDF",
  };
  const cn: Record<ScopeContext["type"], string> = {
    collection: "分类",
    "manual-selection": "选中内容",
    paper: "文献",
    pdf: "PDF",
  };
  return zh ? cn[type] : en[type];
}

function getContextStatus(
  contextSummary: AssembledContext | null,
  zh: boolean,
): string | null {
  if (!contextSummary) {
    return null;
  }
  switch (contextSummary.availability) {
    case "pdf-text-ready":
      return zh ? "PDF 正文可用" : "PDF text ready";
    case "abstract-only":
      return zh ? "摘要可用" : "Abstract available";
    case "metadata-only":
      return zh ? "元数据可用" : "Metadata available";
    case "collection-truncated":
      return zh ? "分类摘要" : "Collection summary";
    case "fulltext-required-error":
      return zh ? "全文暂不可用" : "Full text unavailable";
    case "fulltext-unsupported-scope":
      return zh ? "范围暂不支持全文" : "Scope unsupported";
    default:
      return zh ? "上下文可用" : "Context available";
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
  header: {
    alignItems: "center",
    background: "#f7f7f7",
    borderBottom: "1px solid #d7d7d7",
    display: "flex",
    flexDirection: "row",
    flexWrap: "wrap",
    gap: "8px",
    justifyContent: "space-between",
    padding: "8px 10px",
  },
  headerMain: {
    display: "flex",
    flex: "1 1 150px",
    flexDirection: "column",
    gap: "2px",
    minWidth: 0,
  },
  headerBrand: {
    alignItems: "center",
    display: "flex",
    gap: "6px",
    minWidth: 0,
  },
  headerBrandIcon: {
    display: "block",
    flexShrink: 0,
    height: "16px",
    width: "16px",
  },
  headerTitle: {
    color: "#222",
    fontSize: typography.headingSm,
    fontWeight: 600,
    lineHeight: 1.25,
    overflow: "hidden",
    overflowWrap: "anywhere",
    textOverflow: "ellipsis",
  },
  headerMeta: {
    color: "#666",
    fontSize: typography.caption,
    overflow: "hidden",
    overflowWrap: "anywhere",
    textOverflow: "ellipsis",
  },
  headerActions: {
    alignItems: "center",
    display: "flex",
    flex: "1 1 120px",
    flexWrap: "wrap",
    gap: "4px",
    justifyContent: "flex-end",
    minWidth: 0,
  },
  toolbarButton: {
    appearance: "none",
    background: "transparent",
    border: "1px solid #c9c9c9",
    borderRadius: "4px",
    color: "#333",
    cursor: "pointer",
    fontSize: typography.label,
    fontWeight: 500,
    padding: "3px 6px",
    whiteSpace: "nowrap",
  },
  scopeSection: {
    background: "#f7f7f7",
    borderBottom: "1px solid #e0e0e0",
    minWidth: 0,
    padding: "8px 10px",
  },
  sectionLabel: {
    color: "#7a7a7a",
    fontSize: typography.caption,
    fontWeight: 700,
    letterSpacing: "0.04em",
    marginBottom: "4px",
    textTransform: "uppercase",
  },
  scopeHeaderRow: {
    alignItems: "center",
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    minWidth: 0,
  },
  scopeType: {
    color: "#666",
    flexShrink: 0,
    fontSize: typography.label,
    fontWeight: 600,
    textTransform: "uppercase",
  },
  scopeLabel: {
    color: "#222",
    flex: 1,
    fontSize: typography.body,
    fontWeight: 600,
    minWidth: 0,
    overflow: "hidden",
    overflowWrap: "anywhere",
    textOverflow: "ellipsis",
  },
  scopeMetaRow: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    marginTop: "6px",
  },
  selectionBadge: {
    background: "#edf4fb",
    border: "1px solid #d6e5f4",
    borderRadius: "4px",
    color: "#2a5a86",
    fontSize: typography.label,
    fontWeight: 500,
    padding: "1px 6px",
  },
  contextAvailabilityBadge: {
    background: "#f7f1dc",
    border: "1px solid #e7dfc3",
    borderRadius: "4px",
    color: "#6d5a1f",
    fontSize: typography.label,
    fontWeight: 500,
    padding: "1px 6px",
  },
  contextWarningList: {
    display: "flex",
    flexDirection: "column",
    gap: "4px",
    marginTop: "6px",
    width: "100%",
  },
  contextWarningBadge: {
    background: "#f7f3e6",
    border: "1px solid #e5dcc0",
    borderRadius: "4px",
    color: "#7b5d17",
    fontSize: typography.meta,
    lineHeight: 1.4,
    overflowWrap: "anywhere",
    padding: "5px 6px",
  },
  webWorkspacePane: {
    boxSizing: "border-box",
    display: "flex",
    flex: "1 1 auto",
    minHeight: 0,
    minWidth: 0,
    overflow: "hidden",
    padding: "8px 10px 10px",
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
