// apps/docs/src/components/playground/variants/js2form-variant.tsx
import React, { useRef } from "react";
import { formToObject, createDomChangePlan, applyDomChangePlan, type ChangePlan } from "@form2js/dom";
import { objectToForm } from "@form2js/js2form";

import type { StandardOutputState, VariantComponentProps } from "../types";

const INITIAL_JSON = `{
  "person": {
    "name": {
      "first": "Tiffany",
      "last": "Aching"
    },
    "city": "quirm",
    "tags": ["witch"]
  }
}`;

const CONFLICT_JSON = `{
  "person": {
    "name": {
      "first": "Tiffany"
    },
    "city": "ankh-morpork",
    "avatar": "cannot-assign-a-file"
  },
  "__proto__": {
    "polluted": true
  }
}`;

interface PlanPreviewPayload {
  mode: "change-plan";
  changes: unknown;
  conflicts: unknown;
  fingerprintKeys: number;
}

function createIdleState(): StandardOutputState {
  return { kind: "standard", status: "idle", statusMessage: "Ready to apply object data.", errorMessage: null, parsedPayload: null };
}

function createErrorState(message: string): StandardOutputState {
  return { kind: "standard", status: "error", statusMessage: "js2form apply failed.", errorMessage: message, parsedPayload: null };
}

function createSuccessState(parsedPayload: unknown): StandardOutputState {
  return { kind: "standard", status: "success", statusMessage: "@form2js/js2form -> objectToForm(...), then formToObject(...)", errorMessage: null, parsedPayload };
}

function createPlanPreviewState(plan: ChangePlan, applied: boolean): StandardOutputState {
  const payload: PlanPreviewPayload = {
    mode: "change-plan",
    changes: plan.changes,
    conflicts: plan.conflicts,
    fingerprintKeys: Object.keys(plan.fingerprint).length
  };

  return {
    kind: "standard",
    status: plan.conflicts.length > 0 ? "error" : "success",
    statusMessage: applied
      ? `change plan applied: ${plan.changes.length} change(s).`
      : `change plan preview: ${plan.changes.length} change(s), ${plan.conflicts.length} conflict(s).`,
    errorMessage: plan.conflicts.length > 0 ? "The plan was rejected. Resolve the conflicts before applying." : null,
    parsedPayload: payload
  };
}

function formatVariantError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export function Js2FormVariant({ onOutputChange }: VariantComponentProps): React.JSX.Element {
  const formRef = useRef<HTMLFormElement>(null);
  const jsonInputRef = useRef<HTMLTextAreaElement>(null);
  const pendingPlanRef = useRef<ChangePlan | null>(null);

  function parseTarget(): { ok: true; value: unknown } | { ok: false } {
    const jsonInput = jsonInputRef.current;
    if (!jsonInput) {
      onOutputChange(createIdleState());
      return { ok: false };
    }

    try {
      return { ok: true, value: JSON.parse(jsonInput.value) as unknown };
    } catch {
      onOutputChange(createErrorState("JSON parse error: please provide valid JSON before applying js2form."));
      return { ok: false };
    }
  }

  function handleApply(): void {
    const form = formRef.current;
    if (!form) { onOutputChange(createIdleState()); return; }

    const parsedTarget = parseTarget();
    if (!parsedTarget.ok) {
      return;
    }

    try {
      objectToForm(form, parsedTarget.value);
      onOutputChange(createSuccessState(formToObject(form)));
    } catch (error: unknown) {
      onOutputChange(createErrorState(`js2form runtime error: ${formatVariantError(error)}`));
    }
  }

  function handlePreview(): void {
    const form = formRef.current;
    if (!form) { onOutputChange(createIdleState()); return; }

    const parsedTarget = parseTarget();
    if (!parsedTarget.ok) {
      return;
    }

    const plan = createDomChangePlan(form, parsedTarget.value);
    pendingPlanRef.current = plan;
    onOutputChange(createPlanPreviewState(plan, false));
  }

  function handleCommitPlan(): void {
    const form = formRef.current;
    if (!form || !pendingPlanRef.current) {
      onOutputChange(createErrorState("Preview a change plan before committing it."));
      return;
    }

    const outcome = applyDomChangePlan(form, pendingPlanRef.current);
    if (outcome.status === "rejected") {
      const reason =
        outcome.reason === "baseline-changed"
          ? `Baseline changed: ${outcome.baselineDiffs?.length ?? 0} control(s) differ from the preview fingerprint.`
          : `${outcome.conflicts?.length ?? 0} conflict(s) block the plan.`;
      onOutputChange(createErrorState(reason));
      return;
    }

    onOutputChange(createPlanPreviewState(outcome.plan, true));
  }

  function handleLoadConflictExample(): void {
    const jsonInput = jsonInputRef.current;
    if (jsonInput) {
      jsonInput.value = CONFLICT_JSON;
    }

    onOutputChange({
      kind: "standard",
      status: "idle",
      statusMessage: "Conflict example loaded. Preview the plan to see blocked paths.",
      errorMessage: null,
      parsedPayload: null
    });
  }

  function handleReset(): void {
    const form = formRef.current;
    const jsonInput = jsonInputRef.current;
    if (form) form.reset();
    if (jsonInput) jsonInput.value = INITIAL_JSON;
    pendingPlanRef.current = null;
    onOutputChange(createIdleState());
  }

  return (
    <section aria-label="js2form variant">
      <div className="pg-field">
        <label className="pg-label" htmlFor="j2f-json">input.json</label>
        <textarea className="pg-textarea" defaultValue={INITIAL_JSON} id="j2f-json" name="js2form-json" ref={jsonInputRef} rows={10} />
      </div>
      <form ref={formRef}>
        <div className="pg-field">
          <label className="pg-label" htmlFor="j2f-first">person.name.first</label>
          <input className="pg-input" defaultValue="Esme" id="j2f-first" name="person.name.first" type="text" />
        </div>
        <div className="pg-field">
          <label className="pg-label" htmlFor="j2f-last">person.name.last</label>
          <input className="pg-input" defaultValue="Weatherwax" id="j2f-last" name="person.name.last" type="text" />
        </div>
        <div className="pg-field">
          <label className="pg-label" htmlFor="j2f-city">person.city</label>
          <select className="pg-select" defaultValue="lancre" id="j2f-city" name="person.city">
            <option value="ankh-morpork">Ankh-Morpork</option>
            <option value="lancre">Lancre</option>
            <option value="quirm">Quirm</option>
          </select>
        </div>
        <div className="pg-field">
          <label className="pg-label" htmlFor="j2f-avatar">person.avatar (file)</label>
          <input className="pg-input" id="j2f-avatar" name="person.avatar" type="file" />
        </div>
        <fieldset className="pg-fieldset">
          <legend>person.tags[]</legend>
          <label className="pg-check-label">
            <input defaultChecked name="person.tags[]" type="checkbox" value="witch" />witch
          </label>
          <label className="pg-check-label">
            <input defaultChecked name="person.tags[]" type="checkbox" value="headology" />headology
          </label>
        </fieldset>
      </form>
      <div className="pg-btns">
        <button className="pg-btn" onClick={handlePreview} type="button">Preview change plan</button>
        <button className="pg-btn" onClick={handleCommitPlan} type="button">Commit plan</button>
        <button className="pg-btn pg-btn-secondary" onClick={handleLoadConflictExample} type="button">Load conflict example</button>
        <button className="pg-btn pg-btn-secondary" onClick={handleApply} type="button">Apply js2form</button>
        <button className="pg-btn pg-btn-secondary" onClick={handleReset} type="button">Reset form</button>
      </div>
    </section>
  );
}
