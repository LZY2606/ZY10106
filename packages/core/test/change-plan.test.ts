import { describe, expect, it } from "vitest";
import {
  applyChangePlan,
  createChangePlan,
  createObjectPlanAdapter,
  verifyPlanBaseline
} from "../src/index";

function planFor(source: unknown, target: unknown, options?: { allowMissingControls?: boolean; allowUnsafePathSegments?: boolean }) {
  const draft = JSON.parse(JSON.stringify(source)) as typeof source;
  const adapter = createObjectPlanAdapter(draft as Record<string, unknown>);
  const plan = createChangePlan(adapter, target, options);
  return { draft, adapter, plan };
}

describe("change plan", () => {
  it("lists stable sorted set/append/remove/clear items with old and new values", () => {
    const { plan } = planFor(
      {
        person: { city: "lancre", name: { first: "Esme", last: "Weatherwax" } },
        tags: ["a", "b"],
        gone: "x"
      },
      {
        person: { city: "quirm", name: { first: "Tiffany", last: "Aching" } },
        tags: ["a", "c", "d"]
      }
    );

    expect(plan.changes.map((item) => `${item.kind}:${item.path}`)).toEqual([
      "clear:gone",
      "set:person.city",
      "set:person.name.first",
      "set:person.name.last",
      "set:tags[1]",
      "append:tags[2]"
    ]);

    const city = plan.changes.find((item) => item.path === "person.city");
    expect(city).toMatchObject({ oldValue: "lancre", newValue: "quirm", lossless: true });
    expect(city?.controls[0]?.adapter).toBe("object");
  });

  it("does not mutate the source while computing the plan", () => {
    const source = { name: "Esme", tags: ["a"] };
    const adapter = createObjectPlanAdapter(source);
    createChangePlan(adapter, { name: "Tiffany", tags: ["a", "b"] });
    expect(source).toEqual({ name: "Esme", tags: ["a"] });
  });

  it("applies every change when no conflicts exist and baseline is intact", () => {
    const source = { name: "Esme", tags: ["a", "b"] };
    const adapter = createObjectPlanAdapter(source);
    const plan = createChangePlan(adapter, { name: "Tiffany", tags: ["a", "c", "d"] });
    const result = applyChangePlan(createObjectPlanAdapter(source), plan);

    expect(result.status).toBe("applied");
    expect(source).toEqual({ name: "Tiffany", tags: ["a", "c", "d"] });
  });

  it("returns the cached first result when applying twice (no duplicate appends)", () => {
    const source = { tags: ["a"] };
    const adapter = createObjectPlanAdapter(source);
    const plan = createChangePlan(adapter, { tags: ["a", "b", "c"] });
    const first = applyChangePlan(createObjectPlanAdapter(source), plan);
    const second = applyChangePlan(createObjectPlanAdapter(source), plan);

    expect(second).toBe(first);
    expect(source.tags).toEqual(["a", "b", "c"]);
  });

  it("rejects the whole plan and reports diffs when the baseline moved", () => {
    const source = { name: "Esme" };
    const plan = createChangePlan(createObjectPlanAdapter(source), { name: "Tiffany" });

    source.name = "Granny";

    const outcome = applyChangePlan(createObjectPlanAdapter(source), plan);
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("expected rejection");
    expect(outcome.reason).toBe("baseline-changed");
    expect(outcome.baselineDiffs?.[0]?.path).toBe("name");
    expect(source.name).toBe("Granny");
  });

  it("never partially applies when conflicts exist", () => {
    const source = { a: "1", b: "2" };
    const plan = createChangePlan(
      createObjectPlanAdapter(source, { canCreatePaths: false }),
      { a: "9", extra: "x" }
    );
    expect(plan.conflicts.length).toBeGreaterThan(0);

    const outcome = applyChangePlan(createObjectPlanAdapter(source), plan);
    expect(outcome.status).toBe("rejected");
    expect(source.a).toBe("1");
    expect(source.b).toBe("2");
  });

  it("flags target paths without an associated control as no-control conflicts", () => {
    const draft = { name: "a" };
    const plan = createChangePlan(
      createObjectPlanAdapter(draft, { canCreatePaths: false }),
      { name: "b", fresh: "x" }
    );
    expect(plan.conflicts.map((c) => c.code)).toContain("no-control");
  });

  it("flags prototype-pollution paths as unsafe-path conflicts", () => {
    const plan = createChangePlan(
      createObjectPlanAdapter({}),
      JSON.parse('{"__proto__":{"polluted":1},"nested":{"constructor":{"x":1}}}')
    );

    const codes = plan.conflicts.map((c) => `${c.code}@${c.path}`);
    expect(codes).toContain("unsafe-path@__proto__.polluted");
    expect(codes).toContain("unsafe-path@nested.constructor.x");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("produces identical conflict ids for identical inputs (deterministic numbering)", () => {
    const build = () =>
      createChangePlan(
        createObjectPlanAdapter({ a: 1 }, { canCreatePaths: false }),
        { a: 2, b: 3, c: { d: 4 } }
      );
    const first = build();
    const second = build();
    expect(second.conflicts.map((c) => c.id)).toEqual(first.conflicts.map((c) => c.id));
    expect(first.conflicts[0]?.id).toBe("C001");
  });

  it("distinguishes empty string clear from missing-path remove/clear", () => {
    const source = { a: "x", b: "y", c: "z" };
    const plan = createChangePlan(
      createObjectPlanAdapter(source),
      { a: "", b: null },
      { allowMissingControls: true }
    );

    const a = plan.changes.find((item) => item.path === "a");
    const b = plan.changes.find((item) => item.path === "b");
    const c = plan.changes.find((item) => item.path === "c");
    expect(a?.kind).toBe("clear");
    expect(a?.newValue).toBe("");
    expect(b?.kind).toBe("clear");
    expect(b?.newValue).toBeNull();
    expect(c?.kind).toBe("clear");
  });

  it("reports shape conflicts between scalar current and container target", () => {
    const plan = createChangePlan(
      createObjectPlanAdapter({ item: "flat" }),
      { item: { nested: "deep" } }
    );
    expect(plan.conflicts.some((c) => c.code === "shape" && c.path === "item")).toBe(true);
  });

  it("verifies baseline directly via verifyPlanBaseline", () => {
    const source = { a: "1" };
    const adapter = createObjectPlanAdapter(source);
    const plan = createChangePlan(adapter, { a: "2" });
    expect(verifyPlanBaseline(createObjectPlanAdapter(source), plan)).toEqual([]);
    source.a = "3";
    expect(verifyPlanBaseline(createObjectPlanAdapter(source), plan)).toHaveLength(1);
  });
});

describe("change plan commit callback", () => {
  it("fires onApplied exactly once across repeated apply calls", () => {
    const source = { name: "Esme" };
    let callbackCount = 0;
    const adapter = createObjectPlanAdapter(source);
    adapter.onApplied = () => {
      callbackCount += 1;
    };

    const plan = createChangePlan(adapter, { name: "Tiffany" });
    applyChangePlan(adapter, plan);
    applyChangePlan(adapter, plan);
    applyChangePlan(adapter, plan);

    expect(callbackCount).toBe(1);
  });
});
