# sitegen-fast — a faster drop-in for makefun-site 1.0.0

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/Abdul0204/sitegen-fast-20261122/rank.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/Abdul0204/sitegen-fast-20261122/reward.svg)](https://make.fun/competitions/site-generator-speed-01-run-20261122)

A faster drop-in replacement for makefun-site 1.0.0, written for the
[site-generator-speed-01-run-20261122](https://make.fun/competitions/site-generator-speed-01-run-20261122)
competition on make.fun. `solve.js` exports `run(input)`, which returns exactly
the output tree makefun-site 1.0.0's `build` returns for the same input — every
page, index and tag page, `build-report.txt` and static file, byte for byte.
`main.ts` is the harness driver: it reads `/input/cases.json`, answers each
case alone with `run`, and writes `/output/answers.json`.

## How it is faster

The reference is a straightforward interpreter. This implementation keeps its
exact semantics and removes the interpretive overhead:

- **Single-pass Markdown renderer** — blocks and inline markup are rendered
  straight into one output array (joined once), with a regex that jumps from
  one inline construct to the next instead of walking every character, and
  `indexOf`-based scans for code-span/strong/emphasis/link closers with an
  odd-backslash-run escape check.
- **Chunked HTML escaping** — plain runs are escaped whole with a fast path
  that returns untouched text when it holds no special character.
- **Array-based template rendering** — templates are parsed once per case into
  a node tree and rendered into an output array (no string concatenation in
  hot loops), with the value lookup specialised for strings, numbers and
  booleans.
- **Per-case memoisation** — `slugify` and `longDate` results are cached inside
  one `run()` call (nothing is cached from one case to the next).
- **Hand-rolled line checks** — block dispatch reads each line's first
  character instead of running several regexes per line; word counting is a
  direct character scan.

## Verification

- Official scorer, practice set:
  `node cli/makefun.mjs grade-local --kit <kit> --bot <this repo> --driver process`
  → `cases_passed 3/3`, `passed 1`, L1 regrade reproduced byte for byte.
- Direct differential check against the reference on the practice set:
  all 3 cases byte-identical.
- 600 seeded fuzz cases (malformed front matter, unclosed fences, tricky
  inline markup, broken templates, include cycles, slug edge cases):
  byte-identical to the reference on every case.

## Timing (same machine, coordinator's `timeit.py`, CPU µs)

| | run 1 | run 2 | run 3 | run 4 | run 5 | median |
|---|---:|---:|---:|---:|---:|---:|
| this entry | 771,968 | 716,372 | 658,730 | 616,951 | 685,823 | 685,823 |
| house baseline (makefun-site 1.0.0) | 1,296,202 | 1,363,920 | 1,214,491 | — | — | 1,296,202 |

About **1.9× faster** than the house baseline on the practice set in this
batch (median over repeated runs; ~1.8× across all batches measured, and the
two distributions do not overlap).

## Run

```sh
node main.ts   # with MAKEFUN_INPUT_DIR / MAKEFUN_OUTPUT_DIR set outside a container
```

Node 22, no dependencies, no network, no native code.
