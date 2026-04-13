"use client";

/**
 * Toast — lightweight notification system.
 *
 * Usage:
 *   const toast = useToast();
 *   toast.success("Deposit confirmed", "Shares minted at block 12345");
 *   toast.error("Tx rejected");
 *   toast.info("Switch network");
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

type ToastVariant = "success" | "error" | "info" | "neutral";

interface Toast {
  id: string;
  variant: ToastVariant;
  title: string;
  description?: string;
  durationMs: number;
}

interface ToastContextValue {
  show: (t: Omit<Toast, "id" | "durationMs"> & { durationMs?: number }) => string;
  dismiss: (id: string) => void;
  success: (title: string, description?: string) => string;
  error: (title: string, description?: string) => string;
  info: (title: string, description?: string) => string;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const timers = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
    const timer = timers.current.get(id);
    if (timer) {
      clearTimeout(timer);
      timers.current.delete(id);
    }
  }, []);

  const show = useCallback(
    ({
      variant,
      title,
      description,
      durationMs,
    }: Omit<Toast, "id" | "durationMs"> & { durationMs?: number }) => {
      const id = `t-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const duration = durationMs ?? 4000;
      setToasts((prev) => [...prev, { id, variant, title, description, durationMs: duration }]);
      if (duration > 0) {
        const timer = setTimeout(() => dismiss(id), duration);
        timers.current.set(id, timer);
      }
      return id;
    },
    [dismiss],
  );

  const value = useMemo<ToastContextValue>(
    () => ({
      show,
      dismiss,
      success: (title, description) => show({ variant: "success", title, description }),
      error: (title, description) => show({ variant: "error", title, description, durationMs: 6000 }),
      info: (title, description) => show({ variant: "info", title, description }),
    }),
    [show, dismiss],
  );

  // Cleanup all timers on unmount
  useEffect(() => {
    const timersRef = timers.current;
    return () => {
      timersRef.forEach((t) => clearTimeout(t));
      timersRef.clear();
    };
  }, []);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="sh-toast-viewport" role="region" aria-label="Notifications" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`sh-toast sh-toast--${t.variant}`} role="status">
            <span className="sh-toast__dot" aria-hidden="true" />
            <div className="sh-toast__body">
              <div className="sh-toast__title">{t.title}</div>
              {t.description && <div className="sh-toast__desc">{t.description}</div>}
            </div>
            <button
              type="button"
              className="sh-toast__close"
              onClick={() => dismiss(t.id)}
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}
