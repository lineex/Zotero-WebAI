import React, { useCallback } from "react";
import type { SidebarTheme } from "../theme";
import { TRANSITION } from "../animations";

export type SelectionContextMode = "selection-only" | "selection-plus-full";

export interface SelectionContextBarProps {
  selectedText: string;
  mode: SelectionContextMode;
  theme: SidebarTheme;
  isZh: boolean;
  onModeChange: (mode: SelectionContextMode) => void;
  onDismiss: () => void;
}

const CloseIcon: React.FC = () => (
  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <line x1="2" y1="2" x2="10" y2="10" />
    <line x1="10" y1="2" x2="2" y2="10" />
  </svg>
);

const SelectionIcon: React.FC = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17 10H3" />
    <path d="M21 6H3" />
    <path d="M21 14H3" />
    <path d="M17 18H3" />
  </svg>
);

export const SelectionContextBar: React.FC<SelectionContextBarProps> = ({
  selectedText,
  mode,
  theme,
  isZh,
  onModeChange,
  onDismiss,
}) => {
  const toggleMode = useCallback(() => {
    onModeChange(
      mode === "selection-only" ? "selection-plus-full" : "selection-only",
    );
  }, [mode, onModeChange]);

  const truncated =
    selectedText.length > 120
      ? selectedText.slice(0, 117) + "..."
      : selectedText;

  const modeLabel =
    mode === "selection-only"
      ? isZh
        ? "仅选区"
        : "Selection only"
      : isZh
        ? "选区 + 全文"
        : "Selection + full text";

  return (
    <div
      className="zotero-webai-context-bar"
      style={{
        alignItems: "center",
        animation: "webai-slide-up 250ms cubic-bezier(0.16, 1, 0.3, 1) both",
        background: theme.accentBackground,
        borderBottom: `1px solid ${theme.accentBorder}`,
        display: "flex",
        fontSize: 12,
        gap: 8,
        padding: "6px 12px",
      }}
    >
      <SelectionIcon />

      <div
        className="zotero-webai-context-bar-preview"
        style={{
          flex: "1 1 auto",
          overflow: "hidden",
          display: "-webkit-box",
          WebkitLineClamp: 2,
          WebkitBoxOrient: "vertical",
          fontStyle: "italic",
          color: theme.accentText,
          fontSize: 11,
          lineHeight: 1.4,
        }}
        title={selectedText}
      >
        {truncated}
      </div>

      <button
        className="zotero-webai-context-bar-mode"
        onClick={toggleMode}
        title={isZh ? "切换上下文模式" : "Toggle context mode"}
        style={{
          alignItems: "center",
          appearance: "none",
          background: "transparent",
          border: `1px solid ${theme.accentBorder}`,
          borderRadius: 6,
          color: theme.accentText,
          cursor: "pointer",
          display: "inline-flex",
          fontSize: 11,
          gap: 4,
          height: 24,
          padding: "0 8px",
          transition: TRANSITION.fast,
          whiteSpace: "nowrap",
        }}
      >
        {modeLabel}
      </button>

      <button
        className="zotero-webai-context-bar-close"
        onClick={onDismiss}
        title={isZh ? "关闭" : "Close"}
        aria-label="Close"
        style={{
          appearance: "none",
          background: "transparent",
          border: 0,
          color: theme.accentText,
          cursor: "pointer",
          display: "inline-flex",
          opacity: 0.5,
          padding: 2,
          transition: `opacity ${TRANSITION.fast}`,
        }}
      >
        <CloseIcon />
      </button>
    </div>
  );
};
