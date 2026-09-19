// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import {
  createChangePlan,
  createObjectPlanAdapter,
  type ChangePlan
} from "@form2js/core";
import { createDomChangePlan, applyDomChangePlan } from "@form2js/dom";
import { createFormDataChangePlan } from "@form2js/form-data";
import { createFormChangePlan } from "@form2js/js2form";

const FORM_MARKUP = `
  <form id="cross-adapter-form">
    <input name="person.name.first" value="Esme" />
    <input name="person.name.last" value="Weatherwax" />
    <input type="checkbox" name="person.tags[]" value="witch" checked />
    <input type="checkbox" name="person.tags[]" value="headology" checked />
    <input type="radio" name="person.rank" value="novice" checked />
    <input type="radio" name="person.rank" value="witch" />
    <select name="person.city">
      <option value="lancre" selected>lancre</option>
      <option value="quirm">quirm</option>
    </select>
    <input name="leftover" value="x" disabled />
  </form>
`;

describe("integration: adapter-neutral change plans", () => {
  it("resolves the same canonical paths across object, DOM, FormData and js2form entry points", () => {
    document.body.innerHTML = FORM_MARKUP;
    const form = document.getElementById("cross-adapter-form") as HTMLFormElement;

    const target = {
      person: {
        name: { first: "Tiffany", last: "Aching" },
        tags: ["witch"],
        rank: "witch",
        city: "quirm"
      }
    };

    const domPlan = createDomChangePlan(form, target);
    const js2formPlan = createFormChangePlan(form, target);
    const formData = new FormData(form);
    formData.delete("leftover");
    const formDataPlan = createFormDataChangePlan(formData, target);
    const objectPlan = createChangePlan(
      createObjectPlanAdapter({
        person: {
          name: { first: "Esme", last: "Weatherwax" },
          tags: ["witch", "headology"],
          rank: "novice",
          city: "lancre"
        },
        leftover: "x"
      }),
      target,
      { allowMissingControls: true }
    );

    const paths = (plan: ChangePlan): string[] => plan.changes.map((item) => item.path).sort();
    expect(paths(js2formPlan)).toEqual(paths(domPlan));
    expect(paths(formDataPlan)).toEqual(paths(domPlan));

    const objectPaths = paths(objectPlan);
    expect(objectPaths).toContain("person.name.first");
    expect(objectPaths.some((itemPath) => itemPath.startsWith("person.tags"))).toBe(true);

    const domPathSet = new Set(domPlan.changes.map((item) => item.path));
    expect(domPathSet.has("person.name.first")).toBe(true);
    expect(domPathSet.has("person.tags")).toBe(true);
  });

  it("assigns identical conflict ids and codes for identical DOM plans", () => {
    document.body.innerHTML = `
      <form id="conflict-form">
        <input name="item" value="flat" />
        <input type="file" name="avatar" />
      </form>
    `;
    const form = document.getElementById("conflict-form") as HTMLFormElement;
    const target = { item: { nested: "deep" }, avatar: "not-a-file" };

    const first = createDomChangePlan(form, target);
    const second = createDomChangePlan(form, target);

    expect(second.conflicts.map((c) => c.id)).toEqual(first.conflicts.map((c) => c.id));
    expect(first.conflicts.map((c) => c.code).sort()).toEqual(["capability", "shape"]);
    expect(first.conflicts[0]?.id).toMatch(/^C\d{3}$/);
  });

  it("applies a DOM plan atomically and refuses a second application after baseline rejection", () => {
    document.body.innerHTML = FORM_MARKUP;
    const form = document.getElementById("cross-adapter-form") as HTMLFormElement;
    const plan = createDomChangePlan(form, {
      person: {
        name: { first: "Tiffany", last: "Aching" },
        tags: ["witch"],
        rank: "witch",
        city: "quirm"
      }
    });

    const first = applyDomChangePlan(form, plan);
    const second = applyDomChangePlan(form, plan);
    expect(first.status).toBe("applied");
    expect(second).toBe(first);
  });

  it("flags unsafe paths for every adapter consistently", () => {
    document.body.innerHTML = `<form id="unsafe-form"><input name="safe" value="1" /></form>`;
    const form = document.getElementById("unsafe-form") as HTMLFormElement;
    const unsafeTarget = JSON.parse('{"__proto__":{"polluted":true}}');

    const domPlan = createDomChangePlan(form, unsafeTarget);
    const formDataPlan = createFormDataChangePlan(new FormData(form), unsafeTarget);
    const objectPlan = createChangePlan(createObjectPlanAdapter({ safe: "1" }), unsafeTarget);

    for (const plan of [domPlan, formDataPlan, objectPlan]) {
      expect(plan.conflicts.some((c) => c.code === "unsafe-path")).toBe(true);
    }

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("integration: empty string and missing values", () => {
  it("treats empty string and null as clear and missing paths as clear too", () => {
    document.body.innerHTML = `
      <form id="empty-form">
        <input name="a" value="x" />
        <input name="b" value="y" />
        <input name="c" value="z" />
      </form>
    `;
    const form = document.getElementById("empty-form") as HTMLFormElement;

    const domPlan = createDomChangePlan(form, { a: "", b: null });
    const kinds = Object.fromEntries(
      domPlan.changes.map((item) => [item.path, item.kind])
    );
    expect(kinds.a).toBe("clear");
    expect(kinds.b).toBe("clear");
    expect(kinds.c).toBe("clear");

    const aChange = domPlan.changes.find((item) => item.path === "a");
    const bChange = domPlan.changes.find((item) => item.path === "b");
    expect(aChange?.newValue).toBe("");
    expect(bChange?.newValue).toBeNull();
  });
});
