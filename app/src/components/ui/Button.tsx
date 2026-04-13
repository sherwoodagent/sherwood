"use client";

/**
 * Button — unified button component.
 * Variants: primary, secondary, ghost, danger.
 * Sizes: sm, md, lg.
 * Supports loading spinner, left/right icon slots, and forwarded anchor rendering.
 */

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  loading?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
  fullWidth?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "primary",
    size = "md",
    loading = false,
    leftIcon,
    rightIcon,
    fullWidth = false,
    disabled,
    className = "",
    children,
    ...rest
  },
  ref,
) {
  const classes = [
    "sh-btn",
    `sh-btn--${variant}`,
    size === "sm" ? "sh-btn--sm" : size === "lg" ? "sh-btn--lg" : "",
    fullWidth ? "sh-btn--full" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    <button
      ref={ref}
      disabled={disabled || loading}
      className={classes}
      style={fullWidth ? { width: "100%" } : undefined}
      {...rest}
    >
      {loading ? <LoadingDots /> : leftIcon}
      <span>{children}</span>
      {!loading && rightIcon}
    </button>
  );
});

function LoadingDots() {
  return (
    <span
      aria-hidden="true"
      style={{
        display: "inline-flex",
        gap: "3px",
        alignItems: "center",
      }}
    >
      <span style={dotStyle(0)} />
      <span style={dotStyle(0.15)} />
      <span style={dotStyle(0.3)} />
    </span>
  );
}

function dotStyle(delay: number): React.CSSProperties {
  return {
    width: 4,
    height: 4,
    borderRadius: "50%",
    background: "currentColor",
    animation: `sh-dot-pulse 1s ease-in-out ${delay}s infinite`,
  };
}
