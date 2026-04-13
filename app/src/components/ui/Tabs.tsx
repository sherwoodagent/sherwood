"use client";

import { type ReactNode } from "react";

interface TabItem<T extends string> {
  id: T;
  label: ReactNode;
  count?: number;
  disabled?: boolean;
}

interface TabsProps<T extends string> {
  items: TabItem<T>[];
  active: T;
  onChange: (id: T) => void;
  ariaLabel?: string;
}

/** Controlled tab strip. ARIA-compliant role="tablist". */
export function Tabs<T extends string>({ items, active, onChange, ariaLabel }: TabsProps<T>) {
  return (
    <div role="tablist" aria-label={ariaLabel} className="sh-tabs">
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <button
            key={item.id}
            role="tab"
            type="button"
            aria-selected={isActive}
            aria-controls={`panel-${item.id}`}
            id={`tab-${item.id}`}
            tabIndex={isActive ? 0 : -1}
            disabled={item.disabled}
            className="sh-tab"
            onClick={() => !item.disabled && onChange(item.id)}
            onKeyDown={(e) => {
              if (e.key === "ArrowRight" || e.key === "ArrowLeft") {
                e.preventDefault();
                const dir = e.key === "ArrowRight" ? 1 : -1;
                const enabled = items.filter((i) => !i.disabled);
                const idx = enabled.findIndex((i) => i.id === active);
                const next = enabled[(idx + dir + enabled.length) % enabled.length];
                if (next) onChange(next.id);
              }
            }}
          >
            {item.label}
            {typeof item.count === "number" && (
              <span style={{ marginLeft: "0.5rem", opacity: 0.5 }}>{item.count}</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
