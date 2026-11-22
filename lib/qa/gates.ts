// The qa_reports.gate values (initial schema check constraint) in pipeline order, with admin labels.
export const GATES = ["script", "pronunciation_prep", "audio", "technical", "visual", "human"] as const;
export type Gate = (typeof GATES)[number];

export const GATE_LABELS: Record<Gate | "customer", string> = {
  script: "Gate 1 · Script",
  pronunciation_prep: "Gate 2 · Pronunciation prep",
  audio: "Gate 3 · Audio",
  technical: "Gate 4 · Technical",
  visual: "Gate 5 · Visual",
  human: "Gate 6 · Human review",
  customer: "Customer review",
};

export const gateLabel = (gate: string) => GATE_LABELS[gate as Gate] ?? gate;
