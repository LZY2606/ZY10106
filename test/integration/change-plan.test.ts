// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { CHANGE_CONFLICT_CODES, planChanges } from "@form2js/core";
import { applyFormChanges, formToObject, planFormChanges } from "@form2js/dom";
import { applyFormDataChanges, formDataToObject, planFormDataChanges } from "@form2js/form-data";
import { applyObjectToForm, planObjectToForm } from "@form2js/js2form";

describe("integration: adapter-neutral change plans", () => {
  it("previews and applies a write-back plan across dom and js2form adapters", () => {
    document.body.innerHTML = `
      <form id="plan-flow">
        <input name="person.name.first" value="Neo" />
        <input type="checkbox" name="person.roles[]" value="admin" checked />
        <input type="checkbox" name="person.roles[]" value="operator" />
      </form>
    `;
    const form = document.getElementById("plan-flow") as HTMLFormElement;

    const target = {
      person: { name: { first: "Trinity" }, roles: ["admin", "operator"] }
    };

    const domPlan = planFormChanges(form, target);
    const js2formPlan = planObjectToForm(form, target);

    expect(domPlan.items.map((item) => `${item.op}:${item.path}`)).toEqual(
      js2formPlan.items.map((item) => `${item.op}:${item.path}`)
    );
    expect(formToObject(form)).toEqual({
      person: { name: { first: "Neo" }, roles: ["admin"] }
    });

    const result = applyFormChanges(form, domPlan);
    expect(result.status).toBe("applied");
    expect(formToObject(form)).toEqual({
      person: { name: { first: "Trinity" }, roles: ["admin", "operator"] }
    });

    const repeat = applyObjectToForm(form, domPlan);
    expect(repeat.status).toBe("applied");
    expect(formToObject(form)).toEqual({
      person: { name: { first: "Trinity" }, roles: ["admin", "operator"] }
    });
  });

  it("rejects a stale plan when a control changed after the preview", () => {
    document.body.innerHTML = `
      <form id="stale-flow">
        <input name="person.name" value="Neo" />
        <input name="person.city" value="Zion" />
      </form>
    `;
    const form = document.getElementById("stale-flow") as HTMLFormElement;

    const plan = planFormChanges(form, { person: { name: "Trinity" } });
    (form.querySelector('input[name="person.city"]') as HTMLInputElement).value = "IO";

    const result = applyFormChanges(form, plan);

    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("baseline-mismatch");
    expect(result.baselineDiff).toEqual([
      { control: "person.city", expected: "value:Zion", actual: "value:IO" }
    ]);
    expect((form.querySelector('input[name="person.name"]') as HTMLInputElement).value).toBe("Neo");
  });

  it("keeps conflict numbering identical across core, dom, form-data, and js2form", () => {
    document.body.innerHTML = `<form id="conflict-flow"><input name="safe" value="1" /></form>`;
    const form = document.getElementById("conflict-flow") as HTMLFormElement;
    const formData = new FormData();
    formData.append("safe", "1");

    const unsafeTarget = JSON.parse('{"__proto__": {"polluted": "yes"}}') as unknown;

    const corePlan = planChanges({}, unsafeTarget);
    const domPlan = planFormChanges(form, unsafeTarget);
    const formDataPlan = planFormDataChanges(formData, unsafeTarget);
    const js2formPlan = planObjectToForm(form, unsafeTarget);

    for (const plan of [corePlan, domPlan, formDataPlan, js2formPlan]) {
      expect(plan.conflicts).toHaveLength(1);
      expect(plan.conflicts[0]?.conflictCode).toBe(CHANGE_CONFLICT_CODES.unsafePath);
      expect(plan.conflicts[0]?.path).toBe("__proto__.polluted");
    }

    const appliedFormData = applyFormDataChanges(formData, formDataPlan);
    expect(appliedFormData.status).toBe("rejected");
    expect(formDataToObject(formData)).toEqual({ safe: "1" });
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
