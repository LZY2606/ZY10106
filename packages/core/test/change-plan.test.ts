import { describe, expect, it, vi } from "vitest";
import {
  CHANGE_CONFLICT_CODES,
  applyChangePlan,
  createChangePlan,
  fingerprintValue,
  planChanges,
  type ChangePlan,
  type ChangePlanSource
} from "../src/index";

function createMemorySource(
  entries: { key: string; value: unknown }[],
  overrides: Partial<ChangePlanSource> = {}
): ChangePlanSource & { state: Map<string, unknown> } {
  const state = new Map<string, unknown>(entries.map((entry) => [entry.key, entry.value]));

  return {
    kind: "memory",
    state,
    readEntries() {
      return [...state.entries()].map(([key, value]) => ({ key, value }));
    },
    fingerprint() {
      return fingerprintValue(Object.fromEntries(state));
    },
    snapshotControls() {
      return Object.fromEntries(
        [...state.entries()].map(([key, value]) => [key, String(value)])
      );
    },
    controlsForPath(path: string) {
      return state.has(path) ? [path] : [];
    },
    canExpress(_path: string, value: unknown) {
      return typeof value !== "function" && typeof value !== "symbol";
    },
    applyItems(items) {
      for (const item of items) {
        if (item.op === "remove") {
          state.delete(item.path);
        } else if (item.op === "clear") {
          state.set(item.path, "");
        } else {
          state.set(item.path, item.newValue);
        }
      }
    },
    ...overrides
  };
}

describe("planChanges", () => {
  it("emits set items for changed scalar values with canonical paths", () => {
    const plan = planChanges(
      { person: { name: { first: "Esme" } } },
      { person: { name: { first: "Tiffany" } } }
    );

    expect(plan.items).toHaveLength(1);
    expect(plan.items[0]).toMatchObject({
      id: "F2J-OP-0001",
      op: "set",
      path: "person.name.first",
      oldValue: "Esme",
      newValue: "Tiffany",
      lossless: true,
      controls: []
    });
    expect(plan.conflicts).toHaveLength(0);
  });

  it("emits append and remove items for array length changes", () => {
    const plan = planChanges(
      { tags: ["a", "b", "c"] },
      { tags: ["a", "x"] }
    );

    expect(plan.items).toEqual([
      expect.objectContaining({ op: "set", path: "tags[1]", oldValue: "b", newValue: "x" }),
      expect.objectContaining({ op: "remove", path: "tags[2]", oldValue: "c", newValue: undefined })
    ]);

    const appendPlan = planChanges({ tags: ["a"] }, { tags: ["a", "b", "c"] });
    expect(appendPlan.items).toEqual([
      expect.objectContaining({ op: "append", path: "tags[1]", newValue: "b" }),
      expect.objectContaining({ op: "append", path: "tags[2]", newValue: "c" })
    ]);
  });

  it("treats empty string and null targets as clear operations", () => {
    const plan = planChanges(
      { a: "x", b: "y" },
      { a: "", b: null }
    );

    expect(plan.items).toEqual([
      expect.objectContaining({ op: "clear", path: "a", oldValue: "x", newValue: "" }),
      expect.objectContaining({ op: "clear", path: "b", oldValue: "y", newValue: null })
    ]);
  });

  it("skips undefined target values and untouched current keys", () => {
    const plan = planChanges(
      { keep: "1", drop: "2" },
      { keep: "1", other: undefined }
    );

    expect(plan.items).toHaveLength(0);
  });

  it("removes current-only keys only when prune is enabled", () => {
    const current = { keep: "1", drop: "2" };
    const target = { keep: "1" };

    expect(planChanges(current, target).items).toHaveLength(0);

    const pruned = planChanges(current, target, { prune: true });
    expect(pruned.items).toEqual([
      expect.objectContaining({ op: "remove", path: "drop", oldValue: "2" })
    ]);
  });

  it("flags prototype pollution paths as conflicts that are never applied", () => {
    const target = JSON.parse('{"__proto__": {"polluted": "yes"}, "safe": "1"}') as unknown;
    const plan = planChanges({}, target);

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      op: "conflict",
      path: "__proto__.polluted",
      conflictCode: CHANGE_CONFLICT_CODES.unsafePath
    });
    expect(plan.items.find((item) => item.path === "safe")).toMatchObject({ op: "set" });
  });

  it("flags duplicate canonical paths produced by distinct target keys", () => {
    const target = { "a[0]": "x", a: ["y"] };
    const plan = planChanges({}, target);

    expect(plan.conflicts.length).toBeGreaterThan(0);
    for (const conflict of plan.conflicts) {
      expect(conflict.conflictCode).toBe(CHANGE_CONFLICT_CODES.duplicatePath);
      expect(conflict.path).toBe("a[0]");
    }
  });

  it("flags container shape mismatches as conflicts", () => {
    const plan = planChanges(
      { a: { nested: "1" } },
      { a: "scalar" }
    );

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      op: "conflict",
      path: "a",
      conflictCode: CHANGE_CONFLICT_CODES.typeMismatch
    });
  });

  it("sorts items deterministically by path and operation", () => {
    const first = planChanges(
      { b: "1", a: "1", items: ["x", "y"] },
      { b: "2", a: "2", items: ["x", "y", "z"] }
    );
    const second = planChanges(
      { items: ["x", "y"], a: "1", b: "1" },
      { items: ["x", "y", "z"], a: "2", b: "2" }
    );

    expect(first.items.map((item) => item.path)).toEqual(["a", "b", "items[2]"]);
    expect(first.items.map((item) => item.id)).toEqual(["F2J-OP-0001", "F2J-OP-0002", "F2J-OP-0003"]);
    expect(second.items.map((item) => item.path)).toEqual(["a", "b", "items[2]"]);
    expect(first.id).toBe(second.id);
  });

  it("does not mutate the current or target structures", () => {
    const current = { a: { b: "1" }, list: ["x"] };
    const target = { a: { b: "2" }, list: ["x", "y"] };
    const currentSnapshot = JSON.stringify(current);
    const targetSnapshot = JSON.stringify(target);

    planChanges(current, target);

    expect(JSON.stringify(current)).toBe(currentSnapshot);
    expect(JSON.stringify(target)).toBe(targetSnapshot);
  });

  it("marks non JSON-expressible leaves as lossy in adapter-free plans", () => {
    const fileLike = { name: "a.txt", size: 3, lastModified: 1, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) };
    const plan = planChanges({}, { upload: fileLike });

    expect(plan.items[0]).toMatchObject({ op: "set", path: "upload", lossless: false });
  });

  it("treats file-like values with equal metadata as unchanged", () => {
    const makeFile = () => ({ name: "a.txt", size: 3, lastModified: 1, arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) });
    const plan = planChanges({ upload: makeFile() }, { upload: makeFile() });

    expect(plan.items).toHaveLength(0);
  });
});

describe("createChangePlan with a source", () => {
  it("attaches controls and keeps expressible items lossless", () => {
    const source = createMemorySource([{ key: "name", value: "Esme" }]);
    const plan = createChangePlan(source, { name: "Tiffany" });

    expect(plan.items[0]).toMatchObject({
      op: "set",
      path: "name",
      controls: ["name"],
      lossless: true
    });
    expect(plan.baseline).toBe(source.fingerprint());
  });

  it("raises capability conflicts for values the source cannot express", () => {
    const source = createMemorySource([{ key: "name", value: "Esme" }]);
    const plan = createChangePlan(source, { name: () => "nope" });

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      op: "conflict",
      path: "name",
      conflictCode: CHANGE_CONFLICT_CODES.notExpressible
    });
  });

  it("raises unmapped-control conflicts when no control is bound to the path", () => {
    const source = createMemorySource([{ key: "name", value: "Esme" }]);
    const plan = createChangePlan(source, { missing: "x" });

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      op: "conflict",
      path: "missing",
      conflictCode: CHANGE_CONFLICT_CODES.unmappedControl
    });
  });
});

describe("applyChangePlan", () => {
  it("applies all items atomically when the baseline matches", () => {
    const source = createMemorySource([
      { key: "name", value: "Esme" },
      { key: "city", value: "Lancre" }
    ]);
    const plan = createChangePlan(source, { name: "Tiffany", city: "" });

    const result = applyChangePlan(source, plan);

    expect(result.status).toBe("applied");
    expect(result.appliedItems).toHaveLength(2);
    expect(source.state.get("name")).toBe("Tiffany");
    expect(source.state.get("city")).toBe("");
  });

  it("returns the first result when the same plan is applied repeatedly", () => {
    const applyItems = vi.fn();
    const source = createMemorySource([{ key: "name", value: "Esme" }], { applyItems });
    const plan = createChangePlan(source, { name: "Tiffany" });

    const first = applyChangePlan(source, plan);
    const second = applyChangePlan(source, plan);

    expect(first.status).toBe("applied");
    expect(second).toBe(first);
    expect(applyItems).toHaveBeenCalledTimes(1);
  });

  it("rejects the whole plan when any associated control changed since planning", () => {
    const source = createMemorySource([
      { key: "name", value: "Esme" },
      { key: "city", value: "Lancre" }
    ]);
    const plan = createChangePlan(source, { name: "Tiffany" });

    source.state.set("city", "Quirm");

    const result = applyChangePlan(source, plan);

    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("baseline-mismatch");
    expect(result.baselineDiff).toEqual([
      { control: "city", expected: "Lancre", actual: "Quirm" }
    ]);
    expect(source.state.get("name")).toBe("Esme");
  });

  it("rejects plans that contain conflicts without applying anything", () => {
    const applyItems = vi.fn();
    const source = createMemorySource([{ key: "name", value: "Esme" }], { applyItems });
    const plan = createChangePlan(source, { unknown: "x" });

    const result = applyChangePlan(source, plan);

    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("unresolved-conflicts");
    expect(result.conflicts[0]?.conflictCode).toBe(CHANGE_CONFLICT_CODES.unmappedControl);
    expect(applyItems).not.toHaveBeenCalled();
  });

  it("keeps a stable fingerprint regardless of key order", () => {
    const left = fingerprintValue({ a: "1", b: { c: "2" } });
    const right = fingerprintValue({ b: { c: "2" }, a: "1" });

    expect(left).toBe(right);
  });
});

describe("plan id stability", () => {
  it("produces identical ids for identical inputs", () => {
    const first: ChangePlan = planChanges({ a: "1" }, { a: "2" });
    const second: ChangePlan = planChanges({ a: "1" }, { a: "2" });

    expect(first.id).toBe(second.id);
  });
});
