"use client";

import { useState, useEffect, useRef, useCallback } from "react";

type LineType = "command" | "label" | "separator" | "output" | "success" | "dim" | "blank";

interface ScriptLine {
  type: LineType;
  text: string;
  delay: number; // ms to wait before showing this line
}

const SCENE_1: ScriptLine[] = [
  { type: "command", text: "$ sherwood syndicate create", delay: 0 },
  { type: "blank", text: "", delay: 600 },
  { type: "label", text: "  ◆ Create Syndicate", delay: 100 },
  { type: "separator", text: "─".repeat(52), delay: 50 },
  { type: "dim", text: "  Wallet:  0x7a3b...f29d", delay: 80 },
  { type: "dim", text: "  Network: Base", delay: 80 },
  { type: "separator", text: "─".repeat(52), delay: 50 },
  { type: "blank", text: "", delay: 400 },
  { type: "dim", text: "  Uploading metadata to IPFS...", delay: 600 },
  { type: "success", text: "  ✓ Metadata pinned", delay: 300 },
  { type: "dim", text: "  Deploying vault via factory...", delay: 800 },
  { type: "blank", text: "", delay: 200 },
  { type: "label", text: "  ◆ Syndicate Created", delay: 100 },
  { type: "separator", text: "─".repeat(52), delay: 50 },
  { type: "output", text: "  ID:       #4", delay: 80 },
  { type: "output", text: "  Vault:    0x9f2c...71aE", delay: 80 },
  { type: "output", text: "  ENS:      levered-swap.sherwoodagent.eth", delay: 80 },
  { type: "output", text: "  Chat:     sherwood chat levered-swap", delay: 80 },
  { type: "separator", text: "─".repeat(52), delay: 50 },
  { type: "success", text: "  ✓ Vault saved to ~/.sherwood/config.json", delay: 100 },
];

const SCENE_2: ScriptLine[] = [
  { type: "command", text: "$ sherwood strategy propose --template moonwell-supply", delay: 0 },
  { type: "blank", text: "", delay: 600 },
  { type: "dim", text: "  Cloning MoonwellSupply template...", delay: 500 },
  { type: "success", text: "  ✓ Cloned: 0x4e8a...b3c2", delay: 200 },
  { type: "dim", text: "  Initializing strategy...", delay: 500 },
  { type: "success", text: "  ✓ Initialized", delay: 200 },
  { type: "blank", text: "", delay: 300 },
  { type: "label", text: "  ◆ Proposal Summary", delay: 100 },
  { type: "separator", text: "─".repeat(52), delay: 50 },
  { type: "output", text: "  Name:             Supply USDC to Moonwell", delay: 80 },
  { type: "output", text: "  Performance Fee:  10%", delay: 80 },
  { type: "output", text: "  Duration:         7 days", delay: 80 },
  { type: "output", text: "  Calls:            2 execute + 2 settle", delay: 80 },
  { type: "separator", text: "─".repeat(52), delay: 50 },
  { type: "blank", text: "", delay: 300 },
  { type: "dim", text: "  Submitting proposal...", delay: 700 },
  { type: "success", text: "  ✓ Proposal #7 created", delay: 200 },
  { type: "dim", text: "  Tx: basescan.org/tx/0x8b1f...e4a9", delay: 80 },
];

const SCENES = [SCENE_1, SCENE_2];
const PAUSE_BETWEEN_SCENES = 3000;
const TYPING_SPEED = 35; // ms per character for command lines

export default function TerminalDemo() {
  const [visibleLines, setVisibleLines] = useState<ScriptLine[]>([]);
  const [typingText, setTypingText] = useState("");
  const [isTyping, setIsTyping] = useState(false);
  const [sceneIndex, setSceneIndex] = useState(0);
  const timersRef = useRef<NodeJS.Timeout[]>([]);
  const containerRef = useRef<HTMLDivElement>(null);

  const clearTimers = useCallback(() => {
    timersRef.current.forEach(clearTimeout);
    timersRef.current = [];
  }, []);

  const scrollToBottom = useCallback(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, []);

  useEffect(() => {
    const scene = SCENES[sceneIndex];
    let cumulativeDelay = 0;

    setVisibleLines([]);
    setTypingText("");
    setIsTyping(false);
    clearTimers();

    scene.forEach((line, i) => {
      cumulativeDelay += line.delay;

      if (line.type === "command") {
        // Type out command character by character
        const chars = line.text;
        const startDelay = cumulativeDelay;

        const typingStart = setTimeout(() => {
          setIsTyping(true);
          setTypingText("");
        }, startDelay);
        timersRef.current.push(typingStart);

        for (let c = 0; c <= chars.length; c++) {
          const charTimer = setTimeout(() => {
            setTypingText(chars.slice(0, c));
            scrollToBottom();
          }, startDelay + c * TYPING_SPEED);
          timersRef.current.push(charTimer);
        }

        const typingDuration = chars.length * TYPING_SPEED;
        cumulativeDelay += typingDuration;

        const finishTyping = setTimeout(() => {
          setIsTyping(false);
          setVisibleLines((prev) => [...prev, line]);
          setTypingText("");
          scrollToBottom();
        }, startDelay + typingDuration + 100);
        timersRef.current.push(finishTyping);
        cumulativeDelay += 100;
      } else {
        const timer = setTimeout(() => {
          setVisibleLines((prev) => [...prev, line]);
          scrollToBottom();
        }, cumulativeDelay);
        timersRef.current.push(timer);
      }
    });

    // After scene completes, pause then move to next scene
    cumulativeDelay += PAUSE_BETWEEN_SCENES;
    const nextScene = setTimeout(() => {
      setSceneIndex((prev) => (prev + 1) % SCENES.length);
    }, cumulativeDelay);
    timersRef.current.push(nextScene);

    return clearTimers;
  }, [sceneIndex, clearTimers, scrollToBottom]);

  return (
    <div className="terminal-demo" style={{ isolation: "isolate" }}>
      <div className="terminal-titlebar">
        <div className="terminal-dots">
          <span className="terminal-dot terminal-dot--red" />
          <span className="terminal-dot terminal-dot--yellow" />
          <span className="terminal-dot terminal-dot--green" />
        </div>
        <span className="terminal-title">sherwood</span>
      </div>
      <div className="terminal-body" ref={containerRef}>
        {visibleLines.map((line, i) => (
          <div key={i} className={`terminal-line terminal-line--${line.type}`}>
            {line.text}
          </div>
        ))}
        {isTyping && (
          <div className="terminal-line terminal-line--command">
            {typingText}
            <span className="terminal-cursor" />
          </div>
        )}
      </div>
    </div>
  );
}
