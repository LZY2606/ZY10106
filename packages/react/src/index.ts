import {
  applyChangePlan,
  createChangePlan,
  sourceIdentityFor,
  type ApplyChangePlanResult,
  type ChangePlan,
  type ChangePlanSource
} from "@form2js/core";
import {
  createFormDataChangePlanSource,
  formDataToObject,
  type InferSchemaOutput,
  type ObjectTree,
  type ParseOptions,
  type SchemaValidator
} from "@form2js/form-data";
import { useCallback, useEffect, useRef, useState, type SyntheticEvent } from "react";

export type UseForm2jsData<TSchema extends SchemaValidator | undefined> =
  TSchema extends SchemaValidator ? InferSchemaOutput<TSchema> : ObjectTree;

export type UseForm2jsSubmit<TSchema extends SchemaValidator | undefined = undefined> = (
  data: UseForm2jsData<TSchema>
) => Promise<void> | void;

export interface UseForm2jsOptions<TSchema extends SchemaValidator | undefined = undefined>
  extends ParseOptions {
  schema?: TSchema;
}

export interface UseForm2jsResult {
  onSubmit: (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => Promise<void>;
  isSubmitting: boolean;
  isError: boolean;
  error: unknown;
  isSuccess: boolean;
  reset: () => void;
}

export interface UseFormChangePlanOptions<TSchema extends SchemaValidator | undefined = undefined>
  extends ParseOptions {
  schema?: TSchema;
  prune?: boolean;
}

export interface UseFormChangePlanResult {
  createPlan: (form: HTMLFormElement, target: unknown) => ChangePlan;
  applyPlan: (plan: ChangePlan) => ApplyChangePlanResult;
  isSubmitting: boolean;
  isError: boolean;
  error: unknown;
  isSuccess: boolean;
  reset: () => void;
}

interface PlannedSubmission {
  form: HTMLFormElement;
  target: unknown;
}

function createLiveFormSource(form: HTMLFormElement): ChangePlanSource {
  const delegate = (): ChangePlanSource => createFormDataChangePlanSource(new FormData(form));

  return {
    kind: "react-form",
    identity: sourceIdentityFor(form),
    readEntries: () => delegate().readEntries(),
    fingerprint: () => delegate().fingerprint(),
    snapshotControls: () => delegate().snapshotControls(),
    controlsForPath: (path: string) => [path],
    canExpress: (path: string, value: unknown) => delegate().canExpress(path, value),
    applyItems: () => {
      // React state is the source of truth; committing happens through the
      // submit callback once the baseline check passes.
    }
  };
}

function rejectedPlanResult(plan: ChangePlan, reason: string): ApplyChangePlanResult {
  return {
    status: "rejected",
    planId: plan.id,
    reason,
    appliedItems: [],
    conflicts: plan.conflicts,
    baselineDiff: []
  };
}

export function useFormChangePlan<TSchema extends SchemaValidator | undefined = undefined>(
  submit: UseForm2jsSubmit<TSchema>,
  options: UseFormChangePlanOptions<TSchema> = {}
): UseFormChangePlanResult {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isError, setIsError] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [isSuccess, setIsSuccess] = useState(false);
  const committedRef = useRef(false);
  const plannedSubmissionsRef = useRef(new Map<string, PlannedSubmission>());
  const submittedPlanIdsRef = useRef(new Set<string>());
  const { delimiter, prune, schema } = options;

  useEffect(() => {
    committedRef.current = true;
    return () => {
      committedRef.current = false;
    };
  }, []);

  const reset = useCallback(() => {
    setIsError(false);
    setError(null);
    setIsSuccess(false);
  }, []);

  const createPlan = useCallback(
    (form: HTMLFormElement, target: unknown): ChangePlan => {
      const plan = createChangePlan(createLiveFormSource(form), target, {
        delimiter: delimiter ?? ".",
        prune: prune ?? false
      });
      plannedSubmissionsRef.current.set(plan.id, { form, target });
      return plan;
    },
    [delimiter, prune]
  );

  const applyPlan = useCallback(
    (plan: ChangePlan): ApplyChangePlanResult => {
      if (!committedRef.current) {
        return rejectedPlanResult(plan, "cannot-apply-during-render");
      }

      const planned = plannedSubmissionsRef.current.get(plan.id);

      if (!planned) {
        return rejectedPlanResult(plan, "unknown-plan");
      }

      const result = applyChangePlan(createLiveFormSource(planned.form), plan);

      if (result.status === "applied" && !submittedPlanIdsRef.current.has(plan.id)) {
        submittedPlanIdsRef.current.add(plan.id);
        setIsSubmitting(true);
        setIsError(false);
        setError(null);
        setIsSuccess(false);

        void (async () => {
          try {
            const data = schema ? schema.parse(planned.target) : planned.target;
            await submit(data as UseForm2jsData<TSchema>);
            setIsSuccess(true);
          } catch (submitError: unknown) {
            setIsError(true);
            setError(submitError);
          } finally {
            setIsSubmitting(false);
          }
        })();
      }

      return result;
    },
    [schema, submit]
  );

  return {
    createPlan,
    applyPlan,
    isSubmitting,
    isError,
    error,
    isSuccess,
    reset
  };
}

function buildParseOptions(options: ParseOptions): ParseOptions {
  const parseOptions: ParseOptions = {};

  if (options.delimiter !== undefined) {
    parseOptions.delimiter = options.delimiter;
  }

  if (options.skipEmpty !== undefined) {
    parseOptions.skipEmpty = options.skipEmpty;
  }

  if (options.allowUnsafePathSegments !== undefined) {
    parseOptions.allowUnsafePathSegments = options.allowUnsafePathSegments;
  }

  return parseOptions;
}

export function useForm2js<TSchema extends SchemaValidator | undefined = undefined>(
  submit: UseForm2jsSubmit<TSchema>,
  options: UseForm2jsOptions<TSchema> = {}
): UseForm2jsResult {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isError, setIsError] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [isSuccess, setIsSuccess] = useState(false);
  const isSubmittingRef = useRef(false);
  const { allowUnsafePathSegments, delimiter, schema, skipEmpty } = options;

  const reset = useCallback(() => {
    setIsError(false);
    setError(null);
    setIsSuccess(false);
  }, []);

  const onSubmit = useCallback(
    async (event: SyntheticEvent<HTMLFormElement, SubmitEvent>) => {
      event.preventDefault();

      if (isSubmittingRef.current) {
        return;
      }

      isSubmittingRef.current = true;
      setIsSubmitting(true);
      setIsError(false);
      setError(null);
      setIsSuccess(false);

      try {
        const parseOptions = buildParseOptions(options);
        const formData = new FormData(event.currentTarget);

        const data = schema
          ? formDataToObject(formData, { ...parseOptions, schema })
          : formDataToObject(formData, parseOptions);

        await submit(data as UseForm2jsData<TSchema>);
        setIsSuccess(true);
      } catch (submitError: unknown) {
        setIsError(true);
        setError(submitError);
      } finally {
        setIsSubmitting(false);
        isSubmittingRef.current = false;
      }
    },
    [allowUnsafePathSegments, delimiter, schema, skipEmpty, submit]
  );

  return {
    onSubmit,
    isSubmitting,
    isError,
    error,
    isSuccess,
    reset
  };
}
