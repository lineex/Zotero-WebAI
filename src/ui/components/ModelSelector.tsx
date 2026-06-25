import React, { useCallback, useEffect, useRef, useState } from "react";
import { getSidebarTheme, type SidebarTheme } from "../theme";
import { ANIMATION, TRANSITION, useAnimatedMount } from "../animations";

export interface ModelSelectorProps {
  hostWindow: Window;
  theme: SidebarTheme;
  isZh: boolean;
}

interface ServiceOption {
  id: string;
  label: string;
  status: "online" | "offline" | "loading";
}

const BUILTIN_SERVICES: ServiceOption[] = [
  { id: "deepseek-web", label: "DeepSeek Web", status: "online" },
  { id: "chatgpt-web", label: "ChatGPT Web", status: "online" },
  { id: "zai-web", label: "Z.ai Web", status: "online" },
  { id: "custom-web", label: "Custom Web AI", status: "loading" },
];

export const ModelSelector: React.FC<ModelSelectorProps> = ({
  hostWindow,
  theme,
  isZh,
}) => {
  const [isOpen, setIsOpen] = useState(false);
  const [selectedId, setSelectedId] = useState("deepseek-web");
  const [filter, setFilter] = useState("");
  const containerRef = useRef<HTMLDivElement>(null);
  const { mounted, style: animStyle } = useAnimatedMount(isOpen);

  const selected = BUILTIN_SERVICES.find((s) => s.id === selectedId) ||
    BUILTIN_SERVICES[0];

  const filtered = BUILTIN_SERVICES.filter((s) =>
    s.label.toLowerCase().includes(filter.toLowerCase()),
  );

  const handleSelect = useCallback((id: string) => {
    setSelectedId(id);
    setIsOpen(false);
    setFilter("");
  }, []);

  // Close on outside click
  useEffect(() => {
    if (!isOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setFilter("");
      }
    };
    hostWindow.document.addEventListener("mousedown", handleClick);
    return () => hostWindow.document.removeEventListener("mousedown", handleClick);
  }, [isOpen, hostWindow]);

  return (
    <div
      className="zotero-webai-model-selector"
      ref={containerRef}
      style={{ position: "relative", display: "inline-flex" }}
    >
      <button
        className="zotero-webai-model-selector-trigger"
        onClick={() => setIsOpen((v) => !v)}
        title={isZh ? "选择 AI 服务" : "Select AI Service"}
        style={{
          background: "transparent",
          border: `1px solid ${theme.modelSelectorBorder}`,
          borderRadius: 6,
          color: theme.text,
          cursor: "pointer",
          fontSize: 12,
          padding: "0 8px",
          height: 26,
          display: "inline-flex",
          alignItems: "center",
          gap: 4,
          transition: TRANSITION.fast,
        }}
      >
        <span
          className="zotero-webai-model-selector-dot"
          data-status={selected.status}
          style={{
            width: 6,
            height: 6,
            borderRadius: "50%",
            background: selected.status === "online"
              ? theme.modelOnlineIndicator
              : selected.status === "offline"
                ? theme.modelOfflineIndicator
                : "#f59e0b",
            animation: selected.status === "loading" ? ANIMATION.pulse : undefined,
          }}
        />
        <span style={{ maxWidth: 100, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {selected.label}
        </span>
        <svg width="10" height="10" viewBox="0 0 10 10" fill="currentColor" style={{ opacity: 0.5, flexShrink: 0 }}>
          <path d="M2.5 3.5L5 6.5L7.5 3.5" stroke="currentColor" strokeWidth="1.2" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {mounted && (
        <div
          className="zotero-webai-model-selector-dropdown"
          style={{
            ...animStyle,
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            background: theme.modelSelectorBackground,
            border: `1px solid ${theme.modelSelectorBorder}`,
            borderRadius: 10,
            boxShadow: theme.dropdownShadow,
            minWidth: 200,
            maxHeight: 280,
            overflow: "hidden",
            display: "flex",
            flexDirection: "column",
            zIndex: 100,
          }}
        >
          <input
            className="zotero-webai-model-selector-search"
            placeholder={isZh ? "搜索服务..." : "Search services..."}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            autoFocus
            style={{
              border: 0,
              borderBottom: `1px solid ${theme.divider}`,
              background: "transparent",
              color: theme.text,
              fontSize: 12,
              outline: 0,
              padding: "8px 10px",
              width: "100%",
            }}
          />
          <div
            className="zotero-webai-model-selector-list"
            style={{
              flex: "1 1 auto",
              overflowY: "auto",
              padding: 4,
              scrollbarWidth: "thin" as const,
            }}
          >
            {filtered.map((service) => (
              <div
                key={service.id}
                className="zotero-webai-model-selector-item"
                data-selected={service.id === selectedId ? "true" : undefined}
                onClick={() => handleSelect(service.id)}
                style={{
                  padding: "6px 8px",
                  borderRadius: 6,
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  transition: TRANSITION.fast,
                  background: service.id === selectedId
                    ? theme.selectionHighlight
                    : "transparent",
                  fontWeight: service.id === selectedId ? 600 : 400,
                  color: theme.text,
                }}
              >
                <span
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: "50%",
                    flexShrink: 0,
                    background: service.status === "online"
                      ? theme.modelOnlineIndicator
                      : service.status === "offline"
                        ? theme.modelOfflineIndicator
                        : "#f59e0b",
                  }}
                />
                {service.label}
              </div>
            ))}
            {filtered.length === 0 && (
              <div style={{ padding: "12px 8px", fontSize: 12, color: theme.mutedText, textAlign: "center" }}>
                {isZh ? "未找到匹配服务" : "No matching services"}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};
