"use client";

import { useState, type ReactNode } from "react";

interface FeatureCarouselProps {
  children: ReactNode[];
}

export default function FeatureCarousel({ children }: FeatureCarouselProps) {
  const [active, setActive] = useState(0);
  const total = children.length;

  function prev() {
    setActive((i) => (i === 0 ? total - 1 : i - 1));
  }

  function next() {
    setActive((i) => (i === total - 1 ? 0 : i + 1));
  }

  return (
    <div>
      {/* Cards container — show active card, with smooth transition */}
      <div style={{ position: "relative", overflow: "hidden" }}>
        <div
          style={{
            display: "flex",
            transition: "transform 0.4s ease",
            transform: `translateX(-${active * 100}%)`,
          }}
        >
          {children.map((child, i) => (
            <div
              key={i}
              style={{
                minWidth: "100%",
                flex: "0 0 100%",
                padding: "0 0.5rem",
                boxSizing: "border-box",
              }}
            >
              {child}
            </div>
          ))}
        </div>
      </div>

      {/* Navigation: arrows + dots */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: "1.5rem",
          marginTop: "2rem",
        }}
      >
        <button
          onClick={prev}
          aria-label="Previous"
          style={{
            background: "none",
            border: "1px solid rgba(255,255,255,0.15)",
            color: "rgba(255,255,255,0.5)",
            cursor: "pointer",
            width: "36px",
            height: "36px",
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "14px",
            transition: "border-color 0.2s, color 0.2s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "var(--color-accent)";
            e.currentTarget.style.color = "var(--color-accent)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)";
            e.currentTarget.style.color = "rgba(255,255,255,0.5)";
          }}
        >
          &larr;
        </button>

        <div style={{ display: "flex", gap: "0.5rem" }}>
          {children.map((_, i) => (
            <button
              key={i}
              onClick={() => setActive(i)}
              aria-label={`Go to slide ${i + 1}`}
              style={{
                width: i === active ? "24px" : "8px",
                height: "8px",
                borderRadius: "4px",
                border: "none",
                cursor: "pointer",
                transition: "all 0.3s ease",
                background:
                  i === active
                    ? "var(--color-accent)"
                    : "rgba(255,255,255,0.2)",
              }}
            />
          ))}
        </div>

        <button
          onClick={next}
          aria-label="Next"
          style={{
            background: "none",
            border: "1px solid rgba(255,255,255,0.15)",
            color: "rgba(255,255,255,0.5)",
            cursor: "pointer",
            width: "36px",
            height: "36px",
            borderRadius: "50%",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            fontSize: "14px",
            transition: "border-color 0.2s, color 0.2s",
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.borderColor = "var(--color-accent)";
            e.currentTarget.style.color = "var(--color-accent)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.borderColor = "rgba(255,255,255,0.15)";
            e.currentTarget.style.color = "rgba(255,255,255,0.5)";
          }}
        >
          &rarr;
        </button>
      </div>
    </div>
  );
}
