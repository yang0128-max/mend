# mend

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yang0128-max/mend/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/yang0128-max/mend/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

mend is one command-line tool that applies AI-written edits in all four
formats models use — unified diffs (often with wrong line numbers),
SEARCH/REPLACE blocks, V4A patches and JSON editor calls — to a tree of text
files, exactly as `SPEC.md` in this repository specifies.

## How it works

- `main.ts` is the whole CLI: Node 22, standard library only, run as
  `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`.
- Every edit is parsed before any file is touched, then edits apply in patch
  order against an in-memory copy of the tree; a patch writes every change or
  none, and each failed edit is reported with its code in patch order.
- Lines an edit names are found at the first of three matching tiers: exact,
  trailing-whitespace-insensitive, then fully trim-insensitive. At the loosest
  tier, replacement lines are re-indented with the file's own indentation and
  context lines always keep the file's own bytes.
- Unified hunks pick the occurrence nearest the hunk's stated line (adjusted
  by the running delta of earlier hunks); V4A chunks advance a cursor, with
  anchors and end-of-file chunks honoured; JSON `str_replace` matches exact
  text, with CRLF files normalised and written back as CRLF.
- The practice set from the kit passes 100 of 100 locally.

## Run it

```sh
node main.ts edit.patch          # apply a patch file
node main.ts --check edit.patch  # report what would change, write nothing
cat edit.patch | node main.ts    # or read the patch from standard input
```

`runner.ts` is the trial runner supplied with the kit: when
`MAKEFUN_ENV_URL` is set, `main.ts` hands over to it.

MIT licensed.

---
<sub>Entered on [make.fun](https://make.fun/?ref=c5eeqz3e&utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
