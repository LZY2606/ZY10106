// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { applyDomChangePlan, createDomChangePlan } from "../src/plan";

function setupForm(markup: string): HTMLFormElement {
  document.body.innerHTML = `<form id="plan-form">${markup}</form>`;
  return document.getElementById("plan-form") as HTMLFormElement;
}

describe("DOM change plan", () => {
  it("previews scalar sets, checkbox groups, radio groups and removes", () => {
    const form = setupForm(`
      <input name="person.name.first" value="Esme" />
      <input type="checkbox" name="person.tags[]" value="witch" checked />
      <input type="checkbox" name="person.tags[]" value="headology" checked />
      <input type="radio" name="person.rank" value="novice" checked />
      <input type="radio" name="person.rank" value="witch" />
      <input name="gone" value="x" />
    `);

    const plan = createDomChangePlan(form, {
      person: {
        name: { first: "Tiffany" },
        tags: ["witch"],
        rank: "witch"
      }
    });

    expect(plan.conflicts).toEqual([]);
    expect(plan.changes.map((item) => `${item.kind}:${item.path}`)).toEqual(
      expect.arrayContaining([
        "set:person.name.first",
        "remove:person.tags",
        "set:person.rank",
        "clear:gone"
      ])
    );
    const tagRemoval = plan.changes.find((item) => item.kind === "remove" && item.path === "person.tags");
    expect(tagRemoval?.oldValue).toBe("headology");
  });

  it("computing the plan does not mutate the DOM", () => {
    const form = setupForm(`<input name="name" value="Esme" />`);
    const input = form.querySelector("input") as HTMLInputElement;
    createDomChangePlan(form, { name: "Tiffany" });
    expect(input.value).toBe("Esme");
  });

  it("applies once and returns the same outcome on repeated apply", () => {
    const form = setupForm(`
      <input name="a" value="one" />
      <input name="b" value="two" />
    `);

    const plan = createDomChangePlan(form, { a: "uno", b: "dos" });
    const first = applyDomChangePlan(form, plan);
    const second = applyDomChangePlan(form, plan);

    expect(first.status).toBe("applied");
    expect(second).toBe(first);
    const inputs = form.querySelectorAll("input");
    expect(inputs[0]?.value).toBe("uno");
    expect(inputs[1]?.value).toBe("dos");
  });

  it("rejects with baseline diffs when a control changed after preview", () => {
    const form = setupForm(`<input name="name" value="Esme" />`);
    const input = form.querySelector("input") as HTMLInputElement;
    const plan = createDomChangePlan(form, { name: "Tiffany" });

    input.value = "Someone else";

    const outcome = applyDomChangePlan(form, plan);
    expect(outcome.status).toBe("rejected");
    if (outcome.status !== "rejected") throw new Error("expected rejection");
    expect(outcome.reason).toBe("baseline-changed");
    expect(outcome.baselineDiffs?.[0]?.path).toBe("name");
    expect(input.value).toBe("Someone else");
  });

  it("refuses capability conflicts: number into checkbox group, unknown option, file input", () => {
    const form = setupForm(`
      <input type="checkbox" name="tags[]" value="a" checked />
      <input type="checkbox" name="tags[]" value="b" />
      <select name="city"><option value="lancre" selected>lancre</option></select>
      <input type="file" name="avatar" />
    `);

    const plan = createDomChangePlan(form, {
      tags: ["a", 42],
      city: "quirm",
      avatar: "not-a-file"
    });

    const codes = plan.conflicts.map((conflict) => `${conflict.code}@${conflict.path}`);
    expect(codes.some((code) => code.startsWith("capability@person.tags") || code === "capability@tags")).toBe(true);
    expect(codes).toContain("capability@city");
    expect(codes).toContain("capability@avatar");
  });

  it("treats disabled controls as conflicts and skips them in the current tree", () => {
    const form = setupForm(`
      <input name="locked" value="x" disabled />
      <input name="active" value="y" />
    `);

    const plan = createDomChangePlan(form, { locked: "z", active: "w" });
    expect(plan.conflicts.some((c) => c.code === "disabled" && c.path === "locked")).toBe(true);

    const outcome = applyDomChangePlan(form, plan);
    expect(outcome.status).toBe("rejected");
    const locked = form.querySelector('input[name="locked"]') as HTMLInputElement;
    expect(locked.value).toBe("x");
  });

  it("emits unsafe-path conflicts for prototype pollution targets", () => {
    const form = setupForm(`<input name="safe" value="1" />`);
    const plan = createDomChangePlan(form, JSON.parse('{"__proto__":{"x":1}}'));
    expect(plan.conflicts.some((c) => c.code === "unsafe-path")).toBe(true);
  });

  it("handles multi-select arrays with append/remove semantics", () => {
    const form = setupForm(`
      <select name="colors[]" multiple>
        <option value="r" selected>r</option>
        <option value="g" selected>g</option>
        <option value="b">b</option>
      </select>
    `);

    const plan = createDomChangePlan(form, { colors: ["g", "b"] });
    expect(plan.conflicts).toEqual([]);
    const result = applyDomChangePlan(form, plan);
    expect(result.status).toBe("applied");
    const select = form.querySelector("select") as HTMLSelectElement;
    expect([...select.options].filter((option) => option.selected).map((option) => option.value)).toEqual(["g", "b"]);
  });

  it("rejects repeated scalar controls that cannot grow (append beyond DOM)", () => {
    const form = setupForm(`
      <input name="items[0]" value="a" />
      <input name="items[1]" value="b" />
    `);

    const indexed = createDomChangePlan(form, { items: ["a", "b", "c"] });
    expect(indexed.conflicts.some((c) => c.code === "capability")).toBe(true);
  });

  it("supports File values on file inputs without lossy flag", () => {
    class TestDataTransfer {
      public readonly items = {
        values: [] as File[],
        add(file: File): void {
          this.values.push(file);
        }
      };

      public get files(): FileList {
        const dataTransfer = this as unknown as { _files?: File[] };
        dataTransfer._files = this.items.values;
        const list: File[] = this.items.values;
        return {
          length: list.length,
          item(index: number): File | null {
            return list[index] ?? null;
          },
          ...Object.fromEntries(list.map((file, index) => [index, file]))
        } as unknown as FileList;
      }
    }

    const nativeInput = document.createElement("input");
    nativeInput.type = "file";
    const originalDescriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
    const transfer = TestDataTransfer;
    (globalThis as { DataTransfer?: unknown }).DataTransfer = transfer;

    Object.defineProperty(HTMLInputElement.prototype, "files", {
      configurable: true,
      get(this: HTMLInputElement): FileList | null {
        return (this as unknown as { __files?: FileList }).__files ?? null;
      },
      set(this: HTMLInputElement, value: FileList | null): void {
        Object.defineProperty(this, "__files", { value, configurable: true, writable: true });
      }
    });

    try {
      const form = setupForm(`<input type="file" name="avatar" />`);
      const file = new File(["bytes"], "avatar.png", { type: "image/png" });
      const plan = createDomChangePlan(form, { avatar: file });
      expect(plan.conflicts).toEqual([]);
      expect(plan.changes[0]?.lossless).toBe(true);
      const outcome = applyDomChangePlan(form, plan);
      expect(outcome.status).toBe("applied");
      const input = form.querySelector('input[type="file"]') as HTMLInputElement;
      expect(input.files?.[0]?.name).toBe("avatar.png");
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(HTMLInputElement.prototype, "files", originalDescriptor);
      }
      delete (globalThis as { DataTransfer?: unknown }).DataTransfer;
    }
  });
});
