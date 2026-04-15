"use client";

/**
 * Modal — accessible dialog shell.
 * - Closes on Escape.
 * - Closes on backdrop click (opt-out via closeOnBackdrop={false}).
 * - Traps scroll on body while open.
 * - Returns focus to the element that opened it on close.
 */

import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: "md" | "lg";
  closeOnBackdrop?: boolean;
  /** Hide the X close button. Useful for flows where close is disallowed mid-tx. */
  hideClose?: boolean;
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
  closeOnBackdrop = true,
  hideClose = false,
}: ModalProps) {
  const previousFocus = useRef<HTMLElement | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previousFocus.current = document.activeElement as HTMLElement;
    const originalOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKey);

    // Focus the dialog for keyboard users
    dialogRef.current?.focus();

    return () => {
      document.body.style.overflow = originalOverflow;
      window.removeEventListener("keydown", handleKey);
      previousFocus.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;
  if (typeof window === "undefined") return null;

  return createPortal(
    <div
      className="sh-modal-overlay"
      role="presentation"
      onMouseDown={(e) => {
        if (closeOnBackdrop && e.target === e.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        tabIndex={-1}
        className={`sh-modal ${size === "lg" ? "sh-modal--lg" : ""}`}
      >
        {(title || !hideClose) && (
          <div className="sh-modal__header">
            <div className="sh-modal__title">{title}</div>
            {!hideClose && (
              <button
                type="button"
                className="sh-modal__close"
                onClick={onClose}
                aria-label="Close dialog"
              >
                ×
              </button>
            )}
          </div>
        )}
        <div className="sh-modal__body">{children}</div>
        {footer && <div className="sh-modal__footer">{footer}</div>}
      </div>
    </div>,
    document.body,
  );
}
