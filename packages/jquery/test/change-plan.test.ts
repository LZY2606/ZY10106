// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import type { ApplyChangePlanResult, ChangePlan } from "@form2js/dom";
import { installToObjectPlugin } from "../src/index";

type StubCollection = {
  length: number;
  get(index: number): Element | undefined;
  each(callback: (this: Element, index: number, element: Element) => void): StubCollection;
  planChanges?: (target: unknown, options?: { mode?: string }) => ChangePlan;
  applyChanges?: (plan: ChangePlan, options?: { mode?: string }) => ApplyChangePlanResult;
};

type SelectorInput = string | Element | Element[];

type StubJQuery = ((input: SelectorInput) => StubCollection) & {
  fn: Record<string, unknown>;
};

function createCollection(elements: Element[], fn: Record<string, unknown>): StubCollection {
  const collection: StubCollection = {
    length: elements.length,
    get(index: number): Element | undefined {
      return elements[index];
    },
    each(callback) {
      for (let index = 0; index < elements.length; index += 1) {
        const element = elements[index];
        if (element) {
          callback.call(element, index, element);
        }
      }
      return this;
    }
  };

  Object.setPrototypeOf(collection, fn);
  return collection;
}

function createStubJQuery(): StubJQuery {
  const fn: Record<string, unknown> = {};

  const $ = ((input: SelectorInput): StubCollection => {
    if (typeof input === "string") {
      return createCollection(Array.from(document.querySelectorAll(input)), fn);
    }

    if (Array.isArray(input)) {
      return createCollection(input, fn);
    }

    return createCollection([input], fn);
  }) as StubJQuery;

  $.fn = fn;
  return $;
}

function seedForm(): void {
  document.body.innerHTML = `
    <form id="jq-plan-form">
      <input type="text" name="person.first" value="Esme" />
      <input type="text" name="person.last" value="Weatherwax" />
    </form>
  `;
}

describe("jQuery change plan plugin", () => {
  it("plans and applies changes through the baseline-checked dom adapter", () => {
    seedForm();
    const $ = createStubJQuery();
    installToObjectPlugin($);

    const plan = $("#jq-plan-form").planChanges?.({ person: { first: "Tiffany" } });
    expect(plan).toBeDefined();
    expect(plan?.items).toEqual([
      expect.objectContaining({ op: "set", path: "person.first", newValue: "Tiffany" })
    ]);

    const result = $("#jq-plan-form").applyChanges?.(plan as ChangePlan);
    expect(result?.status).toBe("applied");

    const input = document.querySelector<HTMLInputElement>('input[name="person.first"]');
    expect(input?.value).toBe("Tiffany");
  });

  it("cannot bypass the baseline check through the wrapper", () => {
    seedForm();
    const $ = createStubJQuery();
    installToObjectPlugin($);

    const plan = $("#jq-plan-form").planChanges?.({ person: { first: "Tiffany" } }) as ChangePlan;

    const lastInput = document.querySelector<HTMLInputElement>('input[name="person.last"]');
    if (!lastInput) throw new Error("missing fixture input");
    lastInput.value = "Ogg";

    const result = $("#jq-plan-form").applyChanges?.(plan);

    expect(result?.status).toBe("rejected");
    expect(result?.reason).toBe("baseline-mismatch");
    expect(result?.baselineDiff.length).toBeGreaterThan(0);

    const firstInput = document.querySelector<HTMLInputElement>('input[name="person.first"]');
    expect(firstInput?.value).toBe("Esme");
  });

  it("returns the first result when the same plan is applied twice", () => {
    seedForm();
    const $ = createStubJQuery();
    installToObjectPlugin($);

    const plan = $("#jq-plan-form").planChanges?.({ person: { first: "Tiffany" } }) as ChangePlan;
    const first = $("#jq-plan-form").applyChanges?.(plan);
    const second = $("#jq-plan-form").applyChanges?.(plan);

    expect(first?.status).toBe("applied");
    expect(second).toBe(first);
  });
});
