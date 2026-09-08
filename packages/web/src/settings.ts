import { useCallback, useEffect, useState } from "react";

/**
 * Client-side preferences. Everything here belongs to the browser, not the
 * daemon: a preference is either about how this UI looks or about how it
 * behaves when the planner types. Session state stays where it already lives —
 * the daemon owns it.
 */

export type ThemeChoice = "system" | "dark" | "light";
export type ResolvedTheme = "dark" | "light";
/** Which keypress sends a message. The other one inserts a newline. */
export type SendKey = "enter" | "modEnter";

export interface Settings {
  theme: ThemeChoice;
  sendKey: SendKey;
  confirmBeforeDelete: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  // Dark, not "system", on purpose: the console palette is what this app has
  // always looked like, and a preference nobody set should not repaint it.
  theme: "dark",
  sendKey: "enter",
  confirmBeforeDelete: true,
};

export const THEMES: ThemeChoice[] = ["system", "dark", "light"];

const KEY = "agent-hub.settings";

function oneOf<T extends string>(allowed: readonly T[], value: unknown, fallback: T): T {
  return typeof value === "string" && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

/**
 * Read stored settings, field by field. Anything unrecognised falls back to its
 * default: a stored blob written by an older build, or hand-edited in devtools,
 * must not be able to leave the UI in a state it cannot render.
 */
export function loadSettings(): Settings {
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) ?? "null");
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (!raw || typeof raw !== "object") return DEFAULT_SETTINGS;
  const stored = raw as Record<string, unknown>;

  return {
    theme: oneOf(THEMES, stored.theme, DEFAULT_SETTINGS.theme),
    sendKey: oneOf(["enter", "modEnter"] as const, stored.sendKey, DEFAULT_SETTINGS.sendKey),
    confirmBeforeDelete:
      typeof stored.confirmBeforeDelete === "boolean"
        ? stored.confirmBeforeDelete
        : DEFAULT_SETTINGS.confirmBeforeDelete,
  };
}

const DARK_QUERY = "(prefers-color-scheme: dark)";

function systemTheme(): ResolvedTheme {
  const media = window.matchMedia?.(DARK_QUERY);
  // No matchMedia at all (an old embedded webview): keep the native palette.
  if (!media) return "dark";
  return media.matches ? "dark" : "light";
}

export function resolveTheme(choice: ThemeChoice): ResolvedTheme {
  return choice === "system" ? systemTheme() : choice;
}

/**
 * Paint the stored theme before React mounts. Without this a client set to
 * light renders one dark frame on every load, because the attribute would
 * otherwise land in an effect after the first paint.
 */
export function applyStoredTheme(): void {
  document.documentElement.dataset.theme = resolveTheme(loadSettings().theme);
}

/** Settings plus a patch function that persists. */
export function useSettings(): {
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
  theme: ResolvedTheme;
} {
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [theme, setTheme] = useState<ResolvedTheme>(() => resolveTheme(settings.theme));

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {
        // Private-browsing quotas can refuse the write. The choice still
        // applies to this tab, it just will not survive a reload.
      }
      return next;
    });
  }, []);

  // Follow the OS while the choice is "system", so switching appearance in
  // macOS or Windows moves the app without a reload.
  useEffect(() => {
    setTheme(resolveTheme(settings.theme));
    if (settings.theme !== "system") return;
    const media = window.matchMedia?.(DARK_QUERY);
    if (!media) return;
    const onChange = () => setTheme(systemTheme());
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, [settings.theme]);

  // The stylesheet keys its light palette off this attribute; `color-scheme`
  // comes along with it so form controls and scrollbars match.
  useEffect(() => {
    const root = document.documentElement;
    // Surfaces have a 120ms transition. Fading between two palettes leaves
    // inputs dark-text-on-dark for those frames, so a swap skips animation.
    const swapping = root.dataset.theme !== undefined && root.dataset.theme !== theme;
    if (swapping) root.classList.add("theme-swap");
    root.dataset.theme = theme;
    if (!swapping) return;
    const timer = setTimeout(() => root.classList.remove("theme-swap"), 50);
    return () => clearTimeout(timer);
  }, [theme]);

  return { settings, update, theme };
}
