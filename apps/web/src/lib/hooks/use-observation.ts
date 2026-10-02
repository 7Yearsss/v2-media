import { useCallback, useEffect, useState } from "react";

export function useObservation() {
  const [visible, setVisible] = useState(() => document.visibilityState === "visible");
  const [online, setOnline] = useState(() => navigator.onLine);
  useEffect(() => {
    const visibility = () => setVisible(document.visibilityState === "visible");
    const connectivity = () => setOnline(navigator.onLine);
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", connectivity);
    window.addEventListener("offline", connectivity);
    return () => {
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", connectivity);
      window.removeEventListener("offline", connectivity);
    };
  }, []);
  const interval = useCallback((active: boolean, activeMs = 2000, idleMs: number | false = false, failures = 0): number | false => {
    if (!visible || !online) return false;
    const base = active ? activeMs : idleMs;
    return base === false ? false : Math.min(60_000, base * 2 ** Math.min(5, Math.max(0, failures)));
  }, [visible, online]);
  return { visible, online, interval };
}
