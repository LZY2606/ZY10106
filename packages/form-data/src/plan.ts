import {
  applyChangePlan,
  createChangePlan,
  createFieldNameCanonicalizer,
  type ChangeItem,
  type ChangePlan,
  type CreateChangePlanOptions,
  type PlanAdapter,
  type PlanApplyOutcome,
  type PlanControl,
  type PlanControlRef,
  type ValueCapability
} from "@form2js/core";

export interface FormDataPlanOptions extends CreateChangePlanOptions {}

type FormDataInput = FormData | Iterable<readonly [string, FormDataEntryValue]>;

interface VirtualEntry {
  key: string;
  values: FormDataEntryValue[];
  rawKeys: string[];
}

function toEntryList(
  formData: FormDataInput,
  delimiter: string
): VirtualEntry[] {
  const entries = new Map<
    string,
    { canonicalKey: string; values: FormDataEntryValue[]; rawKeys: string[] }
  >();
  const canonicalizer = createFieldNameCanonicalizer(delimiter);

  const iterable: Iterable<readonly [string, FormDataEntryValue]> =
    typeof FormData !== "undefined" && formData instanceof FormData
      ? formData.entries()
      : (formData as Iterable<readonly [string, FormDataEntryValue]>);

  for (const [key, value] of iterable) {
    const stripped = key.replace(/\[\]$/, "");
    const canonicalKey = /\[\d+\]/.test(stripped)
      ? canonicalizer.canonicalize(stripped)
      : canonicalizer.canonicalize(stripped);
    const groupKey = canonicalKey;
    const existing = entries.get(groupKey);
    if (existing) {
      existing.values.push(value);
      existing.rawKeys.push(key);
    } else {
      entries.set(groupKey, { canonicalKey, values: [value], rawKeys: [key] });
    }
  }

  return [...entries.values()].map((entry) => ({
    key: entry.canonicalKey,
    values: entry.values,
    rawKeys: entry.rawKeys
  }));
}

function isFileValue(value: unknown): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { size?: unknown }).size === "number"
  );
}

export function createFormDataPlanAdapter(
  formData: FormDataInput,
  options: { name?: string; delimiter?: string } = {}
): PlanAdapter & { toFormData(): FormData } {
  const entryList = toEntryList(formData, options.delimiter ?? ".");
  const adapterName = options.name ?? "form-data";
  const output = typeof FormData !== "undefined" ? new FormData() : null;

  const controls: PlanControl[] = entryList.map((entry, index) => {
    const path = entry.key;
    const leafKind: "scalar" | "array" = entry.values.length > 1 ? "array" : "scalar";
    const id = `fd:${index}:${path}`;
    const ref: PlanControlRef = {
      id,
      adapter: adapterName,
      kind: "virtual",
      name: path,
      path
    };

    return {
      id,
      ref,
      path,
      leafKind,
      ordered: false,
      disabled: false,
      readValue() {
        return leafKind === "array" ? entry.values : (entry.values[0] ?? null);
      },
      fingerprint() {
        return JSON.stringify({
          values: entry.values.map((value) =>
            isFileValue(value)
              ? { __file__: true, name: value.name, size: value.size, type: value.type }
              : value
          )
        });
      },
      canRepresent(value: unknown): ValueCapability {
        if (value === null || value === undefined) {
          return { representable: true, lossless: true };
        }

        if (typeof value === "string") {
          return { representable: true, lossless: true };
        }

        if (isFileValue(value)) {
          return { representable: true, lossless: true };
        }

        if (Array.isArray(value)) {
          const supported = value.every((item) => typeof item === "string" || isFileValue(item));
          return supported
            ? { representable: true, lossless: true }
            : {
                representable: false,
                lossless: false,
                message: "FormData only supports string and File values."
              };
        }

        return {
          representable: false,
          lossless: false,
          message: "FormData cannot represent numbers, booleans, objects or nested arrays without string conversion."
        };
      },
      apply(item: ChangeItem) {
        applyEntryChange(entry, leafKind, item);
      }
    };
  });

  return {
    name: adapterName,
    canCreatePaths: true,
    controls: () => controls,
    applyChange(change: ChangeItem) {
      if (change.controls.length > 0) {
        return;
      }

      if (change.kind === "remove" || change.kind === "clear") {
        return;
      }

      const values: FormDataEntryValue[] = Array.isArray(change.newValue)
        ? (change.newValue as FormDataEntryValue[])
        : [change.newValue as FormDataEntryValue];
      entryList.push({ key: change.path, values, rawKeys: [change.path] });
    },
    commit(): undefined {
      return undefined;
    },
    toFormData(): FormData {
      if (!output) {
        throw new Error("FormData is not available in this environment.");
      }

      for (const entry of entryList) {
        const outputKey = entry.rawKeys[0] ?? entry.key;
        for (const value of entry.values) {
          output.append(outputKey, value);
        }
      }

      return output;
    }
  };
}

function applyEntryChange(
  entry: VirtualEntry,
  leafKind: "scalar" | "array",
  item: ChangeItem
): void {
  const match = item.path.match(/\[(\d+)\]$/);

  if (leafKind === "array" || match) {
    if (item.kind === "clear") {
      entry.values = [];
      return;
    }

    if (match) {
      const index = Number(match[1]);
      if (item.kind === "remove") {
        entry.values.splice(index, 1);
      } else if (item.newValue !== null && item.newValue !== undefined) {
        entry.values[index] = item.newValue as FormDataEntryValue;
      }
      return;
    }

    if (Array.isArray(item.newValue)) {
      entry.values = item.newValue as FormDataEntryValue[];
    } else if (item.newValue !== null && item.newValue !== undefined) {
      entry.values = [item.newValue as FormDataEntryValue];
    } else {
      entry.values = [];
    }
    return;
  }

  if (item.kind === "clear" || item.kind === "remove" || item.newValue === null || item.newValue === undefined) {
    entry.values = [];
    return;
  }

  entry.values = [item.newValue as FormDataEntryValue];
}

export function createFormDataChangePlan(
  formData: FormDataInput,
  target: unknown,
  options: FormDataPlanOptions = {}
): ChangePlan {
  const adapter = createFormDataPlanAdapter(
    formData,
    options.delimiter !== undefined ? { delimiter: options.delimiter } : {}
  );
  return createChangePlan(adapter, target, options);
}

export function applyFormDataChangePlan(
  formData: FormDataInput,
  plan: ChangePlan
): PlanApplyOutcome {
  const adapter = createFormDataPlanAdapter(formData, {
    name: plan.adapter,
    delimiter: plan.delimiter
  } as { name?: string; delimiter?: string });
  const outcome = applyChangePlan(adapter, plan);
  if (outcome.status === "applied") {
    return {
      ...outcome,
      result: adapter.toFormData() as unknown as Record<string, unknown>
    };
  }

  return outcome;
}

export function commitFormDataChangePlan(
  formData: FormDataInput,
  target: unknown,
  options: FormDataPlanOptions = {}
): PlanApplyOutcome {
  const plan = createFormDataChangePlan(formData, target, options);
  return applyFormDataChangePlan(formData, plan);
}
