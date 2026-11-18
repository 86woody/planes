# Review protocol

An adversarial reviewer reads the plan and tries to break it: contradictions between
docs, contracts a builder cannot code against unambiguously, tasks a Haiku-class agent
would fail, acceptance commands that can pass while the feature is broken, platform
claims that are false.

## Files

- `round-N.md`: written by the reviewer. One table row per finding:
  `F-N-nn | doc and section | severity (high/medium/low) | finding | proposed fix`.
  The reviewer **may edit any doc directly** in its own commits; each such edit is
  listed in the round file with the finding it fixes.
- `round-N-response.md`: written by the plan author. One row per finding:
  `F-N-nn | ACCEPT or DISPUTE | what was changed (commit) or why not`.
  An accepted reviewer edit is kept; a disputed one is reverted in the response commit
  with the reason.

## Rules

1. Severity: **high** = a builder would build the wrong thing or a gate passes on a
   broken product; **medium** = ambiguity a builder must guess at, or a false platform
   claim; **low** = wording, consistency.
2. A round closes when every finding has a response row. The plan freezes when a full
   round returns zero high and zero medium findings and both sides state AGREE.
3. Frozen contracts (`docs/contracts/`) may change during review rounds without a
   decision entry; after freeze, any change needs a `D-nn` in `docs/DECISIONS.md`.
4. Neither side deletes the other's files.
