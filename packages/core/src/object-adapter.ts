import { formatCanonicalPath, parseCanonicalPath, type PathSegment } from "./canonical";
import type { EntryValue, ObjectTree } from "./types";
import type { ChangeItem, PlanAdapter, PlanControl, ValueCapability } from "./plan-types";

interface VirtualLeaf {
  segments: PathSegment[];
  path: string;
  value: EntryValue;
  leafKind: "scalar" | "array";
}

function collectVirtualLeaves(source: unknown): VirtualLeaf[] {
  const leaves: VirtualLeaf[] = [];

  function walk(value: unknown, segments: PathSegment[]): void {
    if (value === null || typeof value !== "object") {
      leaves.push({ segments: [...segments], path: formatCanonicalPath(segments), value: value as EntryValue, leafKind: "scalar" });
      return;
    }

    if (Array.isArray(value)) {
      leaves.push({ segments: [...segments], path: formatCanonicalPath(segments), value, leafKind: "array" });
      return;
    }

    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      walk(record[key], [...segments, { type: "object", key }]);
    }
  }

  walk(source, []);
  return leaves;
}

function setValueAtSegments(target: unknown, segments: readonly PathSegment[], value: EntryValue): void {
  if (segments.length === 0) {
    return;
  }

  let current: Record<string, unknown> | unknown[] = target as Record<string, unknown>;

  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (!segment) {
      return;
    }

    if (segment.type === "object") {
      current = (current as Record<string, unknown>)[segment.key] as Record<string, unknown>;
    } else if (segment.type === "index") {
      current = (current as unknown[])[segment.index] as unknown[];
    }
  }

  const last = segments[segments.length - 1];
  if (!last) {
    return;
  }

  if (last.type === "object") {
    (current as Record<string, unknown>)[last.key] = value;
  } else if (last.type === "index") {
    (current as unknown[])[last.index] = value;
  }
}

export interface ObjectPlanAdapterOptions {
  name?: string;
  canCreatePaths?: boolean;
}

export function createObjectPlanAdapter(
  source: ObjectTree,
  options: ObjectPlanAdapterOptions = {}
): PlanAdapter {
  const leaves = collectVirtualLeaves(source);

  const controls: PlanControl[] = leaves
    .filter((leaf) => leaf.path !== "")
    .map((leaf, index) => {
      const control: PlanControl = {
        id: `obj:${index}:${leaf.path}`,
        path: leaf.path,
        leafKind: leaf.leafKind,
        disabled: false,
        ref: {
          id: `obj:${index}:${leaf.path}`,
          adapter: options.name ?? "object",
          kind: "virtual",
          name: leaf.path,
          path: leaf.path
        },
        readValue() {
          return getValueAtSegments(source, leaf.segments);
        },
        fingerprint() {
          const value = getValueAtSegments(source, leaf.segments);
          return JSON.stringify({
            t: Array.isArray(value) ? "array" : typeof value,
            v: value
          });
        },
        canRepresent(): ValueCapability {
          return { representable: true, lossless: true };
        },
        apply(item: ChangeItem) {
          applyItemToSource(source, item);
        }
      };
      return control;
    });

  return {
    name: options.name ?? "object",
    canCreatePaths: options.canCreatePaths ?? true,
    controls: () => controls,
    commit(): ObjectTree {
      return source;
    }
  };
}

function getValueAtSegments(source: unknown, segments: readonly PathSegment[]): EntryValue {
  let current: unknown = source;

  for (const segment of segments) {
    if (current === null || typeof current !== "object") {
      return null;
    }

    if (segment.type === "object") {
      if (Array.isArray(current)) {
        return null;
      }
      current = (current as Record<string, unknown>)[segment.key];
    } else if (segment.type === "index") {
      if (!Array.isArray(current) || segment.index >= current.length) {
        return null;
      }
      current = current[segment.index];
    }
  }

  return current as EntryValue;
}

function applyItemToSource(
  source: ObjectTree,
  item: ChangeItem
): void {
  const segments = parseCanonicalPath(item.path);
  const last = segments[segments.length - 1];

  if (last?.type === "index") {
    const parentSegments = segments.slice(0, -1);
    const parentValue = getValueAtSegments(source, parentSegments);
    const arr: unknown[] = Array.isArray(parentValue)
        ? [...(parentValue as unknown[])]
        : [];

    if (item.kind === "remove") {
      arr.splice(last.index, 1);
    } else {
      arr[last.index] = item.newValue;
    }

    setValueAtSegments(source, parentSegments, arr);
    return;
  }

  setValueAtSegments(source, segments, item.newValue);
}
