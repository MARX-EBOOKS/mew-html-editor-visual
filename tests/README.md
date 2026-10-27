# Test suites

Run commands from the repository root after `npm ci`.

| Command | Coverage |
| --- | --- |
| `npm test` | Node unit tests; no browser launch or Playwright import |
| `npm run test:browser` | Browser contracts, then every `*-browser.mjs` script, serially |
| `npm run test:backend` | Python reader HTTP and prepared OCR cache contracts |
| `npm run test:all` | All three groups; continues after failures and exits nonzero if any group fails |
| `npm run test:monaco` | Existing focused Monaco browser entry point |
| `npm run bench -- tmp/ocr-benchmark.json` | Real OCR mapping benchmark and optional JSON report |
| `node tests/pdf-review-performance.mjs [report.json]` | Review candidate, fragmented decoration and cached preparation scaling |
| `node tests/pdf-mapping-profile.mjs [fixture.json] [report.json]` | Real-page mapping profile with method call counts and costs |

Suite timings and exit codes can also be saved with
`node tests/run.mjs all --report=tmp/test-results.json`. Create the output directory first.
The runner discovers files rather than maintaining a second list of test scripts.
Browser files run serially because they use local ports and contain latency assertions.
Run only one browser runner at a time.

Browser tests need Playwright and Microsoft Edge on the usual Windows installation
path, or Playwright's installed Chromium (`npx playwright install chromium`).
`EDGE_PATH` selects another executable; `PLAYWRIGHT_MODULE` selects another installed
Playwright module. `PYTHON` selects the Python executable. Backend tests need
PyMuPDF, FastAPI and Uvicorn; OCR browser fixtures also need Python dependencies
used by `pdf_text_backend.py` and `html_pattern_scripts`.

`*.test.mjs` contains unit coverage; `*.browser.test.mjs` contains browser contracts.
The PDF selection suites were split by runtime, retaining their assertions.
`pdf-review-api.test.mjs` and `review-highlights.test.mjs` now have the
`.browser.test.mjs` suffix. Use the npm commands to select a runtime; a raw
`node --test tests/*.test.mjs` glob includes both kinds.

`support/browser.mjs` owns browser selection and Node server readiness/shutdown.
`support/pdf-harness.mjs` owns the shared adapter for private PDF helpers. It reads
current production source and checks extraction boundaries. The browser API suite
loads complete production scripts to cover public contracts and load order.
Fixtures are captured HTML, PDF text items and OCR text, including Unicode,
neighboring pages and multipage passages. Keep them when consolidating assertions.
Generated Python bytecode is ignored.

## Benchmark method

`benchmark.mjs` exercises all 11 cases in the nine saved fixture files. Each sample
builds fresh source/OCR indexes, prepares passage mappings and generates source
decorations. PDF text-item fixtures use the production document-indexing path;
plain OCR fixtures retain their recorded text. It checks that mappings exist and
that every mapped diff reconstructs both readings exactly, outside the timed region.
PDF decoding, browser rendering, network requests and font extraction are outside
this benchmark.

Three warmup runs precede 30 measured runs per case. The report includes p50,
p95, maximum, byte counts, decoration counts, CPU and Node version. Set
`BENCH_ITERATIONS` to an integer of at least five to change sample count. Run it
without other test suites competing for CPU. Timings are observations, without a
hardware-dependent pass threshold.

2026-10-24, Windows, Ryzen 7 5800H, Node v25.9.0:

| Recorded case | p50 ms | p95 ms |
| --- | ---: | ---: |
| ME04-037 | 5.966 | 8.525 |
| ME04-117 | 17.895 | 20.386 |
| ME04 | 3.984 | 6.720 |
| ME07-066 | 8.821 | 11.019 |
| ME07-073 / ME07-074 | 20.498 / 19.564 | 26.166 / 21.356 |
| ME07-316 | 5.139 | 7.358 |
| ME23, five PDF pages | 45.220 | 46.366 |
| ME32 | 6.990 | 8.436 |
| ME34, two cases | 9.799 / 6.015 | 11.425 / 7.626 |

These measure current application behavior; this test cleanup changes no production
algorithm and makes no application speedup claim.

The manual benchmarks extracted from `tmp/` use the current shared PDF harness,
three warmups and 30 measured runs. Set `BENCH_ITERATIONS` (integer >= 5) to change
the sample count. Both print results and accept an optional JSON report path.
They run separately from the unit/browser suites and require no saved source
snapshots, Git revisions, reader server or external corpus.

`pdf-review-performance.mjs` retains the candidate projection, fragmented HTML
decoration and repeated preparation workloads from `pdf-perf-benchmark.mjs` and
`pdfdiff-comparison-cost.mjs`. Set `BENCH_SIZES=40,400,2000,3000` to select candidate
and decoration sizes; preparation measures batches of 100 cached calls over
1, 12 and 48 distinct PDF page indexes. Checks validate candidate offsets/text,
decoration ranges and retained connections outside the timed region.

`pdf-mapping-profile.mjs` retains the method instrumentation from
`highlight-latency.mjs`. It defaults to `tests/fixtures/pdf-selection-me23.json`;
an explicit fixture must contain `html` and `pages` (raw strings, `raw`, or text
`items`). PDF text indexing precedes timing. Each sample creates a fresh HTML
index, prepares page mappings and generates decorations and review candidates.
Every mapped diff must reconstruct both readings. Method totals cover measured
regions only, include nested calls and incur instrumentation overhead; do not add
them together or compare them directly with uninstrumented timings. Neither
extracted benchmark measures browser rendering or asserts a hardware speed limit.

## Validation snapshot: 2026-10-24

The original mixed Node run passed 75/111 checks in 117.9 seconds. After splitting
the suites and repairing the DocumentModel harness, unit tests passed 74/93 in
1.01 seconds and browser contracts passed 8/24. All seven DocumentModel tests pass
against the shared `editor-core.js`; obsolete embedded-class and model-owned undo
assumptions were replaced with current loading, revision and newline contracts.
Real Monaco undo/redo coverage remains in the browser suites.

Backend tests passed 13/13 in 7.14 seconds. The old gzip expectation was migrated
to the current plain JSON contract while retaining missing-cache regeneration,
over-5-MB lossless round trips and reader-does-not-extract assertions.

The standalone replacement-review browser script passed. The document, editor-input,
HTML-pattern-review, layout, Monaco, PDF-cache and PDF-popup scripts failed both
before and after setup consolidation. Saved pre-cleanup scripts were rerun to
verify this status. Existing failures include obsolete UI selectors/routes, PDF
font/mapping assertions and popup/highlight timeouts. They remain visible and
return nonzero; they have not been skipped or converted into success.
One uniform-font test also failed intermittently in a full run, then passed both
alone and in the final unit run. This is a partial suite, not a green full regression.

The historical raw reports in `tmp/tests-clean-*` were removed during temporary
file cleanup. This snapshot describes the execution environment above; rerun the
commands to produce current reports when application behavior or fixtures change.
