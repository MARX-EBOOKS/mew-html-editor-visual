# PDF mapping relocation demo

This is an isolated demo of moving both complete classes into `pdf-selection-diff.js`.
The resulting file is **1,065 physical lines**, so this attempt does **not** meet the
below-950 target. It would need another 116 lines of reduction to reach 949.
This result does not establish that a deeper redesign cannot reach the target.

| File | Current source | Unchanged relocation | Simplified demo |
| --- | ---: | ---: | ---: |
| pdf-selection-diff.js | 528 | 1,070 | 1,065 |
| pdf-review-provider.js | 928 | 387 | 387 |
| Combined | 1,456 | 1,457 | 1,452 |

Counts include comments and blank lines, with the final newline excluded as an
additional empty line. No comments or blank lines were removed to reduce size.

## Process changes

- Both classes call the comparison, font and page-text functions in their own module
  directly. Mapping no longer needs the provider's mutable `toolbox` binding.
- Source edits use one range-shifting operation for forward connections, reverse
  connections and cached page scopes. Edited passages are discarded; unchanged
  passages retain their cached alignment.
- The shared document-index task now handles cancellation cleanup and rejection
  cleanup itself. All callers receive that task's result.
- The provider gets the two classes from the diff API after loading it. Its existing
  class exports remain compatibility aliases, allowing the unchanged selection
  module to use the same constructors.

The unchanged relocation column already allows for adding the class exports.
The five lines saved by the two process changes, minus the added export line,
give a combined reduction of four lines. Most of the provider's reduction is
movement, not eliminated code.

All methods, Monaco support, fuzzy matching, anchor preparation, original-text
alignment, font handling, insertion handling and cache guards remain present.
Reaching 949 requires further algorithm/process work beyond this small refactor;
the remaining 116 lines have not been removed or hidden in another module.

## Validation

- Syntax checks passed for both demo modules.
- 500 deterministic baseline comparisons passed, covering normalization, lookup,
  source edits, forward/reverse cached connections, page scopes, candidates and
  comparison rows.
- Three real browser load orders passed, including provider registration, selection,
  popup application, refresh and combined source decorations.
- Seven replacement-pattern checks passed: text, insertion, deletion, newline,
  format, word and term.
- Eight focused checks passed: cancellation, source snapshots, bounded/Unicode diff,
  shared extraction/retry, comparison caching, module loading and fallback retry.
- A separate font concurrency check fails on both current source and demo:
  `pageReads` is 2, expected 1. It remains unresolved. This is not a green full suite.

The copied test harness imports the relocated constructors from the diff API.
Its compact-comparison test checks cached diff object identity because replacing
an exported function no longer intercepts calls to a lexical function.

`verify-parity.mjs` also confirms that the production diff/provider files still
match the baseline snapshots. Production files were not edited.

## Reproduce

Run from the repository root:

```powershell
node tmp/pdf-mapping-demo/build.mjs
node tmp/pdf-mapping-demo/prepare-tests.mjs
node --check tmp/pdf-mapping-demo/pdf-selection-diff.js
node --check tmp/pdf-mapping-demo/pdf-review-provider.js
node tmp/pdf-mapping-demo/verify-parity.mjs
node --test tmp/pdf-mapping-demo/tests/pdf-review-api.test.mjs tmp/pdf-mapping-demo/tests/pdf-review-pattern.test.mjs
node --test --test-name-pattern='locator cancels|source/PDF pairs|bounded local|local diff preserves|concurrent page extraction|compact review|provider loads|text-layer fallback' tmp/pdf-mapping-demo/tests/pdf-selection-diff.test.mjs
```

`build.mjs` rebuilds the demo and refreshes its baseline snapshots from the current
production files. It copies the unchanged selection/popup modules so browser tests
can resolve their relative imports within this folder.
