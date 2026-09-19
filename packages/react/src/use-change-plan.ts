import {
  applyDomChangePlan,
  createDomChangePlan,
  type DomPlanOptions
} from "@form2js/dom";
import type {
  BaselineDiff,
  ChangeItem,
  ChangePlan,
  ConflictItem,
  PlanApplyOutcome
} from "@form2js/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

export interface UseChangePlanOptions extends DomPlanOptions {}

export type ChangePlanRequest =
  | { status: "idle" }
  | { status: "preview"; plan: ChangePlan }
  | {
      status: "rejected";
      plan: ChangePlan;
      reason: "conflicts" | "baseline-changed";
      conflicts?: ConflictItem[];
      baselineDiffs?: BaselineDiff[];
    }
  | { status: "applied"; plan: ChangePlan; changes: ChangeItem[] };

export interface UseChangePlanResult {
  preview: (target: unknown) => ChangePlan;
  apply: (plan: ChangePlan) => PlanApplyOutcome;
  previewAndApply: (target: unknown) => PlanApplyOutcome;
  request: ChangePlanRequest;
}

export function useChangePlan(
  formRef: React.RefObject<HTMLFormElement | null>,
  options: UseChangePlanOptions = {}
): UseChangePlanResult {
  const [request, setRequest] = useState<ChangePlanRequest>({ status: "idle" });
  const renderPhaseRef = useRef(true);
  const optionsRef = useRef(options);
  optionsRef.current = options;

  renderPhaseRef.current = true;

  useLayoutEffect(() => {
    renderPhaseRef.current = false;
  });

  useEffect(() => {
    renderPhaseRef.current = false;
  }, []);

  const preview = useCallback((target: unknown): ChangePlan => {
    const form = formRef.current;
    if (!form) {
      throw new Error("useChangePlan: form ref is not attached yet.");
    }

    const plan = createDomChangePlan(form, target, optionsRef.current);
    setRequest({ status: "preview", plan });
    return plan;
  }, [formRef]);

  const apply = useCallback((plan: ChangePlan): PlanApplyOutcome => {
    if (renderPhaseRef.current) {
      throw new Error(
        "useChangePlan: apply() cannot run during render. Move it to an event handler or useEffect."
      );
    }

    const form = formRef.current;
    if (!form) {
      throw new Error("useChangePlan: form ref is not attached yet.");
    }

    const outcome = applyDomChangePlan(form, plan);

    if (outcome.status === "applied") {
      setRequest({ status: "applied", plan: outcome.plan, changes: outcome.changes });
    } else {
      setRequest({
        status: "rejected",
        plan: outcome.plan,
        reason: outcome.reason,
        ...(outcome.status === "rejected" && outcome.conflicts
          ? { conflicts: outcome.conflicts }
          : {}),
        ...(outcome.status === "rejected" && outcome.baselineDiffs
          ? { baselineDiffs: outcome.baselineDiffs }
          : {})
      });
    }

    return outcome;
  }, [formRef]);

  const previewAndApply = useCallback(
    (target: unknown): PlanApplyOutcome => {
      const plan = preview(target);
      return apply(plan);
    },
    [preview, apply]
  );

  return { preview, apply, previewAndApply, request };
}
