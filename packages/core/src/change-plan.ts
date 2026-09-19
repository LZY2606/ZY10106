import { entriesToObject, objectToEntries, type Entry, type EntryValue } from "./index";

export type ChangePlanOperation = "set" | "append" | "remove" | "clear" | "conflict";

export const CHANGE_CONFLICT_CODES = {
  unsafePath: "F2J-C001",
  typeMismatch: "F2J-C002",
  notExpressible: "F2J-C003",
  duplicatePath: "F2J-C004",
  unmappedControl: "F2J-C005"
} as const;

export type ChangeConflictCode = (typeof CHANGE_CONFLICT_CODES)[keyof typeof CHANGE_CONFLICT_CODES];

export interface ChangePlanItem {
  id: string;
  op: ChangePlanOperation;
  path: string;
  oldValue: EntryValue;
  newValue: EntryValue;
  lossless: boolean;
  controls: string[];
  conflictCode?: ChangeConflictCode;
  reason?: string;
}

export interface ChangePlan {
  id: string;
  baseline: string;
  items: ChangePlanItem[];
  conflicts: ChangePlanItem[];
  controlSnapshot: Record<string, string>;
}

export interface ChangePlanSource {
  readonly kind: string;
  readonly identity?: string;
  readEntries(): Entry[];
  fingerprint(): string;
  snapshotControls(): Record<string, string>;
  controlsForPath(path: string): string[];
  canExpress(path: string, value: EntryValue): boolean;
  applyItems(items: ChangePlanItem[]): void;
}

export interface PlanChangesOptions {
  delimiter?: string;
  prune?: boolean;
}

export interface BaselineDifference {
  control: string;
  expected: string;
  actual: string;
}

export interface ApplyChangePlanResult {
  status: "applied" | "rejected";
  planId: string;
  reason?: string;
  appliedItems: ChangePlanItem[];
  conflicts: ChangePlanItem[];
  baselineDiff: BaselineDifference[];
}

const UNSAFE_PATH_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);
const PATH_TOKEN_REGEXP = /[a-zA-Z_][a-zA-Z0-9_]*/g;
const PATH_SEGMENT_REGEXP = /[^.[\]]+|\[\d+\]/g;
const ARRAY_INDEX_SEGMENT_REGEXP = /^\[(\d+)\]$/;

const OPERATION_ORDER: Record<ChangePlanOperation, number> = {
  set: 0,
  append: 1,
  remove: 2,
  clear: 3,
  conflict: 4
};

interface RawPlanItem {
  op: ChangePlanOperation;
  path: string;
  oldValue: unknown;
  newValue: unknown;
  conflictCode?: ChangeConflictCode;
  reason?: string;
}

interface DiffOptions {
  prune: boolean;
  duplicatedPaths: ReadonlySet<string>;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  return Object.prototype.toString.call(value) === "[object Object]";
}

interface FileLikeValue {
  name: string;
  size: number;
  lastModified?: number;
  arrayBuffer?: unknown;
}

function isFileLike(value: unknown): value is FileLikeValue {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as FileLikeValue).name === "string" &&
    typeof (value as FileLikeValue).size === "number" &&
    (typeof (value as FileLikeValue).arrayBuffer === "function" ||
      typeof (value as { type?: unknown }).type === "string")
  );
}

function canonicalSerialize(value: unknown): string {
  if (value === null) {
    return "null";
  }

  switch (typeof value) {
    case "undefined":
      return "undefined";
    case "string":
      return `s:${JSON.stringify(value)}`;
    case "number":
      return `n:${Number.isNaN(value) ? "NaN" : String(value)}`;
    case "boolean":
      return `b:${String(value)}`;
    case "function":
      return "f:[function]";
    case "symbol":
      return `y:${String(value)}`;
    case "bigint":
      return `g:${String(value)}`;
    default:
      break;
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalSerialize(item)).join(",")}]`;
  }

  const tag = Object.prototype.toString.call(value);

  if (tag === "[object Date]") {
    return `d:${(value as Date).getTime()}`;
  }

  if (isFileLike(value)) {
    return `file:${value.name}:${value.size}:${value.lastModified ?? 0}`;
  }

  if (!isPlainObject(value)) {
    return `x:${tag}`;
  }

  const keys = Object.keys(value).sort();
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${canonicalSerialize(value[key])}`)
    .join(",");

  return `{${body}}`;
}

function fnv1a(input: string): string {
  let hash = 0x811c9dc5;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function fingerprintValue(value: unknown): string {
  return `f2j_${fnv1a(canonicalSerialize(value))}`;
}

export function findUnsafePathSegment(path: string): string | null {
  const tokens = path.match(PATH_TOKEN_REGEXP);

  if (!tokens) {
    return null;
  }

  for (const token of tokens) {
    if (UNSAFE_PATH_SEGMENTS.has(token)) {
      return token;
    }
  }

  return null;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  return canonicalSerialize(left) === canonicalSerialize(right);
}

function joinPath(base: string, key: string): string {
  return base === "" ? key : `${base}.${key}`;
}

function joinIndex(base: string, index: number): string {
  return `${base}[${index}]`;
}

function isContainer(value: unknown): boolean {
  return (isPlainObject(value) && !isFileLike(value)) || Array.isArray(value);
}

function isDiffableObject(value: unknown): value is Record<string, unknown> {
  return isPlainObject(value) && !isFileLike(value);
}

function emitItem(items: RawPlanItem[], item: RawPlanItem, options: DiffOptions): void {
  const unsafeSegment = findUnsafePathSegment(item.path);

  if (unsafeSegment) {
    items.push({
      op: "conflict",
      path: item.path,
      oldValue: item.oldValue,
      newValue: item.newValue,
      conflictCode: CHANGE_CONFLICT_CODES.unsafePath,
      reason: `Unsafe path segment "${unsafeSegment}" is never applied.`
    });
    return;
  }

  if (options.duplicatedPaths.has(item.path)) {
    items.push({
      op: "conflict",
      path: item.path,
      oldValue: item.oldValue,
      newValue: item.newValue,
      conflictCode: CHANGE_CONFLICT_CODES.duplicatePath,
      reason: `Path "${item.path}" is produced by more than one target key.`
    });
    return;
  }

  items.push(item);
}

function diffTrees(current: unknown, target: unknown, path: string, items: RawPlanItem[], options: DiffOptions): void {
  if (target === undefined) {
    return;
  }

  if (current === undefined) {
    if (isDiffableObject(target)) {
      for (const key of Object.keys(target)) {
        diffTrees(undefined, target[key], joinPath(path, key), items, options);
      }
      return;
    }

    if (Array.isArray(target)) {
      for (let index = 0; index < target.length; index += 1) {
        if (target[index] === undefined) {
          continue;
        }

        emitItem(items, {
          op: "append",
          path: joinIndex(path, index),
          oldValue: undefined,
          newValue: target[index]
        }, options);
      }
      return;
    }

    if (target === "" || target === null) {
      return;
    }

    emitItem(items, { op: "set", path, oldValue: undefined, newValue: target }, options);
    return;
  }

  if (isDiffableObject(current) && isDiffableObject(target)) {
    for (const key of Object.keys(target)) {
      diffTrees(current[key], target[key], joinPath(path, key), items, options);
    }

    if (options.prune) {
      for (const key of Object.keys(current)) {
        if (!Object.prototype.hasOwnProperty.call(target, key)) {
          emitItem(items, {
            op: "remove",
            path: joinPath(path, key),
            oldValue: current[key],
            newValue: undefined
          }, options);
        }
      }
    }

    return;
  }

  if (Array.isArray(current) && Array.isArray(target)) {
    const sharedLength = Math.min(current.length, target.length);

    for (let index = 0; index < sharedLength; index += 1) {
      diffTrees(current[index], target[index], joinIndex(path, index), items, options);
    }

    for (let index = sharedLength; index < target.length; index += 1) {
      if (target[index] === undefined) {
        continue;
      }

      emitItem(items, {
        op: "append",
        path: joinIndex(path, index),
        oldValue: undefined,
        newValue: target[index]
      }, options);
    }

    for (let index = sharedLength; index < current.length; index += 1) {
      emitItem(items, {
        op: "remove",
        path: joinIndex(path, index),
        oldValue: current[index],
        newValue: undefined
      }, options);
    }

    return;
  }

  if (isContainer(current) || isContainer(target)) {
    emitItem(items, {
      op: "conflict",
      path,
      oldValue: current,
      newValue: target,
      conflictCode: CHANGE_CONFLICT_CODES.typeMismatch,
      reason: "Current and target values disagree on container shape."
    }, options);
    return;
  }

  if (valuesEqual(current, target)) {
    return;
  }

  if (target === "" || target === null) {
    emitItem(items, { op: "clear", path, oldValue: current, newValue: target }, options);
    return;
  }

  emitItem(items, { op: "set", path, oldValue: current, newValue: target }, options);
}

function findDuplicatedLeafPaths(target: unknown): Set<string> {
  const seen = new Set<string>();
  const duplicated = new Set<string>();

  for (const entry of objectToEntries(target)) {
    if (seen.has(entry.key)) {
      duplicated.add(entry.key);
    } else {
      seen.add(entry.key);
    }
  }

  return duplicated;
}

function tokenizePath(path: string): (string | number)[] {
  const tokens = path.match(PATH_SEGMENT_REGEXP) ?? [];

  return tokens.map((token) => {
    const indexMatch = ARRAY_INDEX_SEGMENT_REGEXP.exec(token);
    return indexMatch ? Number(indexMatch[1]) : token;
  });
}

function comparePaths(left: string, right: string): number {
  const leftTokens = tokenizePath(left);
  const rightTokens = tokenizePath(right);
  const sharedLength = Math.min(leftTokens.length, rightTokens.length);

  for (let index = 0; index < sharedLength; index += 1) {
    const leftToken = leftTokens[index];
    const rightToken = rightTokens[index];

    if (leftToken === rightToken) {
      continue;
    }

    if (typeof leftToken === "number" && typeof rightToken === "number") {
      return leftToken - rightToken;
    }

    return String(leftToken) < String(rightToken) ? -1 : 1;
  }

  return leftTokens.length - rightTokens.length;
}

function compareRawItems(left: RawPlanItem, right: RawPlanItem): number {
  const pathOrder = comparePaths(left.path, right.path);

  if (pathOrder !== 0) {
    return pathOrder;
  }

  return OPERATION_ORDER[left.op] - OPERATION_ORDER[right.op];
}

function isJsonExpressible(value: unknown): boolean {
  if (value === null) {
    return true;
  }

  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "undefined":
      return true;
    case "object":
      break;
    default:
      return false;
  }

  if (Array.isArray(value)) {
    return value.every((item) => isJsonExpressible(item));
  }

  if (!isPlainObject(value)) {
    return false;
  }

  return Object.keys(value).every((key) => isJsonExpressible(value[key]));
}

function formatItemId(sequence: number): string {
  return `F2J-OP-${String(sequence).padStart(4, "0")}`;
}

function finalizePlan(
  rawItems: RawPlanItem[],
  baseline: string,
  controlSnapshot: Record<string, string>,
  source?: ChangePlanSource
): ChangePlan {
  const sortedItems = [...rawItems].sort(compareRawItems);
  const items: ChangePlanItem[] = [];

  for (let index = 0; index < sortedItems.length; index += 1) {
    const rawItem = sortedItems[index] as RawPlanItem;
    const item: ChangePlanItem = {
      id: formatItemId(index + 1),
      op: rawItem.op,
      path: rawItem.path,
      oldValue: rawItem.oldValue,
      newValue: rawItem.newValue,
      lossless: true,
      controls: []
    };

    if (rawItem.conflictCode !== undefined) {
      item.conflictCode = rawItem.conflictCode;
    }

    if (rawItem.reason !== undefined) {
      item.reason = rawItem.reason;
    }

    if (source && item.op !== "conflict") {
      item.controls = source.controlsForPath(item.path);
      item.lossless = source.canExpress(
        item.path,
        item.op === "remove" ? item.oldValue : item.newValue
      );

      if (!item.lossless) {
        item.op = "conflict";
        item.conflictCode = CHANGE_CONFLICT_CODES.notExpressible;
        item.reason = `Source "${source.kind}" cannot losslessly express the value at "${item.path}".`;
      } else if (item.controls.length === 0) {
        item.op = "conflict";
        item.conflictCode = CHANGE_CONFLICT_CODES.unmappedControl;
        item.reason = `Source "${source.kind}" has no control bound to "${item.path}".`;
      }
    } else if (!source) {
      item.lossless = item.op === "remove" || item.op === "clear" || isJsonExpressible(item.newValue);
    }

    items.push(item);
  }

  const conflicts = items.filter((item) => item.op === "conflict");
  const id = `plan_${fnv1a(
    canonicalSerialize({
      baseline,
      items: items.map((item) => ({
        op: item.op,
        path: item.path,
        oldValue: item.oldValue,
        newValue: item.newValue,
        conflictCode: item.conflictCode ?? null
      }))
    })
  )}`;

  return { id, baseline, items, conflicts, controlSnapshot };
}

export function planChanges(current: unknown, target: unknown, options: PlanChangesOptions = {}): ChangePlan {
  const rawItems: RawPlanItem[] = [];
  const diffOptions: DiffOptions = {
    prune: options.prune ?? false,
    duplicatedPaths: findDuplicatedLeafPaths(target)
  };

  diffTrees(current, target, "", rawItems, diffOptions);

  return finalizePlan(rawItems, fingerprintValue(current), {});
}

export function createChangePlan(
  source: ChangePlanSource,
  target: unknown,
  options: PlanChangesOptions = {}
): ChangePlan {
  const current = entriesToObject(source.readEntries(), {
    delimiter: options.delimiter ?? ".",
    skipEmpty: false,
    allowUnsafePathSegments: true
  });
  const rawItems: RawPlanItem[] = [];
  const diffOptions: DiffOptions = {
    prune: options.prune ?? false,
    duplicatedPaths: findDuplicatedLeafPaths(target)
  };

  diffTrees(current, target, "", rawItems, diffOptions);

  return finalizePlan(rawItems, source.fingerprint(), source.snapshotControls(), source);
}

function computeBaselineDiff(
  expected: Record<string, string>,
  actual: Record<string, string>
): BaselineDifference[] {
  const differences: BaselineDifference[] = [];
  const controls = new Set([...Object.keys(expected), ...Object.keys(actual)]);

  for (const control of controls) {
    const expectedValue = Object.prototype.hasOwnProperty.call(expected, control)
      ? expected[control]
      : "<missing>";
    const actualValue = Object.prototype.hasOwnProperty.call(actual, control)
      ? actual[control]
      : "<missing>";

    if (expectedValue !== actualValue) {
      differences.push({
        control,
        expected: expectedValue ?? "<missing>",
        actual: actualValue ?? "<missing>"
      });
    }
  }

  return differences.sort((left, right) => comparePaths(left.control, right.control));
}

const sourceIdentityMap = new WeakMap<object, number>();
let nextSourceIdentity = 0;

export function sourceIdentityFor(anchor: object): string {
  let identity = sourceIdentityMap.get(anchor);

  if (identity === undefined) {
    nextSourceIdentity += 1;
    identity = nextSourceIdentity;
    sourceIdentityMap.set(anchor, identity);
  }

  return `src_${identity}`;
}

const appliedPlanResults = new Map<string, ApplyChangePlanResult>();

export function applyChangePlan(source: ChangePlanSource, plan: ChangePlan): ApplyChangePlanResult {
  const cacheKey = `${source.kind}:${source.identity ?? sourceIdentityFor(source)}:${plan.id}`;
  const cachedResult = appliedPlanResults.get(cacheKey);

  if (cachedResult) {
    return cachedResult;
  }

  if (plan.conflicts.length > 0) {
    return {
      status: "rejected",
      planId: plan.id,
      reason: "unresolved-conflicts",
      appliedItems: [],
      conflicts: plan.conflicts,
      baselineDiff: []
    };
  }

  if (source.fingerprint() !== plan.baseline) {
    return {
      status: "rejected",
      planId: plan.id,
      reason: "baseline-mismatch",
      appliedItems: [],
      conflicts: [],
      baselineDiff: computeBaselineDiff(plan.controlSnapshot, source.snapshotControls())
    };
  }

  source.applyItems(plan.items);

  const result: ApplyChangePlanResult = {
    status: "applied",
    planId: plan.id,
    appliedItems: plan.items,
    conflicts: [],
    baselineDiff: []
  };

  appliedPlanResults.set(cacheKey, result);

  return result;
}
