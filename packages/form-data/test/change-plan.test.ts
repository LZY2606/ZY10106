// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { CHANGE_CONFLICT_CODES } from "@form2js/core";
import {
  applyFormDataChanges,
  formDataToObject,
  planFormDataChanges
} from "../src/index";

describe("planFormDataChanges", () => {
  it("plans set and append items without mutating the FormData", () => {
    const formData = new FormData();
    formData.append("name", "Esme");
    formData.append("tags[]", "witch");
    const before = [...formData.entries()];

    const plan = planFormDataChanges(formData, { name: "Tiffany", tags: ["witch", "crime"] });

    expect(plan.items).toEqual([
      expect.objectContaining({ op: "set", path: "name", oldValue: "Esme", newValue: "Tiffany" }),
      expect.objectContaining({ op: "append", path: "tags[1]", newValue: "crime" })
    ]);
    expect([...formData.entries()]).toEqual(before);
  });

  it("accepts File values as expressible", () => {
    const formData = new FormData();
    formData.append("upload", "placeholder");
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });

    const plan = planFormDataChanges(formData, { upload: file });

    expect(plan.conflicts).toHaveLength(0);
    expect(plan.items[0]).toMatchObject({ op: "set", path: "upload", lossless: true });
  });

  it("flags values FormData cannot express", () => {
    const formData = new FormData();
    formData.append("name", "Esme");

    const plan = planFormDataChanges(formData, { name: { nested: "object" } });

    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]?.conflictCode).toBe(CHANGE_CONFLICT_CODES.typeMismatch);
  });
});

describe("applyFormDataChanges", () => {
  it("applies plans atomically and preserves File values", () => {
    const formData = new FormData();
    const file = new File(["hello"], "hello.txt", { type: "text/plain" });
    formData.append("name", "Esme");
    formData.append("upload", file);
    formData.append("tags[]", "witch");

    const plan = planFormDataChanges(formData, {
      name: "Tiffany",
      upload: file,
      tags: ["witch", "crime"]
    });
    const result = applyFormDataChanges(formData, plan);

    expect(result.status).toBe("applied");
    expect(formDataToObject(formData)).toEqual({
      name: "Tiffany",
      upload: file,
      tags: ["witch", "crime"]
    });
    expect(formData.get("upload")).toBe(file);
  });

  it("does not append twice when the same plan is applied repeatedly", () => {
    const formData = new FormData();
    formData.append("tags[]", "witch");

    const plan = planFormDataChanges(formData, { tags: ["witch", "crime"] });
    const first = applyFormDataChanges(formData, plan);
    const second = applyFormDataChanges(formData, plan);

    expect(first.status).toBe("applied");
    expect(second).toBe(first);
    expect(formDataToObject(formData)).toEqual({ tags: ["witch", "crime"] });
  });

  it("rejects the plan when the FormData changed since planning", () => {
    const formData = new FormData();
    formData.append("name", "Esme");

    const plan = planFormDataChanges(formData, { name: "Tiffany" });
    formData.set("name", "Ogg");

    const result = applyFormDataChanges(formData, plan);

    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("baseline-mismatch");
    expect(result.baselineDiff).toEqual([
      { control: "name", expected: "value:Esme", actual: "value:Ogg" }
    ]);
    expect(formData.get("name")).toBe("Ogg");
  });

  it("supports remove and clear operations", () => {
    const formData = new FormData();
    formData.append("name", "Esme");
    formData.append("tags[]", "witch");
    formData.append("tags[]", "headology");

    const plan = planFormDataChanges(formData, { name: "", tags: ["witch"] });
    const result = applyFormDataChanges(formData, plan);

    expect(result.status).toBe("applied");
    expect([...formData.entries()]).toEqual([
      ["name", ""],
      ["tags[0]", "witch"]
    ]);
  });
});
