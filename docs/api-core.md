# @form2js/core

`@form2js/core` is the path parsing engine behind the rest of the package family. Use it when you already have key/value entries, need to turn them into nested objects, or want to flatten nested data back into entry form.

## Installation

```bash
npm install @form2js/core
```

Standalone/global build is not shipped for this package.

## General Example

```ts
import { entriesToObject, objectToEntries } from "@form2js/core";

const data = entriesToObject([
  { key: "person.name.first", value: "Esme" },
  { key: "person.roles[]", value: "witch" },
]);

const flat = objectToEntries(data);
```

## Types and Properties

### Exported Surface

| Export | Kind | What it does |
| --- | --- | --- |
| `createMergeContext` | function | Creates merge state used while parsing indexed arrays. |
| `setPathValue` | function | Applies one path/value into an object tree. |
| `entriesToObject` | function | Main parser for iterable entries. |
| `objectToEntries` | function | Flattens nested object/array data into `{ key, value }` entries. |
| `processNameValues` | function | Compatibility helper for `{ name, value }` input. |
| `Entry`, `EntryInput`, `EntryValue`, `NameValuePair`, `ObjectTree`, `ParseOptions`, `MergeContext`, `MergeOptions`, `SchemaValidator`, `ValidationOptions`, `InferSchemaOutput` | types | Public type surface for parser inputs, options, and results. |

```ts
export function createMergeContext(): MergeContext;

export function setPathValue(
  target: ObjectTree,
  path: string,
  value: EntryValue,
  options?: MergeOptions
): ObjectTree;

export function entriesToObject(entries: Iterable<EntryInput>, options?: ParseOptions): ObjectTree;
export function entriesToObject<TSchema extends SchemaValidator>(
  entries: Iterable<EntryInput>,
  options: ParseOptions & { schema: TSchema }
): InferSchemaOutput<TSchema>;

export function objectToEntries(value: unknown): Entry[];

export function processNameValues(
  nameValues: Iterable<NameValuePair>,
  skipEmpty?: boolean,
  delimiter?: string
): ObjectTree;
```

### Options And Defaults

| Option | Default | Where | Why this matters |
| --- | --- | --- | --- |
| `delimiter` | `"."` | `entriesToObject`, `setPathValue`, `processNameValues` | Controls how dot-like path chunks are split. |
| `skipEmpty` | `true` | `entriesToObject`, `processNameValues` | Drops `""` and `null` values unless you opt out. |
| `allowUnsafePathSegments` | `false` | `entriesToObject`, `setPathValue` | Blocks prototype-pollution path segments unless you explicitly trust the source. |
| `schema` | unset | `entriesToObject` | Runs `schema.parse(parsedObject)` and returns schema output type. |
| `context` | fresh merge context | `setPathValue` | Keeps indexed array compaction stable across multiple writes. |

### Schema validation

Use `schema` when you want parsing and validation in the same step. The parser only requires a structural `{ parse(unknown) }` contract, so this works with Zod and similar validators.

```ts
import { z } from "zod";
import { entriesToObject } from "@form2js/core";

const PersonSchema = z.object({
  person: z.object({
    age: z.coerce.number().int().min(0),
    email: z.string().email()
  })
});

const rawEntries = [
  { key: "person.age", value: "17" },
  { key: "person.email", value: "esk@example.com" }
];

const result = entriesToObject(rawEntries, { schema: PersonSchema });
```

### `skipEmpty: false`

Opt out of the default empty-value filtering when blank strings are meaningful in your payload.

```ts
import { entriesToObject } from "@form2js/core";

const result = entriesToObject(
  [{ key: "person.nickname", value: "" }],
  { skipEmpty: false }
);
```

### Behavior Notes

- Indexed array keys are compacted by encounter order, not preserved by numeric index.
- `EntryInput` accepts `[key, value]`, `{ key, value }`, and `{ name, value }`.
- If `schema` is provided, parser output is passed to `schema.parse()` and schema errors are rethrown.
- `objectToEntries` emits bracket indexes for arrays such as `emails[0]` and only serializes own enumerable properties.

## Change Plans

`@form2js/core` hosts the adapter-neutral change plan engine. A plan previews how a target object would rewrite the current state before anything is committed.

```ts
import { applyChangePlan, createChangePlan, planChanges } from "@form2js/core";

const plan = planChanges(
  { person: { name: "Esme" } },
  { person: { name: "Tiffany" } }
);
// plan.items -> [{ id: "F2J-OP-0001", op: "set", path: "person.name", ... }]
```

- `planChanges(current, target, options?)` builds a plan from two object trees without any adapter.
- `createChangePlan(source, target, options?)` builds a plan against a `ChangePlanSource` (DOM, FormData, or custom), attaching associated controls and adapter capability to every item.
- `applyChangePlan(source, plan)` verifies the baseline fingerprint before applying. If any associated control changed since planning, the whole plan is rejected with a `baselineDiff`; partial application never happens. Applying the same plan twice returns the first result without re-running `applyItems`.

### Plan Items and Semantics

- Items are stably sorted by canonical path and carry sequential ids (`F2J-OP-0001`, ...).
- `set` replaces a scalar, `append` adds array entries beyond the current length, `remove` drops truncated array entries (or pruned keys with `prune: true`), and `clear` empties a control when the target is `""` or `null`.
- `undefined` target values are treated as missing and left untouched; keys only present in the current structure are kept unless `prune: true`.
- File-like values compare by `name`/`size`/`lastModified` metadata; whether they are losslessly expressible depends on the adapter.
- Paths containing `__proto__`, `prototype`, or `constructor` become `F2J-C001` conflicts and are never applied.

### Conflict Codes

| Code | Meaning |
| --- | --- |
| `F2J-C001` | Unsafe (prototype-pollution) path segment. |
| `F2J-C002` | Current and target values disagree on container shape. |
| `F2J-C003` | The source adapter cannot losslessly express the value. |
| `F2J-C004` | Two target keys flatten to the same canonical path. |
| `F2J-C005` | No control is bound to the canonical path. |

Plans containing any conflict item are rejected wholesale by `applyChangePlan`.
