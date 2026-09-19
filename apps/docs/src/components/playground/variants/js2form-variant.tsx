// apps/docs/src/components/playground/variants/js2form-variant.tsx
import React, { useRef } from "react";
import type { ChangePlan, ChangePlanItem } from "@form2js/core";
import { formToObject } from "@form2js/dom";
import { applyObjectToForm, objectToForm, planObjectToForm } from "@form2js/js2form";

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
  "__proto__": {
    "polluted": "yes"
  },
  "person": {
    "name": {
      "first": "Tiffany"
    },
    "nickname": "Tiff",
    "tags": ["witch", "crime", "mystery"]
  }
}`;

function createIdleState(): StandardOutputState {
  return { kind: "standard", status: "idle", statusMessage: "Ready to apply object data.", errorMessage: null, parsedPayload: null };
}

function createErrorState(message: string): StandardOutputState {
  return { kind: "standard", status: "error", statusMessage: "js2form apply failed.", errorMessage: message, parsedPayload: null };
}

function createSuccessState(parsedPayload: unknown): StandardOutputState {
  return { kind: "standard", status: "success", statusMessage: "@form2js/js2form -> objectToForm(...), then formToObject(...)", errorMessage: null, parsedPayload };
}

function formatVariantError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function summarizeItem(item: ChangePlanItem): Record<string, unknown> {
  return {
    id: item.id,
    op: item.op,
    path: item.path,
    oldValue: item.oldValue ?? null,
    newValue: item.newValue ?? null,
    lossless: item.lossless,
    controls: item.controls,
    conflictCode: item.conflictCode ?? null,
    reason: item.reason ?? null
  };
}

function summarizePlan(plan: ChangePlan): Record<string, unknown> {
  return {
    planId: plan.id,
    baseline: plan.baseline,
    items: plan.items.map(summarizeItem),
    conflicts: plan.conflicts.map(summarizeItem)
  };
}

export function Js2FormVariant({ onOutputChange }: VariantComponentProps): React.JSX.Element {
  const formRef = useRef<HTMLFormElement>(null);
  const jsonInputRef = useRef<HTMLTextAreaElement>(null);
  const previewedPlanRef = useRef<ChangePlan | null>(null);

  function parseInputJson(): { ok: true; data: unknown } | { ok: false } {
    const jsonInput = jsonInputRef.current;
    if (!jsonInput) {
      return { ok: false };
    }

    try {
      return { ok: true, data: JSON.parse(jsonInput.value) as unknown };
    } catch {
      return { ok: false };
    }
  }

  function handleApply(): void {
    const form = formRef.current;
    if (!form) { onOutputChange(createIdleState()); return; }

    const parsed = parseInputJson();
    if (!parsed.ok) {
      onOutputChange(createErrorState("JSON parse error: please provide valid JSON before applying js2form."));
      return;
    }

    try {
      objectToForm(form, parsed.data);
      onOutputChange(createSuccessState(formToObject(form)));
    } catch (error: unknown) {
      onOutputChange(createErrorState(`js2form runtime error: ${formatVariantError(error)}`));
    }
  }

  function handlePreviewPlan(): void {
    const form = formRef.current;
    if (!form) { onOutputChange(createIdleState()); return; }

    const parsed = parseInputJson();
    if (!parsed.ok) {
      onOutputChange(createErrorState("JSON parse error: please provide valid JSON before previewing the change plan."));
      return;
    }

    try {
      const plan = planObjectToForm(form, parsed.data);
      previewedPlanRef.current = plan;
      onOutputChange({
        kind: "standard",
        status: plan.conflicts.length > 0 ? "error" : "success",
        statusMessage:
          plan.conflicts.length > 0
            ? `@form2js/js2form -> planObjectToForm(form, data): ${plan.conflicts.length} conflict(s)`
            : "@form2js/js2form -> planObjectToForm(form, data)",
        errorMessage:
          plan.conflicts.length > 0
            ? `Plan has ${plan.conflicts.length} conflict(s); resolve them before applying.`
            : null,
        parsedPayload: summarizePlan(plan)
      });
    } catch (error: unknown) {
      onOutputChange(createErrorState(`plan preview runtime error: ${formatVariantError(error)}`));
    }
  }

  function handleApplyPreviewedPlan(): void {
    const form = formRef.current;
    const plan = previewedPlanRef.current;
    if (!form) { onOutputChange(createIdleState()); return; }

    if (!plan) {
      onOutputChange(createErrorState("No previewed plan yet. Run \"Preview change plan\" first."));
      return;
    }

    try {
      const result = applyObjectToForm(form, plan);
      onOutputChange({
        kind: "standard",
        status: result.status === "applied" ? "success" : "error",
        statusMessage: `@form2js/js2form -> applyObjectToForm(form, plan): ${result.status}`,
        errorMessage: result.status === "applied" ? null : (result.reason ?? "plan rejected"),
        parsedPayload: {
          status: result.status,
          reason: result.reason ?? null,
          baselineDiff: result.baselineDiff,
          appliedItems: result.appliedItems.map(summarizeItem),
          form: formToObject(form)
        }
      });
    } catch (error: unknown) {
      onOutputChange(createErrorState(`plan apply runtime error: ${formatVariantError(error)}`));
    }
  }

  function handleLoadConflictExample(): void {
    const jsonInput = jsonInputRef.current;
    if (jsonInput) {
      jsonInput.value = CONFLICT_JSON;
    }
  }

  function handleReset(): void {
    const form = formRef.current;
    const jsonInput = jsonInputRef.current;
    if (form) form.reset();
    if (jsonInput) jsonInput.value = INITIAL_JSON;
    previewedPlanRef.current = null;
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
        <button className="pg-btn" onClick={handleApply} type="button">Apply js2form</button>
        <button className="pg-btn" onClick={handlePreviewPlan} type="button">Preview change plan</button>
        <button className="pg-btn" onClick={handleApplyPreviewedPlan} type="button">Apply previewed plan</button>
        <button className="pg-btn pg-btn-secondary" onClick={handleLoadConflictExample} type="button">Load conflict example</button>
        <button className="pg-btn pg-btn-secondary" onClick={handleReset} type="button">Reset form</button>
      </div>
    </section>
  );
}
