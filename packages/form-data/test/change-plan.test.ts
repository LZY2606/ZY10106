// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  applyFormDataChangePlan,
  commitFormDataChangePlan,
  createFormDataChangePlan,
  createFormDataPlanAdapter
} from "../src/plan";

describe("FormData change plan", () => {
  it("computes sets, repeated-key appends and removes without touching FormData", () => {
    const formData = new FormData();
    formData.append("person.name", "Esme");
    formData.append("tags[]", "a");
    formData.append("tags[]", "b");

    const plan = createFormDataChangePlan(
      formData,
      { "person.name": "Tiffany", "tags[]": ["a", "c"] }
    );

    expect(formData.get("person.name")).toBe("Esme");
    const kinds = plan.changes.map((item) => `${item.kind}:${item.path}`);
    expect(kinds).toContain("set:person.name");
  });

  it("preserves File values losslessly and flags number/object values as capability conflicts", () => {
    const formData = new FormData();
    formData.append("avatar", new File(["x"], "a.png"));
    formData.append("name", "x");

    const file = new File(["y"], "b.png");
    const plan = createFormDataChangePlan(formData, { avatar: file, name: 42 });
    expect(plan.conflicts.some((c) => c.code === "capability" && c.path === "name")).toBe(true);
    expect(plan.changes.some((c) => c.path === "avatar" && c.lossless)).toBe(true);
  });

  it("rebuilds FormData on commit", () => {
    const source = new FormData();
    source.append("a", "1");
    source.append("b", "x");

    const outcome = commitFormDataChangePlan(source, { a: "2", c: "new" });
    expect(outcome.status).toBe("applied");
    if (outcome.status !== "applied") throw new Error("expected applied");

    const result = outcome.result as unknown as FormData;
    expect(result.get("a")).toBe("2");
    expect(result.get("c")).toBe("new");
    expect(result.has("b")).toBe(false);
  });

  it("exposes an adapter that reports virtual controls", () => {
    const formData = new FormData();
    formData.append("name", "x");
    const adapter = createFormDataPlanAdapter(formData);
    expect(adapter.controls()[0]?.path).toBe("name");
    expect(adapter.canCreatePaths).toBe(true);
  });

  it("rejects repeated apply without duplicating entries", () => {
    const source = new FormData();
    source.append("tags[]", "a");
    const plan = createFormDataChangePlan(source, { "tags[]": ["a", "b"] });
    const first = applyFormDataChangePlan(source, plan);
    const second = applyFormDataChangePlan(source, plan);
    expect(second).toBe(first);
  });
});
