"use client";

import { forwardRef, useId, type InputHTMLAttributes, type ReactNode } from "react";

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  label?: string;
  hint?: string;
  error?: string;
  trailing?: ReactNode;
}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, hint, error, trailing, className = "", id, ...rest },
  ref,
) {
  // useId() gives a stable, SSR-safe id without impure Math.random
  const generatedId = useId();
  const reactId = id || generatedId;
  return (
    <label className="sh-field" htmlFor={reactId}>
      {label && <span className="sh-field__label">{label}</span>}
      <div style={{ position: "relative" }}>
        <input
          ref={ref}
          id={reactId}
          aria-invalid={!!error}
          aria-describedby={hint || error ? `${reactId}-hint` : undefined}
          className={`sh-input ${error ? "sh-input--error" : ""} ${className}`}
          style={trailing ? { paddingRight: "5rem" } : undefined}
          {...rest}
        />
        {trailing && (
          <div
            style={{
              position: "absolute",
              right: "0.75rem",
              top: "50%",
              transform: "translateY(-50%)",
              display: "flex",
              alignItems: "center",
              gap: "0.5rem",
            }}
          >
            {trailing}
          </div>
        )}
      </div>
      {(hint || error) && (
        <span
          id={`${reactId}-hint`}
          className={`sh-field__hint ${error ? "sh-field__hint--error" : ""}`}
        >
          {error || hint}
        </span>
      )}
    </label>
  );
});
