// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { installToObjectPlugin, maybeAutoInstallPlugin } from "../src/index";

type ToObjectOptions = {
  mode?: "first" | "all" | "combine";
  delimiter?: string;
  skipEmpty?: boolean;
  allowUnsafePathSegments?: boolean;
  useIdIfEmptyName?: boolean;
  getDisabled?: boolean;
  nodeCallback?: (node: Node) => { name?: string; key?: string; value: unknown } | false;
};

type ToObjectResult = unknown;

type ChangeItemLike = { path: string };

type ChangePlanLike = {
  changes: ChangeItemLike[];
  conflicts: unknown[];
  status: string;
};

type PlanOutcomeLike =
  | { status: "applied"; changes: unknown[] }
  | { status: "rejected"; reason: string; baselineDiffs?: unknown[]; conflicts?: unknown[] };

type StubCollection = {
  length: number;
  get(index: number): Element | undefined;
  each(callback: (this: Element, index: number, element: Element) => void): StubCollection;
  toObject?: (options?: ToObjectOptions) => ToObjectResult;
  previewChangePlan?: (target: unknown, options?: unknown) => ChangePlanLike;
  applyChangePlan?: (plan: ChangePlanLike) => PlanOutcomeLike;
  commitChangePlan?: (target: unknown, options?: unknown) => PlanOutcomeLike;
};

type SelectorInput = string | Element | Element[];

type StubJQuery = ((input: SelectorInput) => StubCollection) & {
  fn: Record<string, unknown>;
  extend(target: object, ...sources: object[]): object;
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
  $.extend = (target, ...sources) => {
    Object.assign(target, ...sources);
    return target;
  };
  return $;
}

describe("installToObjectPlugin", () => {
  it("supports legacy first/all/combine modes", () => {
    document.body.innerHTML = `
      <form class="part" id="f1"><input name="person.first" value="Neo" /></form>
      <form class="part" id="f2"><input name="person.last" value="Anderson" /></form>
    `;

    const $ = createStubJQuery();
    installToObjectPlugin($);

    const first = $(".part").toObject?.({ mode: "first" });
    const all = $(".part").toObject?.({ mode: "all" });
    const combine = $(".part").toObject?.({ mode: "combine" });

    expect(first).toEqual({ person: { first: "Neo" } });
    expect(all).toEqual([{ person: { first: "Neo" } }, { person: { last: "Anderson" } }]);
    expect(combine).toEqual({ person: { first: "Neo", last: "Anderson" } });
  });

  it("can be auto-installed", () => {
    const $ = createStubJQuery();
    maybeAutoInstallPlugin($);

    expect(typeof $.fn.toObject).toBe("function");
  });

  it("forwards parsing options through the plugin", () => {
    document.body.innerHTML = `
      <form id="profile">
        <input id="person/name" name="" value="Neo" />
        <input id="person/nickname" name="" value="" />
        <input id="person/role" name="" value="captain" disabled />
      </form>
    `;

    const $ = createStubJQuery();
    installToObjectPlugin($);

    const result = $("#profile").toObject?.({
      delimiter: "/",
      skipEmpty: false,
      useIdIfEmptyName: true,
      getDisabled: true
    });

    expect(result).toEqual({
      person: {
        name: "Neo",
        nickname: "",
        role: "captain"
      }
    });
  });

  it("forwards nodeCallback and allowUnsafePathSegments through the plugin", () => {
    document.body.innerHTML = `
      <form id="unsafe">
        <div id="profile.callback">hello world</div>
        <input name="__proto__.polluted" value="yes" />
      </form>
    `;

    const $ = createStubJQuery();
    installToObjectPlugin($);

    const result = $("#unsafe").toObject?.({
      allowUnsafePathSegments: true,
      nodeCallback(node) {
        if (node instanceof HTMLDivElement && node.id === "profile.callback") {
          return { name: node.id, value: node.textContent };
        }

        return false;
      }
    }) as { profile: { callback: string } } & Record<string, unknown>;

    expect(result.profile.callback).toBe("hello world");
    expect(result.__proto__).toEqual({ polluted: "yes" });
  });
});

describe("standalone entry", () => {
  it("auto-installs plugin from global jQuery", async () => {
    const $ = createStubJQuery();
    const scope = globalThis as typeof globalThis & { jQuery?: StubJQuery };

    scope.jQuery = $;
    await import("../src/standalone");

    expect(typeof $.fn.toObject).toBe("function");
  });
});

describe("change plan plugin", () => {
  interface PlanHarness {
    form: HTMLFormElement;
    preview: (target: unknown) => ChangePlanLike;
    apply: (plan: ChangePlanLike) => PlanOutcomeLike;
    commit: (target: unknown) => PlanOutcomeLike;
  }

  function setup(): PlanHarness {
    document.body.innerHTML = `
      <form id="plan-form">
        <input name="name" value="Esme" />
        <input name="tags[0]" value="a" />
        <input name="tags[1]" value="b" />
      </form>
    `;

    const form = document.getElementById("plan-form") as HTMLFormElement;
    const fn: Record<string, unknown> = {};
    const fakeJQuery = function fakeJQuery(): StubCollection {
      return createCollection([form], fn);
    } as unknown as StubJQuery;
    fakeJQuery.fn = fn;
    fakeJQuery.extend = Object.assign;
    installToObjectPlugin(fakeJQuery);

    const collection = (): StubCollection => fakeJQuery(form);
    return {
      form,
      preview: (target: unknown): ChangePlanLike => {
        const previewFn = collection().previewChangePlan;
        if (!previewFn) {
          throw new Error("previewChangePlan plugin missing");
        }
        return previewFn.call(collection(), target);
      },
      apply: (plan: ChangePlanLike): PlanOutcomeLike => {
        const applyFn = collection().applyChangePlan;
        if (!applyFn) {
          throw new Error("applyChangePlan plugin missing");
        }
        return applyFn.call(collection(), plan);
      },
      commit: (target: unknown): PlanOutcomeLike => {
        const commitFn = collection().commitChangePlan;
        if (!commitFn) {
          throw new Error("commitChangePlan plugin missing");
        }
        return commitFn.call(collection(), target);
      }
    };
  }

  it("exposes previewChangePlan/applyChangePlan that honor baseline checks", () => {
    const harness = setup();
    const plan = harness.preview({ name: "Tiffany", tags: ["a", "c"] });
    expect(plan.changes.some((item) => item.path === "name")).toBe(true);

    const outcome = harness.apply(plan);
    expect(outcome.status).toBe("applied");

    const input = harness.form.querySelector('input[name="name"]') as HTMLInputElement;
    expect(input.value).toBe("Tiffany");
  });

  it("commitChangePlan previews and applies in one call", () => {
    const harness = setup();
    const outcome = harness.commit({ name: "Granny", tags: ["a", "b"] });
    expect(outcome.status).toBe("applied");
  });

  it("rejects when the form changed between preview and apply", () => {
    const harness = setup();
    const plan = harness.preview({ name: "Tiffany", tags: ["a", "b"] });
    const input = harness.form.querySelector('input[name="name"]') as HTMLInputElement;
    input.value = "Changed by user";

    const outcome = harness.apply(plan);
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("expected rejection");
    expect(outcome.reason).toBe("baseline-changed");
  });
});
