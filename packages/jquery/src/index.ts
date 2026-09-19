import {
  applyFormChanges,
  form2js,
  planFormChanges,
  type ApplyChangePlanResult,
  type ChangePlan,
  type FormToObjectNodeCallback,
  type RootNodeInput
} from "@form2js/dom";

export type ToObjectMode = "first" | "all" | "combine";

export interface ToObjectOptions {
  mode?: ToObjectMode;
  delimiter?: string;
  skipEmpty?: boolean;
  allowUnsafePathSegments?: boolean;
  nodeCallback?: FormToObjectNodeCallback;
  useIdIfEmptyName?: boolean;
  getDisabled?: boolean;
}

export interface ChangePlanPluginOptions {
  mode?: ToObjectMode;
  delimiter?: string;
  useIdIfEmptyName?: boolean;
  getDisabled?: boolean;
  prune?: boolean;
}

interface JQueryCollectionLike {
  get(index: number): unknown;
  each(callback: (this: unknown, index: number, element: unknown) => void): unknown;
}

interface JQueryLike {
  fn: object;
  extend?: (target: object, ...sources: object[]) => object;
}

function isNodeObject(value: unknown): value is Node {
  return typeof value === "object" && value !== null && "nodeType" in value && "nodeName" in value;
}

function getFnObject($: JQueryLike): Record<string, unknown> {
  return $.fn as Record<string, unknown>;
}

interface ResolvedToObjectOptions {
  mode: ToObjectMode;
  delimiter: string;
  skipEmpty: boolean;
  allowUnsafePathSegments: boolean;
  nodeCallback?: FormToObjectNodeCallback;
  useIdIfEmptyName: boolean;
  getDisabled: boolean;
}

function collectRoots(collection: JQueryCollectionLike, mode: ToObjectMode): RootNodeInput {
  if (mode === "first") {
    return collection.get(0) as RootNodeInput;
  }

  const roots: Node[] = [];
  collection.each(function eachMatched() {
    if (isNodeObject(this)) {
      roots.push(this);
    }
  });

  return roots;
}

function applySettings(options?: ToObjectOptions): ResolvedToObjectOptions {
  const settings: ResolvedToObjectOptions = {
    mode: options?.mode ?? "first",
    delimiter: options?.delimiter ?? ".",
    skipEmpty: options?.skipEmpty ?? true,
    allowUnsafePathSegments: options?.allowUnsafePathSegments ?? false,
    useIdIfEmptyName: options?.useIdIfEmptyName ?? false,
    getDisabled: options?.getDisabled ?? false
  };

  if (options?.nodeCallback) {
    settings.nodeCallback = options.nodeCallback;
  }

  return settings;
}

function isJQueryLike(value: unknown): value is JQueryLike {
  return typeof value === "function" || (typeof value === "object" && value !== null && "fn" in value);
}

export function installToObjectPlugin($: JQueryLike): void {
  if (!$.fn) {
    throw new TypeError("jQuery-like object with fn is required");
  }

  const fnObject = getFnObject($);

  if (typeof fnObject.toObject === "function") {
    return;
  }

  fnObject.toObject = function toObject(this: JQueryCollectionLike, options?: ToObjectOptions): unknown {
    const settings = applySettings(options);

    switch (settings.mode) {
      case "all": {
        const result: unknown[] = [];
        this.each(function eachMatched() {
          result.push(
            form2js(
              this as RootNodeInput,
              settings.delimiter,
              settings.skipEmpty,
              settings.nodeCallback,
              settings.useIdIfEmptyName,
              settings.getDisabled,
              settings.allowUnsafePathSegments
            )
          );
        });

        return result;
      }

      case "combine": {
        const roots: Node[] = [];
        this.each(function eachMatched() {
          if (isNodeObject(this)) {
            roots.push(this);
          }
        });

        return form2js(
          roots,
          settings.delimiter,
          settings.skipEmpty,
          settings.nodeCallback,
          settings.useIdIfEmptyName,
          settings.getDisabled,
          settings.allowUnsafePathSegments
        );
      }

      case "first":
      default:
        return form2js(
          this.get(0) as RootNodeInput,
          settings.delimiter,
          settings.skipEmpty,
          settings.nodeCallback,
          settings.useIdIfEmptyName,
          settings.getDisabled,
          settings.allowUnsafePathSegments
        );
    }
  };

  fnObject.planChanges = function planChanges(
    this: JQueryCollectionLike,
    target: unknown,
    options?: ChangePlanPluginOptions
  ): ChangePlan | ChangePlan[] {
    const mode = options?.mode ?? "first";
    const planOptions = {
      delimiter: options?.delimiter ?? ".",
      useIdIfEmptyName: options?.useIdIfEmptyName ?? false,
      getDisabled: options?.getDisabled ?? false,
      prune: options?.prune ?? false
    };

    if (mode === "all") {
      const plans: ChangePlan[] = [];
      this.each(function eachMatched() {
        if (isNodeObject(this)) {
          plans.push(planFormChanges(this as RootNodeInput, target, planOptions));
        }
      });
      return plans;
    }

    return planFormChanges(collectRoots(this, mode), target, planOptions);
  };

  fnObject.applyChanges = function applyChanges(
    this: JQueryCollectionLike,
    plan: ChangePlan,
    options?: ChangePlanPluginOptions
  ): ApplyChangePlanResult | ApplyChangePlanResult[] {
    const mode = options?.mode ?? "first";
    const planOptions = {
      delimiter: options?.delimiter ?? ".",
      useIdIfEmptyName: options?.useIdIfEmptyName ?? false,
      getDisabled: options?.getDisabled ?? false
    };

    if (mode === "all") {
      const results: ApplyChangePlanResult[] = [];
      this.each(function eachMatched() {
        if (isNodeObject(this)) {
          results.push(applyFormChanges(this as RootNodeInput, plan, planOptions));
        }
      });
      return results;
    }

    return applyFormChanges(collectRoots(this, mode), plan, planOptions);
  };
}

export function maybeAutoInstallPlugin(scope: unknown = globalThis): void {
  if (!isJQueryLike(scope)) {
    return;
  }

  const jqueryLike = scope as JQueryLike;
  if (jqueryLike.fn) {
    installToObjectPlugin(jqueryLike);
  }
}
