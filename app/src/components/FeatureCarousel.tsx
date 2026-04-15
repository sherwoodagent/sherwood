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
      <div style={{ position: "relative", overflow: "hidden" }} aria-live="polite">
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

      {/* Navigation: square buttons + mono counter + progress hairline */}
      <div className="fc-nav">
        <button onClick={prev} aria-label="Previous slide" className="fc-btn">
          ←
        </button>

        <div className="fc-counter">
          <div className="fc-counter__digits">
            <span className="fc-counter__current">
              {String(active + 1).padStart(2, "0")}
            </span>{" "}
            / {String(total).padStart(2, "0")}
          </div>
          <div className="fc-counter__bar" aria-hidden>
            <div
              className="fc-counter__bar-fill"
              style={{ transform: `scaleX(${(active + 1) / total})` }}
            />
          </div>
        </div>

        <button onClick={next} aria-label="Next slide" className="fc-btn">
          →
        </button>
      </div>
    </div>
  );
}
