// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  applyFormChanges,
  formToObject,
  planFormChanges
} from "../src/index";
import { CHANGE_CONFLICT_CODES } from "@form2js/core";

function seedForm(): HTMLFormElement {
  document.body.innerHTML = `
    <form id="plan-form">
      <input type="text" name="person.name.first" value="Esme" />
      <input type="text" name="person.name.last" value="Weatherwax" />
      <input type="checkbox" name="person.tags[]" value="witch" checked />
      <input type="checkbox" name="person.tags[]" value="headology" checked />
      <input type="checkbox" name="person.tags[]" value="crime" />
      <input type="radio" name="person.city" value="lancre" checked />
      <input type="radio" name="person.city" value="quirm" />
      <select name="person.guild">
        <option value="witches" selected>witches</option>
        <option value="assassins">assassins</option>
      </select>
      <input type="text" name="person.legacy" value="old" disabled />
    </form>
  `;

  return document.getElementById("plan-form") as HTMLFormElement;
}

describe("planFormChanges", () => {
  it("previews set/append/clear items with associated controls without mutating the DOM", () => {
    const form = seedForm();
    const before = formToObject(form);

    const plan = planFormChanges(form, {
      person: {
        name: { first: "Tiffany", last: "" },
        tags: ["witch", "headology", "crime"],
        city: "quirm",
        guild: "witches"
      }
    });

    expect(plan.items).toEqual([
      expect.objectContaining({ op: "set", path: "person.city", oldValue: "lancre", newValue: "quirm" }),
      expect.objectContaining({ op: "set", path: "person.name.first", oldValue: "Esme", newValue: "Tiffany" }),
      expect.objectContaining({ op: "clear", path: "person.name.last", oldValue: "Weatherwax", newValue: "" }),
      expect.objectContaining({ op: "append", path: "person.tags[2]", newValue: "crime" })
    ]);

    const cityItem = plan.items.find((item) => item.path === "person.city");
    expect(cityItem?.controls).toEqual(["person.city#1", "person.city#2"]);

    const tagsItem = plan.items.find((item) => item.path === "person.tags[2]");
    expect(tagsItem?.controls).toEqual(["person.tags[]#1", "person.tags[]#2", "person.tags[]#3"]);

    expect(formToObject(form)).toEqual(before);
  });

  it("flags values the DOM cannot express as capability conflicts", () => {
    const form = seedForm();
    const plan = planFormChanges(form, {
      person: { name: { first: { nested: "object" } } }
    });

    expect(plan.conflicts.length).toBeGreaterThan(0);
    expect(plan.conflicts[0]?.conflictCode).toBe(CHANGE_CONFLICT_CODES.typeMismatch);
  });

  it("flags prototype pollution paths as conflicts", () => {
    const form = seedForm();
    const target = JSON.parse('{"__proto__": {"polluted": "yes"}}') as unknown;
    const plan = planFormChanges(form, target);

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.conflictCode).toBe(CHANGE_CONFLICT_CODES.unsafePath);
  });

  it("flags target paths with no matching control", () => {
    const form = seedForm();
    const plan = planFormChanges(form, { person: { nickname: "Tiff" } });

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      path: "person.nickname",
      conflictCode: CHANGE_CONFLICT_CODES.unmappedControl
    });
  });
});

describe("applyFormChanges", () => {
  it("applies a clean plan atomically and updates checkbox/radio groups", () => {
    const form = seedForm();
    const plan = planFormChanges(form, {
      person: {
        name: { first: "Tiffany", last: "" },
        tags: ["crime"],
        city: "quirm",
        guild: "assassins"
      }
    });

    const result = applyFormChanges(form, plan);

    expect(result.status).toBe("applied");
    expect(formToObject(form)).toEqual({
      person: {
        name: { first: "Tiffany" },
        tags: ["crime"],
        city: "quirm",
        guild: "assassins"
      }
    });
  });

  it("rejects the whole plan when any control changed since planning", () => {
    const form = seedForm();
    const plan = planFormChanges(form, { person: { name: { first: "Tiffany" } } });

    const lastNameInput = form.querySelector<HTMLInputElement>('input[name="person.name.last"]');
    if (!lastNameInput) throw new Error("missing fixture input");
    lastNameInput.value = "Ogg";

    const result = applyFormChanges(form, plan);

    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("baseline-mismatch");
    expect(result.baselineDiff).toEqual([
      { control: "person.name.last", expected: "value:Weatherwax", actual: "value:Ogg" }
    ]);

    const firstNameInput = form.querySelector<HTMLInputElement>('input[name="person.name.first"]');
    expect(firstNameInput?.value).toBe("Esme");
  });

  it("returns the first result when the same plan is applied twice", () => {
    const form = seedForm();
    const plan = planFormChanges(form, {
      person: { tags: ["witch", "headology", "crime"] }
    });

    const first = applyFormChanges(form, plan);
    const second = applyFormChanges(form, plan);

    expect(first.status).toBe("applied");
    expect(second).toBe(first);
    expect(formToObject(form)).toEqual({
      person: {
        name: { first: "Esme", last: "Weatherwax" },
        tags: ["witch", "headology", "crime"],
        city: "lancre",
        guild: "witches"
      }
    });
  });

  it("refuses plans with conflicts and leaves the DOM untouched", () => {
    const form = seedForm();
    const before = formToObject(form);
    const plan = planFormChanges(form, { person: { nickname: "Tiff" } });

    const result = applyFormChanges(form, plan);

    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("unresolved-conflicts");
    expect(formToObject(form)).toEqual(before);
  });
});
