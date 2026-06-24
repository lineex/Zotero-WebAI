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
        key={themeRefreshKey}
        style={{
          ...styles.container,
          background: theme.background,
          color: theme.text,
        }}
      >
        <header
          style={{
            ...styles.shellHeader,
            background: theme.surfaceBackground,
            borderColor: theme.softBorder,
          }}
        >
          <div style={styles.shellTitleBlock}>
            <span style={{ ...styles.shellTitle, color: theme.text }}>
              Zotero WebAI
            </span>
            <span style={{ ...styles.shellMeta, color: theme.mutedText }}>
              {formatSidebarScope(location, scope)}
            </span>
          </div>
          <span
            style={{
              ...styles.shellBadge,
              background: theme.badgeBackground,
              borderColor: theme.badgeBorder,
              color: theme.badgeText,
            }}
          >
            {formatLayoutBadge(settings.workspaceLayout)}
          </span>
        </header>
        <div
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

function formatSidebarScope(
  location: "library" | "reader",
  scope: ScopeContext | null,
): string {
  const surface = location === "reader" ? "Reader" : "Library";
  if (!scope?.label) {
    return surface;
  }
  return `${surface} - ${scope.label}`;
}

function formatLayoutBadge(layout: Settings["workspaceLayout"]): string {
  if (layout === "split") {
    return "Split";
  }
  if (layout === "compact") {
    return "Compact";
  }
  return "Stacked";
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
    alignItems: "center",
    borderBottom: "1px solid #e0e0e0",
    boxSizing: "border-box",
    display: "flex",
    flex: "0 0 auto",
    gap: "8px",
    justifyContent: "space-between",
    minHeight: "44px",
    minWidth: 0,
    padding: "8px 10px",
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
