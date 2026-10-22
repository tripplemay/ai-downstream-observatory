# Portfolio-first browser journey and precise change display

## User-visible changes

The overview now puts the reference portfolio before low-frequency policy
diagnostics. Those diagnostics remain mounted in the existing closed research
details, can be expanded explicitly, and remain directly visible on the plan
page. Decisions, missing evidence and freshness checks keep their priority.

A nonzero proposed or remaining model difference that rounds to zero cents is
shown as `+<0.01` or `-<0.01`, with an explanation and expandable unrounded
values. Exact zero still displays `0.00`. Regular half-even monetary formatting,
all stored assessments, frozen tolerances and financial decisions are unchanged.
Small displayed changes are not proof of buyability or an economic case to trade.

The strict-zero browser case reproduced nonzero differences near 1e-18 CNY.
They must not be silently set to zero or used to widen a user's frozen rule.
The separate normal-observation fixture explicitly records a cent tolerance
before admission and research; it does not modify the strict-zero study.
Both cases use invented evidence, never a personal investment protocol.

## Reproducible browser boundary

`tests/investor/browser_v2_journey.py` runs against actual Next routes and
authenticated HTTP. No page, API response or AI response is mocked by the
browser. The upstream evidence producer is still an isolated synthetic fixture,
with invented owner reviews and stubbed SDK observations, not a real provider.

The fixture launcher has side-effect-free `--help`, rejects unknown options,
and supports `--production`. Build its isolated output first:

```sh
cd web
WORKBENCH_DIST_DIR=.next-fixture-production npm run build
cd ..
node web/scripts/serve-workbench-fixture.mjs --production
```

Use a fresh fixture for each run. Pass its printed temporary database path to
the script, with a worker Python that has the project requirements installed:

```sh
python3 tests/investor/browser_v2_journey.py \
  --db /temporary/etf-browser-fixture-EXAMPLE/workbench.db \
  --output artifacts/verification/example-journey \
  --worker-python /path/to/project-test-python
```

The strict-zero variant adds `--strict-zero-tolerance`. Database paths outside
the expected empty temporary fixture and outputs outside private verification
artifacts are rejected. Read-only database probes use the supplied worker
interpreter, independently from the Python running Playwright.

Production mode uses a temporary self-signed certificate and a loopback HTTPS
proxy to an ephemeral loopback Next port. The app keeps its production HTTPS
requirement and host-only Secure/HttpOnly/SameSite=Strict session cookie; no auth
validation is relaxed. Only the test browser accepts this local certificate.
No certificate is trusted system-wide. Child processes, certificate material
and the temporary database are cleaned up on shutdown. This is not public TLS
or deployed-container acceptance; `next start` also warns about standalone output.

## Current evidence and limits

On one frozen production build, the normal and strict-zero journeys passed
21 and 22 checks respectively. They cover:

- Login and four-question onboarding, preserving unknown risk and no account prerequisite.
- Train-only alternatives, explicit synthetic risk confirmation, bounded research reference and save-for-observation.
- Normal observation or strict tiny-delta review, followed by a new-funding decision.
- Human deferral persisting across actual page navigation.
- Optional empty account creation and an explicitly transcribed independent zero statement.
- Desktop and 390-pixel screenshots, no horizontal overflow or page errors, and no source changes during each run.

Account metadata is created only after the explicit account action. Research,
monitoring and human review leave all actual financial facts, approvals,
reservations and execution reports empty. The account case does not exercise a
funded securities ledger, actual trade/settlement transcription, a complete
valuation, identity mapping or an account-level executable review list.

Real sources and current personal constraints, ongoing market acquisition,
permitted real AI explanations, the complete P2 account loop, independent
operational/recovery checks and protected external production acceptance remain
required by the original v2 design. Green browser fixtures do not close those
requirements. The earlier commit's full CI does not certify subsequent edits.
