---
"@form2js/core": minor
"@form2js/dom": minor
"@form2js/form-data": minor
"@form2js/js2form": minor
"@form2js/jquery": minor
"@form2js/react": minor
---

Added adapter-neutral change plans: preview stable-sorted `set`/`append`/`remove`/`clear` changes with paths, old/new values, lossless flags and associated controls, plus numbered conflicts (`capability`, `shape`, `disabled`, `no-control`, `unsafe-path`). Plans validate a baseline fingerprint before an all-or-nothing apply, return diffs when controls moved, and stay idempotent on repeated apply. Includes DOM, FormData, jQuery, React (`useChangePlan`) and js2form entry points and playground preview/conflict examples.
