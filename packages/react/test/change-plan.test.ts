// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplyChangePlanResult, ChangePlan } from "@form2js/core";
import {
  useFormChangePlan,
  type UseFormChangePlanResult,
  type UseForm2jsSubmit
} from "../src/index";

const reactActScope = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean;
};
reactActScope.IS_REACT_ACT_ENVIRONMENT = true;

interface MountedHarness {
  root: Root;
  container: HTMLDivElement;
}

const mountedHarnesses: MountedHarness[] = [];

afterEach(() => {
  for (const mounted of mountedHarnesses) {
    act(() => {
      mounted.root.unmount();
    });
    mounted.container.remove();
  }

  mountedHarnesses.length = 0;
});

interface HarnessProps {
  submit: UseForm2jsSubmit;
  onSnapshot: (state: UseFormChangePlanResult) => void;
  onFirstRender?: (state: UseFormChangePlanResult) => void;
}

function Harness(props: HarnessProps): React.ReactElement {
  const state = useFormChangePlan(props.submit);
  const notifiedRef = React.useRef(false);

  props.onSnapshot(state);

  if (!notifiedRef.current && props.onFirstRender) {
    notifiedRef.current = true;
    props.onFirstRender(state);
  }

  return React.createElement(
    "form",
    null,
    React.createElement("input", { name: "person.name", defaultValue: "Esme" }),
    React.createElement("input", { name: "person.city", defaultValue: "Lancre" })
  );
}

function renderHarness(
  submit: UseForm2jsSubmit,
  onFirstRender?: HarnessProps["onFirstRender"]
): {
  form: HTMLFormElement;
  getState: () => UseFormChangePlanResult;
} {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedHarnesses.push({ root, container });

  let latestState: UseFormChangePlanResult | null = null;

  const harnessProps: HarnessProps = {
    submit,
    onSnapshot(state) {
      latestState = state;
    }
  };

  if (onFirstRender) {
    harnessProps.onFirstRender = onFirstRender;
  }

  act(() => {
    root.render(React.createElement(Harness, harnessProps));
  });

  const form = container.querySelector("form");
  if (!form) {
    throw new Error("form not rendered");
  }

  return {
    form,
    getState: () => {
      if (!latestState) {
        throw new Error("hook state not captured");
      }
      return latestState;
    }
  };
}

function holder<T>(initial: T | null = null): { current: T | null } {
  return { current: initial };
}

function unwrap<T>(value: T | null): T {
  if (value === null) {
    throw new Error("expected value to be set");
  }
  return value;
}

describe("useFormChangePlan", () => {
  it("plans without mutating the form and commits through submit once", async () => {
    const submit = vi.fn();
    const { form, getState } = renderHarness(submit);

    const planHolder = holder<ChangePlan>();
    act(() => {
      planHolder.current = getState().createPlan(form, { person: { name: "Tiffany" } });
    });
    const plan = unwrap(planHolder.current);

    expect(plan.items).toEqual([
      expect.objectContaining({ op: "set", path: "person.name", newValue: "Tiffany" })
    ]);

    const nameInput = form.querySelector<HTMLInputElement>('input[name="person.name"]');
    expect(nameInput?.value).toBe("Esme");

    const resultHolder = holder<ApplyChangePlanResult>();
    act(() => {
      resultHolder.current = getState().applyPlan(plan);
    });

    expect(unwrap(resultHolder.current).status).toBe("applied");
    expect(submit).toHaveBeenCalledTimes(1);
    expect(submit).toHaveBeenCalledWith({ person: { name: "Tiffany" } });

    await act(async () => {
      await Promise.resolve();
    });
    expect(getState().isSuccess).toBe(true);
  });

  it("does not trigger the submit callback twice for the same plan", () => {
    const submit = vi.fn();
    const { form, getState } = renderHarness(submit);

    const planHolder = holder<ChangePlan>();
    act(() => {
      planHolder.current = getState().createPlan(form, { person: { name: "Tiffany" } });
    });
    const plan = unwrap(planHolder.current);

    const firstHolder = holder<ApplyChangePlanResult>();
    const secondHolder = holder<ApplyChangePlanResult>();
    act(() => {
      firstHolder.current = getState().applyPlan(plan);
      secondHolder.current = getState().applyPlan(plan);
    });

    expect(unwrap(firstHolder.current).status).toBe("applied");
    expect(unwrap(secondHolder.current).status).toBe("applied");
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("rejects the plan when the form changed after planning", () => {
    const submit = vi.fn();
    const { form, getState } = renderHarness(submit);

    const planHolder = holder<ChangePlan>();
    act(() => {
      planHolder.current = getState().createPlan(form, { person: { name: "Tiffany" } });
    });
    const plan = unwrap(planHolder.current);

    const cityInput = form.querySelector<HTMLInputElement>('input[name="person.city"]');
    if (!cityInput) throw new Error("missing fixture input");
    cityInput.value = "Quirm";

    const resultHolder = holder<ApplyChangePlanResult>();
    act(() => {
      resultHolder.current = getState().applyPlan(plan);
    });
    const result = unwrap(resultHolder.current);

    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("baseline-mismatch");
    expect(result.baselineDiff.length).toBeGreaterThan(0);
    expect(submit).not.toHaveBeenCalled();
  });

  it("refuses to commit while rendering", () => {
    const submit = vi.fn();
    const renderPhaseHolder = holder<ApplyChangePlanResult>();

    renderHarness(submit, (state) => {
      const fakePlan: ChangePlan = {
        id: "plan_render_phase",
        baseline: "f2j_00000000",
        items: [],
        conflicts: [],
        controlSnapshot: {}
      };
      renderPhaseHolder.current = state.applyPlan(fakePlan);
    });

    const result = unwrap(renderPhaseHolder.current);
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("cannot-apply-during-render");
    expect(submit).not.toHaveBeenCalled();
  });
});
