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

export type DomPlanRootNode =
  | string
  | Node
  | NodeListOf<Node>
  | Node[]
  | HTMLCollection
  | null
  | undefined;

export interface DomPlanOptions extends CreateChangePlanOptions {
  useIdIfEmptyName?: boolean;
  getDisabled?: boolean;
  document?: Document;
  nodeCallback?: (node: Node) => boolean | undefined;
}

type ControlKind = PlanControlRef["kind"];

interface RawControl {
  node: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;
  rawName: string;
  disabled: boolean;
}

function nodeNameIs(node: Node, expected: string): boolean {
  return node.nodeName.toUpperCase() === expected;
}

function isInputNode(node: Node): node is HTMLInputElement {
  return nodeNameIs(node, "INPUT");
}

function isTextareaNode(node: Node): node is HTMLTextAreaElement {
  return nodeNameIs(node, "TEXTAREA");
}

function isSelectNode(node: Node): node is HTMLSelectElement {
  return nodeNameIs(node, "SELECT");
}

function isSupportedField(node: Node): node is RawControl["node"] {
  return isInputNode(node) || isTextareaNode(node) || isSelectNode(node);
}

function isButtonLikeType(inputType: string): boolean {
  return /^(button|reset|submit|image)$/i.test(inputType);
}

function getFirstLegendChild(fieldset: Element): Element | null {
  for (let index = 0; index < fieldset.children.length; index += 1) {
    const child = fieldset.children[index];
    if (child?.nodeName.toUpperCase() === "LEGEND") {
      return child;
    }
  }

  return null;
}

function isDisabledByAncestorFieldset(node: Element): boolean {
  let ancestor: Element | null = node.parentElement;

  while (ancestor) {
    const isDisabledFieldset =
      nodeNameIs(ancestor, "FIELDSET") &&
      "disabled" in ancestor &&
      Boolean((ancestor as { disabled?: boolean }).disabled);

    if (isDisabledFieldset) {
      const firstLegend = getFirstLegendChild(ancestor);
      if (firstLegend?.contains(node)) {
        ancestor = ancestor.parentElement;
        continue;
      }

      return true;
    }

    ancestor = ancestor.parentElement;
  }

  return false;
}

function isEffectivelyDisabled(node: RawControl["node"]): boolean {
  if ("disabled" in node && Boolean((node as { disabled?: boolean }).disabled)) {
    return true;
  }

  return isDisabledByAncestorFieldset(node);
}

function resolveRootNodes(
  rootNode: DomPlanRootNode,
  options: DomPlanOptions
): Node[] {
  if (!rootNode) {
    return [];
  }

  if (typeof rootNode === "string") {
    const doc =
      options.document ??
      (typeof document !== "undefined" ? document : null);
    const element = doc?.getElementById(rootNode) ?? null;
    return element ? [element] : [];
  }

  if (typeof rootNode === "object" && rootNode !== null && "nodeType" in rootNode) {
    return [rootNode as Node];
  }

  const collection = rootNode as ArrayLike<Node>;
  const nodes: Node[] = [];
  for (let index = 0; index < collection.length; index += 1) {
    const node = collection[index];
    if (node) {
      nodes.push(node);
    }
  }

  return nodes;
}

function getFieldName(node: Element, useIdIfEmptyName: boolean): string {
  const namedNode = node as Element & { name?: string; id?: string };

  if (namedNode.name && namedNode.name !== "") {
    return namedNode.name;
  }

  if (useIdIfEmptyName && namedNode.id && namedNode.id !== "") {
    return namedNode.id;
  }

  return "";
}

function collectRawControls(
  roots: Node[],
  options: DomPlanOptions
): RawControl[] {
  const collected: RawControl[] = [];

  function visit(node: ChildNode | null): void {
    while (node) {
      if (node.nodeType === 1) {
        const element = node as Element;

        if (isSupportedField(element)) {
          const field = element as RawControl["node"];
          const skip = options.nodeCallback?.(field);
          const inputType = isInputNode(field) ? field.type.toLowerCase() : "";

          if (skip !== false && (!isInputNode(field) || !isButtonLikeType(inputType))) {
            const rawName = getFieldName(element, options.useIdIfEmptyName ?? false);
            if (rawName !== "") {
              collected.push({
                node: field,
                rawName,
                disabled: isEffectivelyDisabled(field)
              });
            }
          }
        }
      }

      if (node.hasChildNodes?.()) {
        visit(node.firstChild);
      }

      node = node.nextSibling;
    }
  }

  for (const root of roots) {
    if (isSupportedField(root)) {
      const rawName = getFieldName(root, options.useIdIfEmptyName ?? false);
      if (rawName !== "") {
        collected.push({
          node: root,
          rawName,
          disabled: isEffectivelyDisabled(root)
        });
      }
    } else {
      visit(root.firstChild);
    }
  }

  return collected;
}

interface ControlGroup {
  path: string;
  rawName: string;
  kind: ControlKind;
  leafKind: "scalar" | "array";
  members: RawControl[];
}

function describeControlKind(raw: RawControl): ControlKind {
  if (isInputNode(raw.node)) {
    const inputType = raw.node.type.toLowerCase();
    if (inputType === "checkbox") {
      return "checkbox";
    }

    if (inputType === "radio") {
      return "radio";
    }

    if (inputType === "file") {
      return "file";
    }
  }

  if (isSelectNode(raw.node)) {
    return raw.node.multiple ? "select-multiple" : "select-one";
  }

  return "text";
}

function hasTrailingArrayBracket(name: string): boolean {
  return name.endsWith("[]");
}

function groupControls(
  rawControls: RawControl[],
  delimiter: string
): ControlGroup[] {
  const canonicalizer = createFieldNameCanonicalizer(delimiter);
  const groups = new Map<string, ControlGroup & { checkboxArray: boolean }>();

  for (const raw of rawControls) {
    const inputType = isInputNode(raw.node) ? raw.node.type.toLowerCase() : "";
    const isCheckbox = inputType === "checkbox";
    const isRadio = inputType === "radio";
    const isMultiSelect = isSelectNode(raw.node) && raw.node.multiple;
    const explicitArray = hasTrailingArrayBracket(raw.rawName);
    const kind = describeControlKind(raw);

    let path: string;
    let leafKind: "scalar" | "array";

    if (isCheckbox) {
      path = canonicalizer.canonicalize(raw.rawName.replace(/\[\]$/, ""));
      leafKind = explicitArray ? "array" : "scalar";
    } else if (isRadio) {
      path = canonicalizer.canonicalize(raw.rawName.replace(/\[\]$/, ""));
      leafKind = "scalar";
    } else if (isMultiSelect) {
      const stripped = raw.rawName.replace(/\[\]$/, "");
      path = canonicalizer.canonicalize(stripped.replace(/\[\d+\]$/, ""));
      leafKind = "array";
    } else {
      path = canonicalizer.canonicalize(raw.rawName);
      leafKind = "scalar";
    }

    const key = `${kind}:${path}`;
    const existing = groups.get(key);

    if (existing) {
      existing.members.push(raw);
      if (isCheckbox && (explicitArray || existing.members.length > 1)) {
        existing.leafKind = "array";
        existing.checkboxArray = true;
      }
    } else {
      groups.set(key, {
        path,
        rawName: raw.rawName,
        kind,
        leafKind: isCheckbox && explicitArray ? "array" : leafKind,
        members: [raw],
        checkboxArray: isCheckbox && explicitArray
      });
    }
  }

  for (const group of groups.values()) {
    if (group.kind === "checkbox" && !group.checkboxArray) {
      group.leafKind = "scalar";
    }
  }

  const indexedGroups = new Map<
    string,
    { paths: string[]; members: RawControl[]; rawName: string }
  >();

  for (const group of [...groups.values()]) {
    const match = group.path.match(/^(.*)\[(\d+)\]$/);
    if (
      match &&
      group.kind === "text" &&
      !hasTrailingArrayBracket(group.rawName)
    ) {
      const parentPath = match[1] ?? group.path;
      const bucket = indexedGroups.get(parentPath) ?? { paths: [], members: [], rawName: group.rawName };
      bucket.paths.push(group.path);
      bucket.members.push(...group.members);
      indexedGroups.set(parentPath, bucket);
      groups.delete(`${group.kind}:${group.path}`);
    }
  }

  const merged: ControlGroup[] = [...groups.values()];

  for (const [parentPath, bucket] of indexedGroups) {
    merged.push({
      path: parentPath,
      rawName: bucket.rawName,
      kind: "repeat-scalar",
      leafKind: "array",
      members: bucket.members
    });
  }

  return merged;
}

function isFileInput(node: RawControl["node"]): node is HTMLInputElement {
  return isInputNode(node) && node.type.toLowerCase() === "file";
}

function readSelectedValues(select: HTMLSelectElement): string[] {
  const result: string[] = [];
  const options = select.options;
  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (option?.selected) {
      result.push(option.value);
    }
  }

  return result;
}

function fingerprintPart(value: unknown, extra?: Record<string, unknown>): string {
  return JSON.stringify({ v: value, ...(extra ?? {}) });
}

export function createDomPlanAdapter(
  rootNode: DomPlanRootNode,
  options: DomPlanOptions = {}
): PlanAdapter {
  const delimiter = options.delimiter ?? ".";
  const roots = resolveRootNodes(rootNode, options);
  const rawControls = collectRawControls(roots, options);
  const groups = groupControls(rawControls, delimiter);
  const controls: PlanControl[] = [];

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex += 1) {
    const group = groups[groupIndex];
    if (!group) {
      continue;
    }

    const groupId = `dom:${groupIndex}:${group.path}`;

    if (group.kind === "checkbox" || group.kind === "radio") {
      const members = group.members;
      const allDisabled = members.every((member) => member.disabled) && !(options.getDisabled ?? false);
      const ref: PlanControlRef = {
        id: groupId,
        adapter: "dom",
        kind: group.kind,
        name: group.rawName,
        path: group.path,
        ...(allDisabled ? { disabled: true } : {}),
        label: members.map((member) => (member.node as HTMLInputElement).value).join("|")
      };

      controls.push({
        id: groupId,
        ref,
        path: group.path,
        leafKind: group.leafKind,
        ordered: false,
        disabled: allDisabled,
        readValue() {
          if (group.leafKind === "array") {
            return members
              .map((item) => item.node as HTMLInputElement)
              .filter((item) => item.checked)
              .map((item) => item.value);
          }

          const checked = members.find((item) => (item.node as HTMLInputElement).checked);
          return checked ? (checked.node as HTMLInputElement).value : null;
        },
        fingerprint() {
          return fingerprintPart(
            members.map((item) => ({
              value: (item.node as HTMLInputElement).value,
              checked: (item.node as HTMLInputElement).checked,
              disabled: (item.node as HTMLInputElement).disabled
            }))
          );
        },
        canRepresent(value) {
          return canRepresentToggle(group.kind as "checkbox" | "radio", group.leafKind, members, value);
        },
        apply(item) {
          applyToggleChange(group.kind as "checkbox" | "radio", group.leafKind, members, item);
        }
      });
      continue;
    }

    if (group.kind === "repeat-scalar") {
      const members = group.members;
      const allDisabled = members.every((member) => member.disabled) && !(options.getDisabled ?? false);
      const ref: PlanControlRef = {
        id: groupId,
        adapter: "dom",
        kind: "repeat-scalar",
        name: group.rawName,
        path: group.path,
        ...(allDisabled ? { disabled: true } : {})
      };

      controls.push({
        id: groupId,
        ref,
        path: group.path,
        leafKind: "array",
        disabled: allDisabled,
        readValue() {
          return members.map((member) => (member.node as HTMLInputElement).value);
        },
        fingerprint() {
          return fingerprintPart(
            members.map((member) => ({
              value: (member.node as HTMLInputElement).value,
              disabled: (member.node as HTMLInputElement).disabled
            }))
          );
        },
        canRepresent(value) {
          if (value === null || value === "") {
            return { representable: true, lossless: true };
          }

          if (
            !Array.isArray(value) ||
            value.some((item) => item !== null && typeof item === "object")
          ) {
            return {
              representable: false,
              lossless: false,
              message: `Repeated scalar controls at ${group.path} require an array of scalar values.`
            };
          }

          return { representable: true, lossless: value.every((item) => typeof item === "string") };
        },
        apply(item) {
          applyRepeatScalarChange(members, item);
        }
      });
      continue;
    }

    const primary = group.members[0];
    if (!primary) {
      continue;
    }

    const node = primary.node;
    const ref: PlanControlRef = {
      id: groupId,
      adapter: "dom",
      kind: group.kind,
      name: primary.rawName,
      path: group.path,
      ...(primary.disabled ? { disabled: true } : {})
    };

    controls.push({
      id: groupId,
      ref,
      path: group.path,
      leafKind: group.leafKind,
      ordered: group.kind === "select-multiple" ? false : true,
      disabled: primary.disabled && !(options.getDisabled ?? false),
      readValue() {
        return readDomValue(node, group.leafKind);
      },
      fingerprint() {
        if (isSelectNode(node)) {
          return fingerprintPart(readSelectedValues(node), {
            multiple: node.multiple,
            disabled: node.disabled
          });
        }

        if (isFileInput(node)) {
          return fingerprintPart(
            [...(node.files ?? [])].map((file) => ({
              name: file.name,
              size: file.size,
              type: file.type,
              lastModified: file.lastModified
            })),
            { disabled: node.disabled }
          );
        }

        const textLike = node as HTMLInputElement | HTMLTextAreaElement;
        return fingerprintPart(textLike.value, {
          disabled: "disabled" in textLike ? textLike.disabled : false
        });
      },
      canRepresent(value) {
        return canRepresentField(node, group.leafKind, value);
      },
      apply(item) {
        applyFieldChange(node, group.leafKind, item);
      }
    });
  }

  return {
    name: "dom",
    canCreatePaths: false,
    controls: () => controls
  };
}

function readDomValue(
  node: RawControl["node"],
  leafKind: "scalar" | "array"
): EntryValueLike {
  if (isSelectNode(node)) {
    const values = readSelectedValues(node);
    if (node.multiple || leafKind === "array") {
      return values;
    }

    return values[0] ?? "";
  }

  if (isFileInput(node)) {
    const files = [...(node.files ?? [])];
    if (!node.multiple) {
      return files[0] ?? null;
    }

    return files;
  }

  return (node as HTMLInputElement | HTMLTextAreaElement).value;
}

type EntryValueLike = unknown;

function hasOption(select: HTMLSelectElement, value: string): boolean {
  for (let index = 0; index < select.options.length; index += 1) {
    if (select.options[index]?.value === value) {
      return true;
    }
  }

  return false;
}

function canRepresentField(
  node: RawControl["node"],
  leafKind: "scalar" | "array",
  value: unknown
): ValueCapability {
  if (isFileInput(node)) {
    if (value === null || value === undefined || value === "") {
      return { representable: true, lossless: true };
    }

    const isFileValue = (candidate: unknown): boolean => {
      if (typeof candidate !== "object" || candidate === null) {
        return false;
      }

      const candidateRecord = candidate as Record<string, unknown>;
      const tag = Object.prototype.toString.call(candidate);
      return (
        (tag === "[object File]" || tag === "[object Blob]") &&
        typeof candidateRecord.name === "string" &&
        typeof candidateRecord.size === "number"
      );
    };

    if (node.multiple) {
      if (!Array.isArray(value) || !value.every(isFileValue)) {
        return {
          representable: false,
          lossless: false,
          message: "Multiple file inputs only accept arrays of File values."
        };
      }

      return { representable: true, lossless: true };
    }

    if (!isFileValue(value)) {
      return {
        representable: false,
        lossless: false,
        message: "File inputs cannot represent non-File values; assign a File or FileList programmatically."
      };
    }

    if (typeof DataTransfer === "undefined") {
      return {
        representable: false,
        lossless: false,
        message: "This environment cannot assign File values to file inputs (DataTransfer is unavailable)."
      };
    }

    return { representable: true, lossless: true };
  }

  if (isSelectNode(node)) {
    if (node.multiple || leafKind === "array") {
      if (value === null || value === undefined || value === "") {
        return { representable: true, lossless: true };
      }

      if (!Array.isArray(value)) {
        return {
          representable: false,
          lossless: false,
          message: "Multi-select controls require an array of option values."
        };
      }

      const missing = (value as unknown[]).find((item: unknown) => !hasOption(node, String(item)));
      if (missing !== undefined) {
        return {
          representable: false,
          lossless: false,
          message: `Option "${String(missing)}" does not exist on the select control.`
        };
      }

      return { representable: true, lossless: value.every((item) => typeof item === "string") };
    }

    if (value === null || value === undefined || value === "") {
      return { representable: true, lossless: true };
    }

    if (Array.isArray(value) || typeof value === "object") {
      return {
        representable: false,
        lossless: false,
        message: "Single-select controls require a scalar option value."
      };
    }

    if (!hasOption(node, String(value))) {
      return {
        representable: false,
        lossless: false,
        message: `Option "${String(value)}" does not exist on the select control.`
      };
    }

    return { representable: true, lossless: typeof value === "string" };
  }

  if (value === null || value === undefined) {
    return { representable: true, lossless: true };
  }

  if (typeof value === "object") {
    return {
      representable: false,
      lossless: false,
      message: "Text-like controls cannot represent objects or arrays."
    };
  }

  return { representable: true, lossless: typeof value === "string" };
}

function applyFieldChange(
  node: RawControl["node"],
  leafKind: "scalar" | "array",
  item: ChangeItem
): void {
  if (isFileInput(node)) {
    const assignFiles = (files: File[]): void => {
      if (typeof DataTransfer !== "undefined") {
        const dataTransfer = new DataTransfer();
        for (const file of files) {
          dataTransfer.items.add(file);
        }
        node.files = dataTransfer.files;
        return;
      }

      const fileList = {
        length: files.length,
        item(index: number): File | null {
          return files[index] ?? null;
        },
        ...files.map((file, index) => ({ [index]: file })).reduce(
          (acc, entry) => Object.assign(acc, entry),
          {}
        )
      } as unknown as FileList;
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "files");
      descriptor?.set?.call(node, fileList);
    };

    if (item.kind === "clear" || item.kind === "remove" || item.newValue === null || item.newValue === undefined || item.newValue === "") {
      assignFiles([]);
      return;
    }

    const files = Array.isArray(item.newValue)
      ? (item.newValue as File[])
      : [item.newValue as File];
    assignFiles(files);
    return;
  }

  if (isSelectNode(node)) {
    if (node.multiple || leafKind === "array") {
      if (item.kind === "clear") {
        for (let index = 0; index < node.options.length; index += 1) {
          const option = node.options[index];
          if (option) {
            option.selected = false;
          }
        }
        return;
      }

      if (item.kind === "remove") {
        for (let index = 0; index < node.options.length; index += 1) {
          const option = node.options[index];
          if (option?.value === String(item.oldValue)) {
            option.selected = false;
          }
        }
        return;
      }

      if (item.kind === "append" || (item.kind === "set" && !Array.isArray(item.newValue))) {
        for (let index = 0; index < node.options.length; index += 1) {
          const option = node.options[index];
          if (option?.value === String(item.newValue)) {
            option.selected = true;
          }
        }
        return;
      }

      const wantedValues = Array.isArray(item.newValue) ? item.newValue : [];
      const wanted = new Set(wantedValues.map((value) => String(value)));
      for (let index = 0; index < node.options.length; index += 1) {
        const option = node.options[index];
        if (option) {
          option.selected = wanted.has(option.value);
        }
      }
      return;
    }

    if (item.kind === "clear" || item.kind === "remove" || item.newValue === null || item.newValue === undefined || item.newValue === "") {
      const hasEmptyOption = [...node.options].some((option) => option.value === "");
      node.selectedIndex = hasEmptyOption ? [...node.options].findIndex((option) => option.value === "") : 0;
      return;
    }

    for (let index = 0; index < node.options.length; index += 1) {
      const option = node.options[index];
      if (option) {
        option.selected = option.value === String(item.newValue);
      }
    }
    return;
  }

  const textNode = node as HTMLInputElement | HTMLTextAreaElement;
  if (item.kind === "clear" || item.kind === "remove" || item.newValue === null || item.newValue === undefined) {
    textNode.value = "";
    return;
  }

  textNode.value = String(item.newValue);
}

function canRepresentToggle(
  kind: "checkbox" | "radio",
  leafKind: "scalar" | "array",
  members: RawControl[],
  value: unknown
): ValueCapability {
  const inputs = members.map((member) => member.node as HTMLInputElement);
  const values = new Set(inputs.map((input) => input.value));

  if (leafKind === "array") {
    if (value === null || value === undefined || value === "") {
      return { representable: true, lossless: true };
    }

    if (!Array.isArray(value)) {
      return {
        representable: false,
        lossless: false,
        message: "Checkbox groups with array semantics require an array of values."
      };
    }

    const missing = (value as unknown[]).find((item: unknown) => item !== true && !values.has(String(item)));
    if (missing !== undefined) {
      return {
        representable: false,
        lossless: false,
        message: `No checkbox with value "${String(missing)}" exists in the group.`
      };
    }

    return { representable: true, lossless: value.every((item) => typeof item === "string") || value.length === 0 };
  }

  if (value === null || value === undefined || value === "") {
    return { representable: true, lossless: true };
  }

  if (value === true) {
    return { representable: true, lossless: true };
  }

  if (value === false) {
    return {
      representable: false,
      lossless: false,
      message: `${kind} groups cannot represent false; use null to clear the selection.`
    };
  }

  if (Array.isArray(value) || typeof value === "object") {
    return {
      representable: false,
      lossless: false,
      message: `Scalar ${kind} groups require a single matching value.`
    };
  }

  if (!values.has(String(value))) {
    return {
      representable: false,
      lossless: false,
      message: `No ${kind} with value "${String(value)}" exists in the group.`
    };
  }

  return { representable: true, lossless: typeof value === "string" };
}

function applyToggleChange(
  kind: "checkbox" | "radio",
  leafKind: "scalar" | "array",
  members: RawControl[],
  item: ChangeItem
): void {
  const inputs = members.map((member) => member.node as HTMLInputElement);

  if (leafKind === "array") {
    if (item.kind === "clear" || item.kind === "remove") {
      for (const input of inputs) {
        const removedValue = item.kind === "remove" ? item.oldValue : null;
        if (removedValue === null || input.value === String(removedValue)) {
          input.checked = false;
        }
      }
      return;
    }

    const wantedValues = Array.isArray(item.newValue)
      ? item.newValue
      : item.newValue === null || item.newValue === ""
        ? []
        : [item.newValue];

    if (wantedValues.length > 1 || !/\[\d+\]$/.test(item.path)) {
      for (const input of inputs) {
        if (input.value === String(item.newValue)) {
          input.checked = true;
        }
      }
      return;
    }

    const wanted = new Set(wantedValues.map((value) => String(value)));
    for (const input of inputs) {
      input.checked = wanted.has(input.value);
    }
    return;
  }

  if (item.kind === "clear" || item.kind === "remove" || item.newValue === null || item.newValue === "" || item.newValue === false) {
    for (const input of inputs) {
      input.checked = false;
    }
    return;
  }

  for (const input of inputs) {
    input.checked = item.newValue === true || input.value === String(item.newValue);
  }

  void kind;
}

export function createDomChangePlan(
  rootNode: DomPlanRootNode,
  target: unknown,
  options: DomPlanOptions = {}
): ChangePlan {
  const adapter = createDomPlanAdapter(rootNode, options);
  const planOptions: CreateChangePlanOptions = {};
  if (options.delimiter !== undefined) planOptions.delimiter = options.delimiter;
  if (options.allowUnsafePathSegments !== undefined) {
    planOptions.allowUnsafePathSegments = options.allowUnsafePathSegments;
  }
  if (options.allowMissingControls !== undefined) {
    planOptions.allowMissingControls = options.allowMissingControls;
  }
  return createChangePlan(adapter, target, planOptions);
}

export function previewDomChangePlan(
  rootNode: DomPlanRootNode,
  target: unknown,
  options: DomPlanOptions = {}
): ChangePlan {
  return createDomChangePlan(rootNode, target, options);
}

export function applyDomChangePlan(
  rootNode: DomPlanRootNode,
  plan: ChangePlan
): PlanApplyOutcome {
  const adapter = createDomPlanAdapter(rootNode, {
    delimiter: plan.delimiter
  });
  return applyChangePlan(adapter, plan);
}

export function createDomPlanCommitter(
  rootNode: DomPlanRootNode,
  target: unknown,
  options: DomPlanOptions = {}
): { plan: ChangePlan; apply: () => PlanApplyOutcome } {
  const plan = createDomChangePlan(rootNode, target, options);
  return {
    plan,
    apply: () => applyDomChangePlan(rootNode, plan)
  };
}

function applyRepeatScalarChange(members: RawControl[], item: ChangeItem): void {
  const match = item.path.match(/\[(\d+)\]$/);

  if (item.kind === "clear" && !match) {
    for (const member of members) {
      (member.node as HTMLInputElement).value = "";
    }
    return;
  }

  if (match) {
    const index = Number(match[1]);
    const member = members[index];
    if (!member) {
      return;
    }

    const input = member.node as HTMLInputElement;
    if (item.kind === "remove") {
      if (index === members.length - 1) {
        input.value = "";
      } else {
        for (let shiftIndex = index; shiftIndex < members.length - 1; shiftIndex += 1) {
          const current = members[shiftIndex]?.node as HTMLInputElement | undefined;
          const next = members[shiftIndex + 1]?.node as HTMLInputElement | undefined;
          if (current && next) {
            current.value = next.value;
          }
        }

        const last = members[members.length - 1]?.node as HTMLInputElement | undefined;
        if (last) {
          last.value = "";
        }
      }
      return;
    }

    input.value = item.newValue === null || item.newValue === undefined ? "" : String(item.newValue);
  }
}
