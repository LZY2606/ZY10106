import type { EntryValue, ObjectTree, ParseOptions } from "./types";

export type ChangeKind = "set" | "append" | "remove" | "clear";

export type ConflictCode =
  | "ambiguous-control"
  | "capability"
  | "disabled"
  | "no-control"
  | "shape"
  | "unsafe-path";

export interface PlanControlRef {
  id: string;
  adapter: string;
  kind:
    | "text"
    | "checkbox"
    | "radio"
    | "select-one"
    | "select-multiple"
    | "file"
    | "repeat-scalar"
    | "virtual"
    | "unknown";
  name: string;
  path: string;
  index?: number;
  disabled?: boolean;
  label?: string;
}

export interface ChangeItem {
  kind: ChangeKind;
  path: string;
  oldValue: EntryValue;
  newValue: EntryValue;
  lossless: boolean;
  controls: PlanControlRef[];
}

export interface ConflictItem {
  id: string;
  code: ConflictCode;
  path: string;
  message: string;
  oldValue: EntryValue;
  newValue: EntryValue;
  lossless: boolean;
  controls: PlanControlRef[];
}

export type PlanFingerprint = Record<string, string>;

export interface BaselineDiff {
  controlId: string;
  path: string;
  expected: string;
  actual: string;
  ref: PlanControlRef;
}

export interface ChangePlan {
  version: 1;
  delimiter: string;
  adapter: string;
  fingerprint: PlanFingerprint;
  changes: ChangeItem[];
  conflicts: ConflictItem[];
  status: "ready" | "applied" | "rejected";
}

export interface PlanTargetOptions extends ParseOptions {}

export type PlanApplyOutcome =
  | {
      status: "applied";
      plan: ChangePlan;
      changes: ChangeItem[];
      result: ObjectTree;
    }
  | {
      status: "rejected";
      reason: "conflicts" | "baseline-changed";
      plan: ChangePlan;
      conflicts?: ConflictItem[];
      baselineDiffs?: BaselineDiff[];
    };

export interface ValueCapability {
  representable: boolean;
  lossless: boolean;
  message?: string;
}

export interface PlanControl {
  id: string;
  ref: PlanControlRef;
  path: string;
  leafKind: "scalar" | "array";
  ordered?: boolean;
  disabled: boolean;
  readValue(): EntryValue;
  fingerprint(): string;
  canRepresent(value: EntryValue): ValueCapability;
  apply(item: ChangeItem): void;
}

export interface PlanAdapter {
  name: string;
  controls(): PlanControl[];
  canCreatePaths: boolean;
  applyChange?(change: ChangeItem): void;
  commit?(): ObjectTree | undefined;
  onApplied?(): void;
}

export interface CreateChangePlanOptions {
  delimiter?: string;
  allowUnsafePathSegments?: boolean;
  allowMissingControls?: boolean;
}
