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

Raw reports from this cleanup are in `tmp/tests-clean-*`. JSON reports and this
snapshot describe the execution environment above and should be refreshed when
application behavior or fixtures change.
