import {
  applyChangePlan,
  createChangePlan,
  entriesToObject,
  fingerprintValue,
  objectToEntries,
  sourceIdentityFor,
  type ApplyChangePlanResult,
  type ChangePlan,
  type ChangePlanItem,
  type ChangePlanSource,
  type Entry,
  type PlanChangesOptions
} from "@form2js/core";

export interface FormDataChangePlanOptions extends PlanChangesOptions {}

function isFileLikeValue(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { name?: unknown }).name === "string" &&
    typeof (value as { size?: unknown }).size === "number" &&
    (typeof (value as { arrayBuffer?: unknown }).arrayBuffer === "function" ||
      typeof (value as { type?: unknown }).type === "string")
  );
}

function serializeControlValue(value: unknown): string {
  if (isFileLikeValue(value)) {
    const file = value as { name: string; size: number; lastModified?: number };
    return `file:${file.name}:${file.size}:${file.lastModified ?? 0}`;
  }

  return `value:${String(value)}`;
}

function canExpressValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") {
    return true;
  }

  if (isFileLikeValue(value)) {
    return true;
  }

  const valueType = typeof value;
  return valueType === "string" || valueType === "number" || valueType === "boolean";
}

function toFormDataValue(value: unknown): FormDataEntryValue {
  if (isFileLikeValue(value)) {
    return value as FormDataEntryValue;
  }

  return String(value ?? "");
}

function readCanonicalEntries(formData: FormData): Entry[] {
  const current = entriesToObject(formData.entries(), {
    skipEmpty: false,
    allowUnsafePathSegments: true
  });

  return objectToEntries(current);
}

export function createFormDataChangePlanSource(formData: FormData): ChangePlanSource {
  return {
    kind: "form-data",
    identity: sourceIdentityFor(formData),
    readEntries(): Entry[] {
      return readCanonicalEntries(formData);
    },
    fingerprint(): string {
      return fingerprintValue(this.snapshotControls());
    },
    snapshotControls(): Record<string, string> {
      const snapshot: Record<string, string> = {};
      for (const entry of readCanonicalEntries(formData)) {
        snapshot[entry.key] = serializeControlValue(entry.value);
      }
      return snapshot;
    },
    controlsForPath(path: string): string[] {
      return [path];
    },
    canExpress(_path: string, value: unknown): boolean {
      return canExpressValue(value);
    },
    applyItems(items: ChangePlanItem[]): void {
      const entries: [string, unknown][] = readCanonicalEntries(formData).map((entry) => [
        entry.key,
        entry.value
      ]);

      for (const item of items) {
        const existingIndex = entries.findIndex(([key]) => key === item.path);

        switch (item.op) {
          case "set":
            if (existingIndex >= 0) {
              entries[existingIndex] = [item.path, item.newValue];
            } else {
              entries.push([item.path, item.newValue]);
            }
            break;
          case "append":
            entries.push([item.path, item.newValue]);
            break;
          case "clear":
            if (existingIndex >= 0) {
              entries[existingIndex] = [item.path, ""];
            }
            break;
          case "remove":
            if (existingIndex >= 0) {
              entries.splice(existingIndex, 1);
            }
            break;
          default:
            break;
        }
      }

      for (const key of new Set(formData.keys())) {
        formData.delete(key);
      }

      for (const [key, value] of entries) {
        formData.append(key, toFormDataValue(value));
      }
    }
  };
}

export function planFormDataChanges(
  formData: FormData,
  target: unknown,
  options: FormDataChangePlanOptions = {}
): ChangePlan {
  return createChangePlan(createFormDataChangePlanSource(formData), target, options);
}

export function applyFormDataChanges(formData: FormData, plan: ChangePlan): ApplyChangePlanResult {
  return applyChangePlan(createFormDataChangePlanSource(formData), plan);
}
