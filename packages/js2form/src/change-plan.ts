import {
  applyFormChanges,
  planFormChanges,
  type FormChangePlanOptions
} from "@form2js/dom";
import type { ApplyChangePlanResult, ChangePlan } from "@form2js/core";

import type { ObjectToFormOptions, RootNodeInput } from "./index";

export interface ObjectToFormPlanOptions
  extends Pick<ObjectToFormOptions, "delimiter" | "useIdIfEmptyName" | "document"> {
  prune?: boolean;
}

function toFormChangePlanOptions(options: ObjectToFormPlanOptions): FormChangePlanOptions {
  const planOptions: FormChangePlanOptions = {
    delimiter: options.delimiter ?? ".",
    useIdIfEmptyName: options.useIdIfEmptyName ?? false,
    prune: options.prune ?? false
  };

  if (options.document !== undefined) {
    planOptions.document = options.document;
  }

  return planOptions;
}

export function planObjectToForm(
  rootNode: RootNodeInput,
  data: unknown,
  options: ObjectToFormPlanOptions = {}
): ChangePlan {
  return planFormChanges(rootNode, data, toFormChangePlanOptions(options));
}

export function applyObjectToForm(
  rootNode: RootNodeInput,
  plan: ChangePlan,
  options: ObjectToFormPlanOptions = {}
): ApplyChangePlanResult {
  return applyFormChanges(rootNode, plan, toFormChangePlanOptions(options));
}
