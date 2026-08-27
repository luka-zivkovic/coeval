import { useEffect, useState } from "react";
import { displayModeFromStorage, type DisplayMode } from "@/lib/display-mode";

// Historical storage values now drive display density, not personas or roles:
//   pm   — Guided (default, action-capable, implementation details hidden)
//   dev  — Technical (same work surfaces plus .dev-only evidence)
//   exec — Summary (compact status navigation; never an authorization mode)

const STORAGE_KEY = "coeval.mode";
const DISPLAY_MODE_EVENT = "coeval:display-mode-change";

export function useMode(): [DisplayMode, (mode: DisplayMode) => void] {
  const [mode, setModeState] = useState<DisplayMode>(() => {
    if (typeof window === "undefined") return "pm";
    return displayModeFromStorage(window.localStorage.getItem(STORAGE_KEY));
  });

  useEffect(() => {
    document.documentElement.classList.toggle("dev", mode === "dev");
  }, [mode]);

  useEffect(() => {
    const syncMode = () => {
      setModeState(displayModeFromStorage(window.localStorage.getItem(STORAGE_KEY)));
    };
    window.addEventListener("storage", syncMode);
    window.addEventListener(DISPLAY_MODE_EVENT, syncMode);
    return () => {
      window.removeEventListener("storage", syncMode);
      window.removeEventListener(DISPLAY_MODE_EVENT, syncMode);
    };
  }, []);

  const setMode = (nextMode: DisplayMode) => {
    window.localStorage.setItem(STORAGE_KEY, nextMode);
    setModeState(nextMode);
    window.dispatchEvent(new Event(DISPLAY_MODE_EVENT));
  };

  return [mode, setMode];
}
