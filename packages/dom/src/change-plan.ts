import {
  applyChangePlan,
  createChangePlan,
  fingerprintValue,
  sourceIdentityFor,
  type ApplyChangePlanResult,
  type ChangePlan,
  type ChangePlanItem,
  type ChangePlanSource,
  type Entry
} from "@form2js/core";

import {
  extractPairs,
  type ExtractOptions,
  type FormToObjectOptions,
  type RootNodeInput
} from "./index";

export interface FormChangePlanOptions extends FormToObjectOptions {
  prune?: boolean;
}

type SupportedControl = HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

interface DomControl {
  id: string;
  name: string;
  node: SupportedControl;
}

const ARRAY_INDEX_REGEXP = /\[\d+\]/g;

function isNodeObject(value: unknown): value is Node {
  return typeof value === "object" && value !== null && "nodeType" in value && "nodeName" in value;
}

function nodeNameIs(node: Node, expected: string): boolean {
  return node.nodeName.toUpperCase() === expected;
}

function isControlNode(node: Node): node is SupportedControl {
  return nodeNameIs(node, "INPUT") || nodeNameIs(node, "TEXTAREA") || nodeNameIs(node, "SELECT");
}

function isButtonLikeControl(node: SupportedControl): boolean {
  return nodeNameIs(node, "INPUT") && /^(button|reset|submit|image)$/i.test((node as HTMLInputElement).type);
}

function isNodeListLike(value: RootNodeInput): value is Node[] | NodeListOf<Node> | HTMLCollection {
  if (!value || typeof value === "string") {
    return false;
  }

  return !isNodeObject(value) && typeof value === "object" && "length" in value;
}

function resolveDocument(rootNode: RootNodeInput, fallback?: Document): Document {
  if (fallback) {
    return fallback;
  }

  if (typeof document !== "undefined") {
    return document;
  }

  if (isNodeObject(rootNode) && rootNode.ownerDocument) {
    return rootNode.ownerDocument;
  }

  throw new Error("No document available. Provide options.document when running outside a browser.");
}

function collectControlNodes(rootNode: RootNodeInput, options: ExtractOptions): SupportedControl[] {
  const controls: SupportedControl[] = [];

  const visit = (node: Node): void => {
    if (isControlNode(node)) {
      if (!isButtonLikeControl(node)) {
        controls.push(node);
      }
      return;
    }

    let child = node.firstChild;
    while (child) {
      visit(child);
      child = child.nextSibling;
    }
  };

  const resolvedRoot = resolveRootAnchor(rootNode, options);

  if (!resolvedRoot) {
    return controls;
  }

  if (isNodeListLike(resolvedRoot)) {
    for (let index = 0; index < resolvedRoot.length; index += 1) {
      const node = resolvedRoot[index];
      if (isNodeObject(node)) {
        visit(node);
      }
    }
    return controls;
  }

  if (isNodeObject(resolvedRoot)) {
    visit(resolvedRoot);
  }

  return controls;
}

function resolveRootAnchor(rootNode: RootNodeInput, options: ExtractOptions): RootNodeInput {
  if (typeof rootNode === "string") {
    return resolveDocument(rootNode, options.document).getElementById(rootNode);
  }

  return rootNode;
}

function resolveIdentityAnchor(rootNode: RootNodeInput, options: ExtractOptions): Node | null {
  const resolved = resolveRootAnchor(rootNode, options);

  if (isNodeListLike(resolved)) {
    const first = resolved[0];
    return isNodeObject(first) ? first : null;
  }

  return isNodeObject(resolved) ? resolved : null;
}

function controlName(node: SupportedControl, useIdIfEmptyName: boolean): string {
  const named = node as SupportedControl & { name?: string; id?: string };

  if (named.name && named.name !== "") {
    return named.name;
  }

  if (useIdIfEmptyName && named.id && named.id !== "") {
    return named.id;
  }

  return "";
}

function collectControls(rootNode: RootNodeInput, options: ExtractOptions): DomControl[] {
  const nodes = collectControlNodes(rootNode, options);
  const useIdIfEmptyName = options.useIdIfEmptyName ?? false;
  const named: { name: string; node: SupportedControl }[] = [];

  for (const node of nodes) {
    const name = controlName(node, useIdIfEmptyName);
    if (name !== "") {
      named.push({ name, node });
    }
  }

  const nameCounts = new Map<string, number>();
  for (const entry of named) {
    nameCounts.set(entry.name, (nameCounts.get(entry.name) ?? 0) + 1);
  }

  const nameSeen = new Map<string, number>();

  return named.map((entry) => {
    const total = nameCounts.get(entry.name) ?? 1;
    const seen = (nameSeen.get(entry.name) ?? 0) + 1;
    nameSeen.set(entry.name, seen);

    return {
      id: total > 1 ? `${entry.name}#${seen}` : entry.name,
      name: entry.name,
      node: entry.node
    };
  });
}

function isCheckable(node: SupportedControl): node is HTMLInputElement {
  return nodeNameIs(node, "INPUT") && /^(checkbox|radio)$/i.test((node as HTMLInputElement).type);
}

function isFileInput(node: SupportedControl): node is HTMLInputElement {
  return nodeNameIs(node, "INPUT") && (node as HTMLInputElement).type.toLowerCase() === "file";
}

function controlState(node: SupportedControl): string {
  const disabled = "disabled" in node && node.disabled ? "disabled|" : "";

  if (isCheckable(node)) {
    const input = node as HTMLInputElement;
    return `${disabled}${input.type.toLowerCase()}:${input.checked ? "1" : "0"}:${input.value}`;
  }

  if (isFileInput(node)) {
    const files = node.files ? [...node.files].map((file) => `${file.name}:${file.size}`).join(",") : "";
    return `${disabled}file:${files}`;
  }

  if (nodeNameIs(node, "SELECT")) {
    const select = node as HTMLSelectElement;
    const selected: string[] = [];
    const options = select.getElementsByTagName("option");
    for (let index = 0; index < options.length; index += 1) {
      const option = options[index];
      if (option?.selected) {
        selected.push(option.value);
      }
    }
    return `${disabled}select:${selected.join(",")}`;
  }

  return `${disabled}value:${(node as HTMLInputElement | HTMLTextAreaElement).value}`;
}

function pathCandidates(path: string): string[] {
  const candidates = [path];
  const arraySyntax = path.replace(ARRAY_INDEX_REGEXP, "[]");
  const bareSyntax = path.replace(ARRAY_INDEX_REGEXP, "");

  if (arraySyntax !== path) {
    candidates.push(arraySyntax);
  }

  if (bareSyntax !== path && bareSyntax !== arraySyntax) {
    candidates.push(bareSyntax);
  }

  return candidates;
}

function findControls(controls: DomControl[], path: string): DomControl[] {
  const candidates = pathCandidates(path);
  return controls.filter((control) => candidates.includes(control.name));
}

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

function canExpressValue(value: unknown): boolean {
  if (value === undefined || value === null || value === "") {
    return true;
  }

  const valueType = typeof value;
  return valueType === "string" || valueType === "number" || valueType === "boolean";
}

function setSelectValue(select: HTMLSelectElement, value: unknown, additive: boolean): void {
  const options = select.getElementsByTagName("option");
  const stringValue = String(value);

  for (let index = 0; index < options.length; index += 1) {
    const option = options[index];
    if (!option) {
      continue;
    }

    if (option.value === stringValue) {
      option.selected = true;
    } else if (!additive && !select.multiple) {
      option.selected = false;
    }
  }
}

function clearControl(node: SupportedControl): void {
  if (isCheckable(node)) {
    node.checked = false;
    return;
  }

  if (nodeNameIs(node, "SELECT")) {
    const options = (node as HTMLSelectElement).getElementsByTagName("option");
    for (let index = 0; index < options.length; index += 1) {
      const option = options[index];
      if (option) {
        option.selected = false;
      }
    }
    return;
  }

  (node as HTMLInputElement | HTMLTextAreaElement).value = "";
}

function applySet(controls: DomControl[], value: unknown): void {
  const checkables = controls.filter((control) => isCheckable(control.node));

  if (checkables.length > 0) {
    for (const control of checkables) {
      const input = control.node as HTMLInputElement;
      input.checked = input.value === String(value) || value === true;
    }
    return;
  }

  for (const control of controls) {
    if (nodeNameIs(control.node, "SELECT")) {
      setSelectValue(control.node as HTMLSelectElement, value, false);
    } else if (!isFileInput(control.node)) {
      (control.node as HTMLInputElement | HTMLTextAreaElement).value = String(value ?? "");
    }
  }
}

function applyAppend(controls: DomControl[], value: unknown): void {
  const checkables = controls.filter((control) => isCheckable(control.node));

  if (checkables.length > 0) {
    for (const control of checkables) {
      const input = control.node as HTMLInputElement;
      if (input.value === String(value) || value === true) {
        input.checked = true;
      }
    }
    return;
  }

  for (const control of controls) {
    if (nodeNameIs(control.node, "SELECT")) {
      setSelectValue(control.node as HTMLSelectElement, value, true);
    } else if (!isFileInput(control.node)) {
      (control.node as HTMLInputElement | HTMLTextAreaElement).value = String(value ?? "");
    }
  }
}

function applyRemove(controls: DomControl[], oldValue: unknown): void {
  const checkables = controls.filter((control) => isCheckable(control.node));

  if (checkables.length > 0) {
    for (const control of checkables) {
      const input = control.node as HTMLInputElement;
      if (input.value === String(oldValue)) {
        input.checked = false;
      }
    }
    return;
  }

  for (const control of controls) {
    if (nodeNameIs(control.node, "SELECT")) {
      const options = (control.node as HTMLSelectElement).getElementsByTagName("option");
      for (let index = 0; index < options.length; index += 1) {
        const option = options[index];
        if (option?.value === String(oldValue)) {
          option.selected = false;
        }
      }
    } else if (!isFileInput(control.node)) {
      const textNode = control.node as HTMLInputElement | HTMLTextAreaElement;
      if (textNode.value === String(oldValue)) {
        textNode.value = "";
      }
    }
  }
}

export function createDomChangePlanSource(
  rootNode: RootNodeInput,
  options: ExtractOptions = {}
): ChangePlanSource {
  const rootAnchor = resolveIdentityAnchor(rootNode, options);

  return {
    kind: "dom",
    ...(rootAnchor ? { identity: sourceIdentityFor(rootAnchor) } : {}),
    readEntries(): Entry[] {
      return extractPairs(rootNode, options);
    },
    fingerprint(): string {
      return fingerprintValue(this.snapshotControls());
    },
    snapshotControls(): Record<string, string> {
      const snapshot: Record<string, string> = {};
      for (const control of collectControls(rootNode, options)) {
        snapshot[control.id] = controlState(control.node);
      }
      return snapshot;
    },
    controlsForPath(path: string): string[] {
      return findControls(collectControls(rootNode, options), path).map((control) => control.id);
    },
    canExpress(_path: string, value: unknown): boolean {
      return canExpressValue(value) && !isFileLikeValue(value);
    },
    applyItems(items: ChangePlanItem[]): void {
      const controls = collectControls(rootNode, options);

      for (const item of items) {
        const targets = findControls(controls, item.path);

        switch (item.op) {
          case "set":
            applySet(targets, item.newValue);
            break;
          case "append":
            applyAppend(targets, item.newValue);
            break;
          case "remove":
            applyRemove(targets, item.oldValue);
            break;
          case "clear":
            for (const target of targets) {
              clearControl(target.node);
            }
            break;
          default:
            break;
        }
      }
    }
  };
}

export function planFormChanges(
  rootNode: RootNodeInput,
  target: unknown,
  options: FormChangePlanOptions = {}
): ChangePlan {
  return createChangePlan(createDomChangePlanSource(rootNode, options), target, {
    delimiter: options.delimiter ?? ".",
    prune: options.prune ?? false
  });
}

export function applyFormChanges(
  rootNode: RootNodeInput,
  plan: ChangePlan,
  options: FormChangePlanOptions = {}
): ApplyChangePlanResult {
  return applyChangePlan(createDomChangePlanSource(rootNode, options), plan);
}
