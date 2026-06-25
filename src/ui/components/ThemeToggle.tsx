import React, { useCallback } from "react";
import { type SidebarTheme, type ThemeMode } from "../theme";
import { TRANSITION } from "../animations";

export interface ThemeToggleProps {
  currentMode: ThemeMode;
  isDark: boolean;
  theme: SidebarTheme;
  isZh: boolean;
  onToggle: (mode: ThemeMode) => void;
}

const SunIcon: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="5" />
    <line x1="12" y1="1" x2="12" y2="3" />
    <line x1="12" y1="21" x2="12" y2="23" />
    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
    <line x1="1" y1="12" x2="3" y2="12" />
    <line x1="21" y1="12" x2="23" y2="12" />
    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
  </svg>
);

const MoonIcon: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
  </svg>
);

const AutoIcon: React.FC<{ size?: number }> = ({ size = 16 }) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinecap="round"
    strokeLinejoin="round"
  >
    <circle cx="12" cy="12" r="10" />
    <path d="M12 2a10 10 0 0 1 0 20" fill="currentColor" opacity="0.3" />
  </svg>
);

/**
 * Cycles through theme modes: auto → light → dark → auto.
 */
export const ThemeToggle: React.FC<ThemeToggleProps> = ({
  currentMode,
  isDark,
  theme,
  isZh,
  onToggle,
}) => {
  const handleClick = useCallback(() => {
    const cycle: ThemeMode[] = ["auto", "light", "dark"];
    const currentIndex = cycle.indexOf(currentMode);
    const nextMode = cycle[(currentIndex + 1) % cycle.length];
    onToggle(nextMode);
  }, [currentMode, onToggle]);

  const label =
    currentMode === "auto"
      ? isZh
        ? "自动主题"
        : "Auto theme"
      : currentMode === "light"
        ? isZh
          ? "浅色模式"
          : "Light mode"
        : isZh
          ? "深色模式"
          : "Dark mode";

  return (
    <button
      className="zotero-webai-theme-toggle"
      onClick={handleClick}
      title={label}
      aria-label={label}
      style={{
        alignItems: "center",
        appearance: "none",
        background: "transparent",
        border: 0,
        borderRadius: 6,
        color: theme.mutedText,
        cursor: "pointer",
        display: "inline-flex",
        height: 26,
        justifyContent: "center",
        padding: 0,
        transition: TRANSITION.fast,
        width: 26,
      }}
    >
      {currentMode === "auto" ? (
        <AutoIcon />
      ) : currentMode === "light" ? (
        <SunIcon />
      ) : (
        <MoonIcon />
      )}
    </button>
  );
};
