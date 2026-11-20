// What a scope decision is about. Which open items become scope decisions is the Plans' (core/decide-item.ts): an item is a
// candidate when its settled classification carries the "needs decision" flag, or basal and Haiku chose different scope labels
// (new feature, enhancement), and no decision or later stage covers it.
import type { DatabaseSync } from "node:sqlite";
import { type Settled } from "../classify/settled.ts";

export const SCOPE_LABELS = ["new feature", "enhancement"] as const;
export const isScope = (l: string | null): boolean => l !== null && (SCOPE_LABELS as readonly string[]).includes(l);

export type Reason = "needs-decision" | "scope-disagreement";

export type Candidate = { repo: string; number: number; reason: Reason; settled: Settled };

