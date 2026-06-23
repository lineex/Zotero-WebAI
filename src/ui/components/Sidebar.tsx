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
        <div style={styles.webWorkspacePane}>
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
