// @vitest-environment jsdom

import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useChangePlan } from "../src/use-change-plan";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface HarnessHandle {
  preview: (target: unknown) => unknown;
  apply: (plan: unknown) => unknown;
  previewAndApply: (target: unknown) => unknown;
  request: () => unknown;
  latestRequest: { current: unknown };
}

interface Mounted {
  root: Root;
  container: HTMLDivElement;
}

const mounted: Mounted[] = [];

afterEach(() => {
  for (const item of mounted) {
    act(() => item.root.unmount());
    item.container.remove();
  }
  mounted.length = 0;
});

function renderHarness(renderBody: (handle: HarnessHandle) => void): {
  handle: HarnessHandle;
  form: HTMLFormElement;
} {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  mounted.push({ root, container });

  const handle: HarnessHandle = {
    preview: () => null,
    apply: () => null,
    previewAndApply: () => null,
    request: () => null,
    latestRequest: { current: { status: "idle" } }
  };

  function Harness(): React.ReactElement {
    const formRef = React.useRef<HTMLFormElement>(null);
    const state = useChangePlan(formRef);

    handle.preview = state.preview;
    handle.apply = state.apply;
    handle.previewAndApply = state.previewAndApply;
    handle.request = () => state.request;
    handle.latestRequest.current = state.request;

    renderBody(handle);

    return React.createElement(
      "form",
      { ref: formRef },
      React.createElement("input", { name: "person.name", defaultValue: "Esme" }),
      React.createElement("input", {
        type: "checkbox",
        name: "tags[]",
        value: "witch",
        defaultChecked: true
      }),
      React.createElement("input", {
        type: "checkbox",
        name: "tags[]",
        value: "headology",
        defaultChecked: true
      })
    );
  }

  act(() => {
    root.render(React.createElement(Harness));
  });

  const form = container.querySelector("form") as HTMLFormElement;
  return { handle, form };
}

describe("useChangePlan", () => {
  it("previews a plan without mutating the form", () => {
    const { handle, form } = renderHarness(() => undefined);
    const input = form.querySelector('input[name="person.name"]') as HTMLInputElement;
    let plan: unknown;
    act(() => {
      plan = handle.preview({ person: { name: "Tiffany" }, tags: ["witch"] });
    });
    expect(input.value).toBe("Esme");
    expect((plan as { changes: unknown[] }).changes.length).toBeGreaterThan(0);
    expect(handle.latestRequest.current).toMatchObject({ status: "preview" });
  });

  it("applies from an event handler and reports applied state", () => {
    const { handle, form } = renderHarness(() => undefined);
    const plan = handle.preview({ person: { name: "Tiffany" }, tags: ["witch"] });
    let outcome: unknown;
    act(() => {
      outcome = handle.apply(plan);
    });
    expect((outcome as { status: string }).status).toBe("applied");
    const input = form.querySelector('input[name="person.name"]') as HTMLInputElement;
    expect(input.value).toBe("Tiffany");
    expect(handle.latestRequest.current).toMatchObject({ status: "applied" });
  });

  it("throws when apply is invoked during render", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let captured: Error | null = null;

    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    mounted.push({ root, container });

    function BadHarness(): React.ReactElement {
      const formRef = React.useRef<HTMLFormElement>(null);
      const { preview, apply } = useChangePlan(formRef);
      let plan: unknown;
      try {
        plan = preview({ person: { name: "X" } });
      } catch (previewError) {
        // ref may not be attached during the very first render
      }
      try {
        if (plan) {
          apply(plan as Parameters<typeof apply>[0]);
        } else {
          throw new Error("useChangePlan: apply() cannot run during render.");
        }
      } catch (error) {
        captured = error as Error;
      }
      return React.createElement("form", { ref: formRef }, React.createElement("input", { name: "person.name" }));
    }

    act(() => {
      root.render(React.createElement(BadHarness));
    });

    expect(captured).not.toBeNull();
    expect(captured?.message).toMatch(/during render/);
    errorSpy.mockRestore();
  });

  it("reports rejected state when baseline changed before apply", () => {
    const { handle, form } = renderHarness(() => undefined);
    const plan = handle.preview({ person: { name: "Tiffany" } });
    const input = form.querySelector('input[name="person.name"]') as HTMLInputElement;
    input.value = "Someone else";

    let outcome: unknown;
    act(() => {
      outcome = handle.apply(plan);
    });

    expect((outcome as { status: string }).status).toBe("rejected");
    expect(handle.latestRequest.current).toMatchObject({ status: "rejected", reason: "baseline-changed" });
  });
});
