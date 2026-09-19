// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { CHANGE_CONFLICT_CODES } from "@form2js/core";
import { formToObject } from "@form2js/dom";
import { applyObjectToForm, planObjectToForm } from "../src/index";

function seedForm(): HTMLFormElement {
  document.body.innerHTML = `
    <form id="j2f-plan-form">
      <input type="text" name="person.name.first" value="Esme" />
      <input type="text" name="person.name.last" value="Weatherwax" />
      <input type="checkbox" name="person.tags[]" value="witch" checked />
      <input type="checkbox" name="person.tags[]" value="headology" />
    </form>
  `;

  return document.getElementById("j2f-plan-form") as HTMLFormElement;
}

describe("planObjectToForm", () => {
  it("previews a write-back plan without mutating the form", () => {
    const form = seedForm();
    const before = formToObject(form);

    const plan = planObjectToForm(form, {
      person: { name: { first: "Tiffany" }, tags: ["witch", "headology"] }
    });

    expect(plan.items).toEqual([
      expect.objectContaining({ op: "set", path: "person.name.first", newValue: "Tiffany" }),
      expect.objectContaining({ op: "append", path: "person.tags[1]", newValue: "headology" })
    ]);
    expect(formToObject(form)).toEqual(before);
  });

  it("shares core conflict numbering with the other adapters", () => {
    const form = seedForm();
    const target = JSON.parse('{"__proto__": {"polluted": "yes"}}') as unknown;
    const plan = planObjectToForm(form, target);

    expect(plan.conflicts[0]?.conflictCode).toBe(CHANGE_CONFLICT_CODES.unsafePath);
  });
});

describe("applyObjectToForm", () => {
  it("applies a previewed plan once the baseline is verified", () => {
    const form = seedForm();
    const plan = planObjectToForm(form, {
      person: { name: { first: "Tiffany", last: "Aching" }, tags: ["headology"] }
    });

    const result = applyObjectToForm(form, plan);

    expect(result.status).toBe("applied");
    expect(formToObject(form)).toEqual({
      person: { name: { first: "Tiffany", last: "Aching" }, tags: ["headology"] }
    });
  });

  it("rejects the plan when the form changed after the preview", () => {
    const form = seedForm();
    const plan = planObjectToForm(form, { person: { name: { first: "Tiffany" } } });

    const lastNameInput = form.querySelector<HTMLInputElement>('input[name="person.name.last"]');
    if (!lastNameInput) throw new Error("missing fixture input");
    lastNameInput.value = "Ogg";

    const result = applyObjectToForm(form, plan);

    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("baseline-mismatch");
    expect(result.baselineDiff.length).toBeGreaterThan(0);

    const firstNameInput = form.querySelector<HTMLInputElement>('input[name="person.name.first"]');
    expect(firstNameInput?.value).toBe("Esme");
  });

  it("returns the first result on repeated application", () => {
    const form = seedForm();
    const plan = planObjectToForm(form, {
      person: { tags: ["witch", "headology"] }
    });

    const first = applyObjectToForm(form, plan);
    const second = applyObjectToForm(form, plan);

    expect(first.status).toBe("applied");
    expect(second).toBe(first);
    expect(formToObject(form)).toEqual({
      person: {
        name: { first: "Esme", last: "Weatherwax" },
        tags: ["witch", "headology"]
      }
    });
  });
});
