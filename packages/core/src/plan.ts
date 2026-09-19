import {
  formatCanonicalPath,
  parseCanonicalPath,
  type PathSegment
} from "./canonical";
import type { EntryValue, ObjectTree } from "./types";
import type {
  BaselineDiff,
  ChangeItem,
  ChangePlan,
  ConflictCode,
  ConflictItem,
  CreateChangePlanOptions,
  PlanAdapter,
  PlanApplyOutcome,
  PlanControl,
  PlanControlRef,
  ValueCapability
} from "./plan-types";

const UNSAFE_TOKENS = new Set(["__proto__", "prototype", "constructor"]);
const ABSENT = Symbol("form2js.absent");


interface TrieNode {
  key: string | number;
  children: Map<string | number, TrieNode>;
  control?: PlanControl;
  isArray: boolean;
  arrayGroup?: boolean;
}

interface FoundConflict {
  code: ConflictCode;
  path: string;
  oldValue: EntryValue;
  newValue: EntryValue;
  controls: PlanControl[];
  message: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object") {
    return false;
  }

  const proto: object | null = Object.getPrototypeOf(value) as object | null;
  return proto === Object.prototype || proto === null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) {
    return true;
  }

  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") {
    return false;
  }

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }

    return a.every((item, index) => deepEqual(item, b[index]));
  }

  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }

  if (isPlainObject(a) && isPlainObject(b)) {
    const aKeys = Object.keys(a);
    const bKeys = Object.keys(b);
    if (aKeys.length !== bKeys.length) {
      return false;
    }

    return aKeys.every((key) => deepEqual(a[key], b[key]));
  }

  return false;
}

function isEmptyLeafValue(value: unknown): boolean {
  return value === ABSENT || value === null || value === "";
}

interface FileLikeSnapshot {
  name: string;
  size: number;
  type: string;
  lastModified: number;
}

function isFileLike(value: unknown): value is FileLikeSnapshot & { readonly type: string } {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  const tag = Object.prototype.toString.call(value);
  const isBlobTag = tag === "[object File]" || tag === "[object Blob]";
  const globalBlob = (globalThis as { Blob?: unknown }).Blob;
  const isBlobInstance =
    typeof globalBlob === "function" &&
    value instanceof (globalBlob as new (...args: unknown[]) => unknown);

  return (
    (isBlobTag || isBlobInstance) &&
    typeof candidate.name === "string" &&
    typeof candidate.size === "number" &&
    typeof candidate.slice === "function"
  );
}

function snapshotValue(value: EntryValue): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => snapshotValue(item));
  }

  if (isFileLike(value)) {
    const file = value as FileLikeSnapshot;
    return {
      __file__: true,
      name: file.name,
      size: file.size,
      type: file.type,
      lastModified: file.lastModified
    };
  }

  return value;
}

function stableStringify(value: unknown): string {
  const snapped = snapshotValue(value);
  return JSON.stringify(snapped);
}

function comparePathTokens(a: string, b: string): number {
  const segmentsA = parseCanonicalPath(a);
  const segmentsB = parseCanonicalPath(b);
  const maxLength = Math.max(segmentsA.length, segmentsB.length);

  for (let index = 0; index < maxLength; index += 1) {
    const segmentA = segmentsA[index];
    const segmentB = segmentsB[index];

    if (!segmentA || !segmentB) {
      return segmentsA.length - segmentsB.length;
    }

    if (segmentA.type !== segmentB.type) {
      const rankA = segmentA.type === "object" ? 0 : 1;
      const rankB = segmentB.type === "object" ? 0 : 1;
      return rankA - rankB;
    }

    if (segmentA.type === "object" && segmentB.type === "object") {
      if (segmentA.key !== segmentB.key) {
        return segmentA.key < segmentB.key ? -1 : 1;
      }
    } else {
      const indexA = segmentA.type === "index" ? segmentA.index : -1;
      const indexB = segmentB.type === "index" ? segmentB.index : -1;
      if (indexA !== indexB) {
        return indexA - indexB;
      }
    }
  }

  return 0;
}

const CHANGE_KIND_ORDER: Record<ChangeItem["kind"], number> = {
  clear: 0,
  remove: 1,
  set: 2,
  append: 3
};

const CONFLICT_CODE_ORDER: Record<ConflictCode, number> = {
  "ambiguous-control": 0,
  capability: 1,
  disabled: 2,
  "no-control": 3,
  shape: 4,
  "unsafe-path": 5
};

function sortChanges(changes: ChangeItem[]): ChangeItem[] {
  return [...changes].sort((a, b) => {
    const pathCompare = comparePathTokens(a.path, b.path);
    if (pathCompare !== 0) {
      return pathCompare;
    }

    return CHANGE_KIND_ORDER[a.kind] - CHANGE_KIND_ORDER[b.kind];
  });
}

function sortConflicts(conflicts: FoundConflict[]): FoundConflict[] {
  return [...conflicts].sort((a, b) => {
    const codeCompare = CONFLICT_CODE_ORDER[a.code] - CONFLICT_CODE_ORDER[b.code];
    if (codeCompare !== 0) {
      return codeCompare;
    }

    return comparePathTokens(a.path, b.path);
  });
}

function toRef(control: PlanControl): PlanControlRef {
  return control.ref;
}

function toRefs(controls: Iterable<PlanControl>): PlanControlRef[] {
  return [...controls].map(toRef);
}

function ensureTrieNode(root: TrieNode, segments: readonly PathSegment[]): TrieNode {
  let current = root;

  segments.forEach((segment, index) => {
    const key =
      segment.type === "object"
        ? segment.key
        : segment.type === "index"
          ? segment.index
          : `append-${current.children.size}`;
    const isArraySegment = segment.type !== "object";

    let child = current.children.get(key);
    if (!child) {
      child = {
        key,
        children: new Map(),
        isArray: false
      };
      current.children.set(key, child);
    }

    if (isArraySegment) {
      child.isArray = true;
    } else if (index === segments.length - 1) {
      child.isArray = false;
    }

    current = child;
  });

  return current;
}

function getTrieNode(root: TrieNode, segments: readonly PathSegment[]): TrieNode | null {
  let current: TrieNode | undefined = root;

  for (const segment of segments) {
    const key =
      segment.type === "object"
        ? segment.key
        : segment.type === "index"
          ? segment.index
          : -1;
    if (!current) {
      return null;
    }

    const childNode = current.children.get(key);
    if (!childNode) {
      return null;
    }

    current = childNode;
  }

  return current ?? null;
}

interface CollectedControls {
  byPath: Map<string, PlanControl[]>;
  ambiguousPaths: Set<string>;
  fingerprints: ChangePlan["fingerprint"];
}

function collectControls(adapter: PlanAdapter): CollectedControls {
  const byPath = new Map<string, PlanControl[]>();
  const fingerprints: ChangePlan["fingerprint"] = Object.create(null) as ChangePlan["fingerprint"];

  for (const control of adapter.controls()) {
    fingerprints[control.id] = control.fingerprint();

    const group = byPath.get(control.path);
    if (group) {
      group.push(control);
    } else {
      byPath.set(control.path, [control]);
    }
  }

  const ambiguousPaths = new Set<string>();

  for (const [path, controls] of byPath) {
    const leafKinds = new Set(controls.map((control) => control.leafKind));
    const controlKinds = new Set(controls.map((control) => control.ref.kind));
    const scalarSingles = controls.filter((control) => control.leafKind === "scalar");

    if (
      leafKinds.size > 1 ||
      controlKinds.size > 1 ||
      scalarSingles.length > 1
    ) {
      ambiguousPaths.add(path);
    }
  }

  return { byPath, ambiguousPaths, fingerprints };
}

function getValueAtSegments(value: unknown, segments: readonly PathSegment[]): unknown {
  let current: unknown = value;

  for (const segment of segments) {
    if (current === null || typeof current !== "object") {
      return ABSENT;
    }

    if (segment.type === "object") {
      if (Array.isArray(current)) {
        return ABSENT;
      }

      if (!Object.prototype.hasOwnProperty.call(current, segment.key)) {
        return ABSENT;
      }

      current = (current as Record<string, unknown>)[segment.key];
    } else if (segment.type === "index") {
      if (!Array.isArray(current) || segment.index >= current.length) {
        return ABSENT;
      }

      current = current[segment.index];
    } else {
      return ABSENT;
    }
  }

  return current as unknown;
}

function resolveChangeCapability(
  controls: PlanControl[],
  newValue: EntryValue
): { lossless: boolean; capabilityConflict?: FoundConflict; path: string } {
  const path = controls[0]?.path ?? "";
  let lossless = true;

  for (const control of controls) {
    const capability: ValueCapability = control.canRepresent(newValue);
    if (!capability.representable) {
      return {
        lossless: capability.lossless,
        path,
        capabilityConflict: {
          code: "capability",
          path,
          oldValue: control.readValue(),
          newValue,
          controls,
          message:
            capability.message ??
            `${control.ref.adapter} adapter cannot represent the requested value at ${path}.`
        }
      };
    }

    lossless = lossless && capability.lossless;
  }

  return { lossless, path };
}

function findEnabledControls(controls: PlanControl[]): PlanControl[] {
  return controls.filter((control) => !control.disabled);
}

function addDisabledConflictIfNeeded(
  conflicts: FoundConflict[],
  controls: PlanControl[],
  path: string,
  oldValue: EntryValue,
  newValue: EntryValue
): void {
  const disabled = controls.filter((control) => control.disabled);
  if (disabled.length === 0) {
    return;
  }

  conflicts.push({
    code: "disabled",
    path,
    oldValue,
    newValue,
    controls: disabled,
    message: `Controls at ${path} are disabled and cannot be written.`
  });
}

function isArrayContainer(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

interface TargetLeaf {
  path: string;
  segments: PathSegment[];
  value: EntryValue;
  unsafeToken: string | null;
}

function collectTargetLeaves(
  target: unknown,
  delimiter: string,
  stopAt?: (segments: readonly PathSegment[]) => boolean
): TargetLeaf[] {
  const leaves: TargetLeaf[] = [];
  void delimiter;

  function pushLeaf(value: unknown, segments: PathSegment[]): void {
    leaves.push({
      path: formatCanonicalPath(segments),
      segments: [...segments],
      value: value as EntryValue,
      unsafeToken: findUnsafeSegment(segments)
    });
  }

  function walk(value: unknown, segments: PathSegment[]): void {
    if (stopAt?.(segments)) {
      pushLeaf(value, segments);
      return;
    }

    if (value === null || typeof value !== "object") {
      pushLeaf(value, segments);
      return;
    }

    if (Array.isArray(value) || isFileLike(value)) {
      pushLeaf(value, segments);
      return;
    }

    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);

    if (keys.length === 0 && segments.length > 0) {
      pushLeaf({}, segments);
      return;
    }

    for (const key of keys) {
      if (key.endsWith("[]")) {
        walk(record[key], [...segments, { type: "object", key: key.slice(0, -2) }]);
        continue;
      }

      walk(record[key], [...segments, { type: "object", key }]);
    }
  }

  walk(target, []);
  return leaves;
}

function findUnsafeSegment(segments: readonly PathSegment[]): string | null {
  for (const segment of segments) {
    if (segment.type === "object" && UNSAFE_TOKENS.has(segment.key)) {
      return segment.key;
    }
  }

  return null;
}


function buildCurrentTrie(byPath: Map<string, PlanControl[]>): TrieNode {
  const root: TrieNode = { key: "", children: new Map(), isArray: false, arrayGroup: false };

  for (const [path, controls] of byPath) {
    const segments = parseCanonicalPath(path);
    const node = ensureTrieNode(root, segments);
    if (controls[0]) {
      if (controls[0].leafKind === "array") {
        node.arrayGroup = true;
      }

      if (segments.length > 0) {
        node.control = controls[0];
      }
    }
  }

  for (const [path, controls] of byPath) {
    if (!controls.some((control) => control.leafKind === "array" || control.ref.kind === "repeat-scalar")) {
      continue;
    }

    const segments = parseCanonicalPath(path);
    const node = getTrieNode(root, segments);
    if (node && controls[0]) {
      node.arrayGroup = true;
      node.control = controls[0];
    }
  }

  return root;
}

interface PendingChange {
  kind: ChangeItem["kind"];
  path: string;
  oldValue: EntryValue;
  newValue: EntryValue;
  controls: PlanControl[];
  lossless: boolean;
  capabilityVerified?: boolean;
}

function arrayDiff(
  oldArray: unknown[],
  newArray: unknown[],
  controls: PlanControl[]
): PendingChange[] {
  const pending: PendingChange[] = [];

  if (newArray.length === 0) {
    if (oldArray.length > 0) {
      pending.push({
        kind: "clear",
        path: controls[0]?.path ?? "",
        oldValue: oldArray,
        newValue: [],
        controls,
        lossless: true
      });
    }

    return pending;
  }

  for (let index = 0; index < Math.max(oldArray.length, newArray.length); index += 1) {
    const oldItem = index < oldArray.length ? oldArray[index] : ABSENT;
    const newItem = index < newArray.length ? newArray[index] : ABSENT;
    const path = controls[0]?.path ? `${controls[0].path}[${index}]` : `[${index}]`;

    if (newItem === ABSENT) {
      pending.push({
        kind: "remove",
        path,
        oldValue: oldItem as EntryValue,
        newValue: null,
        controls,
        lossless: true
      });
      continue;
    }

    if (oldItem === ABSENT) {
      pending.push({
        kind: "append",
        path,
        oldValue: null,
        newValue: newItem as EntryValue,
        controls,
        lossless: true
      });
      continue;
    }

    if (isEmptyLeafValue(newItem as unknown) && !isEmptyLeafValue(oldItem as unknown)) {
      pending.push({
        kind: "clear",
        path,
        oldValue: oldItem as EntryValue,
        newValue: newItem === "" ? "" : null,
        controls,
        lossless: true
      });
      continue;
    }

    if (!deepEqual(oldItem, newItem)) {
      pending.push({
        kind: "set",
        path,
        oldValue: oldItem as EntryValue,
        newValue: newItem as EntryValue,
        controls,
        lossless: true
      });
    }
  }

  return pending;
}

function multisetDiff(
  oldValues: unknown[],
  newValues: unknown[],
  controls: PlanControl[]
): PendingChange[] {
  const groupPath = controls[0]?.path ?? "";

  if (newValues.length === 0 && oldValues.length > 0) {
    return [
      {
        kind: "clear",
        path: groupPath,
        oldValue: oldValues,
        newValue: [],
        controls,
        lossless: true
      }
    ];
  }

  const oldCounts = new Map<string, { value: unknown; count: number }>();
  for (const value of oldValues) {
    const key = stableStringify(value);
    const entry = oldCounts.get(key);
    if (entry) {
      entry.count += 1;
    } else {
      oldCounts.set(key, { value, count: 1 });
    }
  }

  const pending: PendingChange[] = [];

  for (const value of newValues) {
    const key = stableStringify(value);
    const entry = oldCounts.get(key);
    if (entry && entry.count > 0) {
      entry.count -= 1;
    } else {
      pending.push({
        kind: "append",
        path: groupPath,
        oldValue: null,
        newValue: value,
        controls,
        lossless: true
      });
    }
  }

  for (const { value, count } of oldCounts.values()) {
    for (let index = 0; index < count; index += 1) {
      pending.push({
        kind: "remove",
        path: groupPath,
        oldValue: value,
        newValue: null,
        controls,
        lossless: true
      });
    }
  }

  return pending;
}
export function createChangePlan(
  adapter: PlanAdapter,
  target: unknown,
  options: CreateChangePlanOptions = {}
): ChangePlan {
  const delimiter = options.delimiter ?? ".";
  const allowUnsafe = options.allowUnsafePathSegments ?? false;
  const allowMissingControls = options.allowMissingControls ?? false;

  const { byPath, ambiguousPaths, fingerprints } = collectControls(adapter);
  const currentRoot = buildCurrentTrie(byPath);
  const targetLeaves = collectTargetLeaves(target, delimiter, (segments) => {
    const node = getTrieNode(currentRoot, segments);
    return Boolean(
      (node?.control?.leafKind === "array") || node?.arrayGroup
    );
  });

  const pendingChanges: PendingChange[] = [];
  const foundConflicts: FoundConflict[] = [];
  const shapePaths = new Set<string>();

  for (const leaf of targetLeaves) {
    const unsafeToken = leaf.unsafeToken;
    if (unsafeToken && !allowUnsafe) {
      foundConflicts.push({
        code: "unsafe-path",
        path: leaf.path,
        oldValue: null,
        newValue: leaf.value,
        controls: [],
        message: `Unsafe path segment "${unsafeToken}" is blocked. Pass allowUnsafePathSegments: true only for trusted input.`
      });
      continue;
    }

    let deepestNode: TrieNode | null = null;
    let deepestLength = 0;

    for (let length = 1; length <= leaf.segments.length; length += 1) {
      const prefixSegments = leaf.segments.slice(0, length);
      const node = getTrieNode(currentRoot, prefixSegments);

      if (node) {
        deepestNode = node;
        deepestLength = length;
      }

      if (node?.control && length < leaf.segments.length) {
        const prefixPath = formatCanonicalPath(prefixSegments);
        if (!shapePaths.has(prefixPath)) {
          shapePaths.add(prefixPath);
          foundConflicts.push({
            code: "shape",
            path: prefixPath,
            oldValue: node.control.readValue(),
            newValue: getValueAtSegments(target, prefixSegments),
            controls: [node.control],
            message: `Path ${prefixPath} is a single value in the current structure but a container in the target object.`
          });
        }
        break;
      }

      if (node && !node.control && node.children.size > 0 && length < leaf.segments.length) {
        const targetSegment = leaf.segments[length];
        const targetIsArray = targetSegment?.type === "index";

        if (node.isArray !== targetIsArray && targetSegment) {
          const prefixPath = formatCanonicalPath(prefixSegments);
          if (!shapePaths.has(prefixPath)) {
            shapePaths.add(prefixPath);
            foundConflicts.push({
              code: "shape",
              path: prefixPath,
              oldValue: node.isArray ? [] : {},
              newValue: targetIsArray ? [] : {},
              controls: collectControlsAt(node),
              message: `Path ${prefixPath} changes between object and array shape.`
            });
          }
          break;
        }
      }
    }

    const blockedByShape = leaf.segments.some((_, index) =>
      shapePaths.has(formatCanonicalPath(leaf.segments.slice(0, index + 1)))
    );

    if (!blockedByShape) {
      const leafNode = deepestLength === leaf.segments.length ? deepestNode : null;
      processTargetLeaf({
        node: leafNode,
        deepestNode,
        path: leaf.path,
        bindingPath: deepestNode ? formatCanonicalPath(leaf.segments.slice(0, deepestLength)) : leaf.path,
        newValue: leaf.value,
        segments: leaf.segments,
        target,
        byPath,
        ambiguousPaths,
        pendingChanges,
        foundConflicts,
        allowMissingControls,
        canCreatePaths: adapter.canCreatePaths
      });
    }
  }

  for (const [path, controls] of byPath) {
    const segments = parseCanonicalPath(path);
    const targetValue = getValueAtSegments(target, segments);
    const enabledControls = findEnabledControls(controls);

    if (targetValue !== ABSENT) {
      continue;
    }

    if (ambiguousPaths.has(path)) {
      continue;
    }

    for (const control of enabledControls) {
      const currentValue = control.readValue();
      const isEmptyCurrent =
        control.leafKind === "array"
          ? Array.isArray(currentValue) && currentValue.length === 0
          : isEmptyLeafValue(currentValue as unknown);

      if (!isEmptyCurrent) {
        pendingChanges.push({
          kind: "clear",
          path,
          oldValue: currentValue,
          newValue: null,
          controls: enabledControls.length > 0 ? enabledControls : controls,
          lossless: true
        });
      }
    }
  }

  const resolvedChanges: ChangeItem[] = [];
  const capabilityBlockedPaths = new Set<string>();

  for (const change of pendingChanges) {
    const controls = change.controls.length > 0 ? change.controls : [];
    addDisabledConflictIfNeeded(
      foundConflicts,
      controls,
      change.path,
      change.oldValue,
      change.newValue
    );

    let lossless = change.lossless;
    if (change.capabilityVerified) {
      resolvedChanges.push({
        kind: change.kind,
        path: change.path,
        oldValue: change.oldValue,
        newValue: change.newValue,
        lossless,
        controls: toRefs(controls)
      });
      continue;
    }

    if (controls.length > 0) {
      const capability = resolveChangeCapability(controls, change.newValue);
      lossless = capability.lossless;
      if (capability.capabilityConflict) {
        capabilityBlockedPaths.add(change.path);
        foundConflicts.push(capability.capabilityConflict);
        continue;
      }
    }

    resolvedChanges.push({
      kind: change.kind,
      path: change.path,
      oldValue: change.oldValue,
      newValue: change.newValue,
      lossless,
      controls: toRefs(controls)
    });
  }

  for (const ambiguousPath of ambiguousPaths) {
    if (shapePaths.has(ambiguousPath)) {
      continue;
    }

    const controls = byPath.get(ambiguousPath) ?? [];
    const segments = parseCanonicalPath(ambiguousPath);
    const targetValue = getValueAtSegments(target, segments);

    foundConflicts.push({
      code: "ambiguous-control",
      path: ambiguousPath,
      oldValue: controls[0]?.readValue() ?? null,
      newValue: targetValue === ABSENT ? null : (targetValue as EntryValue),
      controls,
      message: `Multiple controls share path ${ambiguousPath} with incompatible value shapes.`
    });
  }

  const sortedConflicts = sortConflicts(foundConflicts);
  const numberedConflicts: ConflictItem[] = sortedConflicts.map((conflict, index) => ({
    id: `C${String(index + 1).padStart(3, "0")}`,
    code: conflict.code,
    path: conflict.path,
    message: conflict.message,
    oldValue: conflict.oldValue,
    newValue: conflict.newValue,
    lossless: conflict.code === "capability" ? false : true,
    controls: toRefs(conflict.controls)
  }));

  void currentRoot;

  return {
    version: 1,
    delimiter,
    adapter: adapter.name,
    fingerprint: fingerprints,
    changes: sortChanges(resolvedChanges),
    conflicts: numberedConflicts,
    status: "ready"
  };
}

function collectControlsAt(node: TrieNode): PlanControl[] {
  const controls: PlanControl[] = [];

  function walk(current: TrieNode): void {
    if (current.control) {
      controls.push(current.control);
    }

    for (const child of current.children.values()) {
      walk(child);
    }
  }

  walk(node);
  return controls;
}

interface ProcessTargetLeafArgs {
  node: TrieNode | null;
  deepestNode: TrieNode | null;
  path: string;
  bindingPath: string;
  newValue: EntryValue;
  segments: PathSegment[];
  target: unknown;
  byPath: Map<string, PlanControl[]>;
  ambiguousPaths: Set<string>;
  pendingChanges: PendingChange[];
  foundConflicts: FoundConflict[];
  allowMissingControls: boolean;
  canCreatePaths: boolean;
}

function isAllDisabled(controls: PlanControl[]): boolean {
  return controls.length > 0 && controls.every((control) => control.disabled);
}

function processTargetLeaf(args: ProcessTargetLeafArgs): void {
  const { deepestNode, path, bindingPath, newValue, segments, target, pendingChanges, foundConflicts, allowMissingControls, canCreatePaths } = args;
  const bindingSegments = parseCanonicalPath(bindingPath);
  const arrayBinding =
    deepestNode?.control?.leafKind === "array" &&
    bindingSegments.length < segments.length && deepestNode.control
      ? deepestNode.control
      : null;

  if (arrayBinding) {
    const targetArray = getValueAtSegments(target, bindingSegments);

    if (arrayBinding.disabled) {
      foundConflicts.push({
        code: "disabled",
        path: bindingPath,
        oldValue: arrayBinding.readValue(),
        newValue: targetArray as EntryValue,
        controls: [arrayBinding],
        message: `Control at ${bindingPath} is disabled and cannot be written.`
      });
      return;
    }

    if (Array.isArray(targetArray)) {
      const currentValue = arrayBinding.readValue();
      const oldArray = Array.isArray(currentValue) ? currentValue : [];
      const capability = arrayBinding.canRepresent(targetArray);
      if (!capability.representable) {
        foundConflicts.push({
          code: "capability",
          path: bindingPath,
          oldValue: currentValue,
          newValue: targetArray,
          controls: [arrayBinding],
          message:
            capability.message ??
            `Adapter cannot represent the requested value at ${bindingPath}.`
        });
        return;
      }

      if (arrayBinding.ref.kind === "repeat-scalar" && targetArray.length > oldArray.length) {
        foundConflicts.push({
          code: "capability",
          path: bindingPath,
          oldValue: currentValue,
          newValue: targetArray,
          controls: [arrayBinding],
          message: `Repeated scalar controls at ${bindingPath} cannot grow beyond the ${oldArray.length} existing control(s).`
        });
        return;
      }

      const diffFn = arrayBinding.ordered === false ? multisetDiff : arrayDiff;
      for (const change of diffFn(oldArray, targetArray, [arrayBinding])) {
        pendingChanges.push({ ...change, capabilityVerified: true });
      }
    }
    return;
  }

  const controls = args.node?.control
    ? [args.node.control]
    : (args.byPath.get(path) ?? args.byPath.get(bindingPath) ?? []);

  if (controls.length === 0) {
    if (!allowMissingControls && !canCreatePaths) {
      foundConflicts.push({
        code: "no-control",
        path,
        oldValue: null,
        newValue,
        controls: [],
        message: `No form control is bound to ${path}.`
      });
    } else if (canCreatePaths) {
      pendingChanges.push({
        kind: "set",
        path,
        oldValue: null,
        newValue,
        controls: [],
        lossless: true
      });
    }
    return;
  }

  if (args.ambiguousPaths.has(path)) {
    return;
  }

  if (isAllDisabled(controls)) {
    foundConflicts.push({
      code: "disabled",
      path,
      oldValue: controls[0]?.readValue() ?? null,
      newValue,
      controls,
      message: `Control at ${path} is disabled and cannot be written.`
    });
    return;
  }

  const enabledControls = findEnabledControls(controls);
  const primary: PlanControl | undefined = enabledControls[0];
  if (!primary) {
    return;
  }

  const oldValue = primary.readValue();

  if (primary.leafKind === "array") {
    const oldArray = Array.isArray(oldValue) ? oldValue : oldValue === "" || oldValue === null ? [] : [oldValue];
    const newArray = Array.isArray(newValue) ? newValue : newValue === null ? [] : [newValue];

    for (const control of enabledControls) {
      const capability = control.canRepresent(newValue);
      if (!capability.representable) {
        foundConflicts.push({
          code: "capability",
          path,
          oldValue,
          newValue,
          controls: enabledControls,
          message: capability.message ?? `Adapter cannot represent the requested value at ${path}.`
        });
        return;
      }
    }

    if (primary.ref.kind === "repeat-scalar" && newArray.length > oldArray.length) {
      foundConflicts.push({
        code: "capability",
        path,
        oldValue,
        newValue,
        controls,
        message: `Repeated scalar controls at ${path} cannot grow beyond the ${oldArray.length} existing control(s).`
      });
      return;
    }

    const diffFn = primary.ordered === false ? multisetDiff : arrayDiff;
    for (const change of diffFn(oldArray, newArray, enabledControls)) {
      pendingChanges.push({ ...change, capabilityVerified: true });
    }
    return;
  }

  if (Array.isArray(newValue) || isArrayContainer(oldValue)) {
    foundConflicts.push({
      code: "shape",
      path,
      oldValue,
      newValue,
      controls,
      message: `Path ${path} is a single-value control but the target value is an array.`
    });
    return;
  }

  if (typeof newValue === "object" && newValue !== null && !isFileLike(newValue)) {
    foundConflicts.push({
      code: "shape",
      path,
      oldValue,
      newValue,
      controls,
      message: `Path ${path} is a single-value control but the target value is an object.`
    });
    return;
  }

  if (isFileLike(newValue)) {
    if (deepEqual(oldValue, newValue)) {
      return;
    }

    pendingChanges.push({
      kind: "set",
      path,
      oldValue,
      newValue,
      controls: enabledControls,
      lossless: true
    });
    return;
  }

  if (isEmptyLeafValue(newValue as unknown)) {
    if (isEmptyLeafValue(oldValue as unknown)) {
      return;
    }

    pendingChanges.push({
      kind: "clear",
      path,
      oldValue,
      newValue: newValue === "" ? "" : null,
      controls: enabledControls,
      lossless: true
    });
    return;
  }

  if (deepEqual(oldValue, newValue)) {
    return;
  }

  pendingChanges.push({
    kind: "set",
    path,
    oldValue,
    newValue,
    controls: enabledControls,
    lossless: true
  });
}


const appliedResults = new WeakMap<ChangePlan, PlanApplyOutcome>();

export function verifyPlanBaseline(adapter: PlanAdapter, plan: ChangePlan): BaselineDiff[] {
  const diffs: BaselineDiff[] = [];

  for (const control of adapter.controls()) {
    const expected = plan.fingerprint[control.id];
    if (expected === undefined) {
      continue;
    }

    const actual = control.fingerprint();
    if (actual !== expected) {
      diffs.push({
        controlId: control.id,
        path: control.path,
        expected,
        actual,
        ref: control.ref
      });
    }
  }

  return diffs.sort((a, b) => comparePathTokens(a.path, b.path) || a.controlId.localeCompare(b.controlId));
}

export function applyChangePlan(
  adapter: PlanAdapter,
  plan: ChangePlan
): PlanApplyOutcome {
  const cached = appliedResults.get(plan);
  if (cached) {
    return cached;
  }

  if (plan.status !== "ready") {
    const outcome: PlanApplyOutcome = {
      status: "rejected",
      reason: "baseline-changed",
      plan
    };
    appliedResults.set(plan, outcome);
    return outcome;
  }

  if (plan.conflicts.length > 0) {
    plan.status = "rejected";
    const outcome: PlanApplyOutcome = {
      status: "rejected",
      reason: "conflicts",
      plan,
      conflicts: plan.conflicts
    };
    appliedResults.set(plan, outcome);
    return outcome;
  }

  const baselineDiffs = verifyPlanBaseline(adapter, plan);
  if (baselineDiffs.length > 0) {
    plan.status = "rejected";
    const outcome: PlanApplyOutcome = {
      status: "rejected",
      reason: "baseline-changed",
      plan,
      baselineDiffs
    };
    appliedResults.set(plan, outcome);
    return outcome;
  }

  const controlsById = new Map<string, PlanControl>();
  for (const control of adapter.controls()) {
    controlsById.set(control.id, control);
  }

  const applyOrder: Record<ChangeItem["kind"], number> = {
    remove: 0,
    clear: 1,
    set: 2,
    append: 3
  };
  const orderedChanges = [...plan.changes].sort(
    (a, b) =>
      applyOrder[a.kind] - applyOrder[b.kind] || comparePathTokens(b.path, a.path)
  );

  for (const change of orderedChanges) {
    const targets = change.controls
      .map((ref) => controlsById.get(ref.id))
      .filter((control): control is PlanControl => Boolean(control));

    if (targets.length === 0 && adapter.applyChange) {
      adapter.applyChange(change);
      continue;
    }

    for (const control of targets) {
      control.apply(change);
    }
  }

  const commitResult = adapter.commit?.();
  plan.status = "applied";
  adapter.onApplied?.();

  const outcome: PlanApplyOutcome = {
    status: "applied",
    plan,
    changes: plan.changes,
    result: (commitResult ?? {}) as ObjectTree
  };
  appliedResults.set(plan, outcome);
  return outcome;
}

export { isFileLike, snapshotValue, stableStringify };
export type { PendingChange };
