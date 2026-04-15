"use client";

/**
 * ProposalStepper — visualizes the proposal state machine so LPs can see
 * at a glance where a proposal is in its lifecycle.
 *
 *   Pending → Approved → Executed → Settled
 *   (Rejected / Cancelled short-circuit)
 */

import { ProposalState } from "@/lib/governor-data";

interface ProposalStepperProps {
  state: ProposalState;
  subLabel?: string;
}

const STEPS: { id: ProposalState; label: string }[] = [
  { id: ProposalState.Pending, label: "Voting" },
  { id: ProposalState.Approved, label: "Approved" },
  { id: ProposalState.Executed, label: "Executing" },
  { id: ProposalState.Settled, label: "Settled" },
];

export function ProposalStepper({ state, subLabel }: ProposalStepperProps) {
  const isTerminal = state === ProposalState.Rejected || state === ProposalState.Cancelled;

  // Short-circuit terminal path: show "Voting → Rejected/Cancelled"
  const steps = isTerminal
    ? [
        { id: ProposalState.Pending, label: "Voting" },
        {
          id: state,
          label: state === ProposalState.Rejected ? "Rejected" : "Cancelled",
        },
      ]
    : STEPS;

  const activeIdx = steps.findIndex((s) => s.id === state);

  const nodes: React.ReactNode[] = [];
  steps.forEach((step, i) => {
    const isDone = !isTerminal && activeIdx > i;
    const isActive = activeIdx === i;
    const isError = isTerminal && i === steps.length - 1;
    const cls = isError
      ? "sh-stepper__node sh-stepper__node--error"
      : isActive
        ? "sh-stepper__node sh-stepper__node--active"
        : isDone
          ? "sh-stepper__node sh-stepper__node--done"
          : "sh-stepper__node";
    nodes.push(
      <div key={`n-${step.id}-${i}`} className={cls}>
        <div className="sh-stepper__dot">{isDone ? "✓" : isError ? "×" : i + 1}</div>
        <div className="sh-stepper__label">{step.label}</div>
      </div>,
    );
    if (i < steps.length - 1) {
      nodes.push(
        <div
          key={`c-${i}`}
          className={`sh-stepper__connector ${isDone || isActive ? "sh-stepper__connector--done" : ""}`}
        />,
      );
    }
  });

  return (
    <div className="sh-stepper" aria-label="Proposal status">
      {nodes}
      {subLabel && <div className="sh-stepper__sub" style={{ marginLeft: "1rem" }}>{subLabel}</div>}
    </div>
  );
}
