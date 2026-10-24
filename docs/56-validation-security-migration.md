# Validation runtime security migration

## Scope

The release audit now requires the patched Zod4 runtime. Pin `zod` to4.6.7
and `fast-uri` to3.1.9. Pin `@hookform/resolvers` to5.2.2, whose existing
React Hook Form peer requirement is satisfied by the locked7.84.0 runtime.
Keep unrelated dependency versions, Next15.5.28 and sharp0.35.5 unchanged.
The newer resolver5.9.2 has an incompatible optional AJV-formats peer; do not
force that dependency graph or downgrade the existing AJV-formats3 contract.

The upstream Zod fix checks constrained collection sizes before walking their
elements. Merely installing a new package while importing `zod/v3` would not
establish this fix. Application and tests continue importing the patched default
runtime, not a compatibility alias or local exception to the advisory.

## Compatibility boundaries

- Use `safeExtend` for session-bound response envelopes. Original object
  refinements remain attached, strict unknown-key checks remain active, and the
  original body/scope/session verification still runs. Do not replace a refined
  schema with a permissive object to make a migration pass.
- Give unknown-value records explicit string key schemas. This preserves the
  JSON record shape rather than treating the former value schema as a key schema.
- Distinguish form input and parsed output types. Fields with defaults may be
  omitted on input, but callbacks still receive the validated/defaulted output.
  No assertion cast or raw resolver output bypass is used to silence type errors.
- Keep financial commands, decimal arithmetic, calendar precision, immutable
  receipts, idempotency, recovery barriers, approval and risk rules unchanged.
  No database migration, economic protocol upgrade or actual trade is added.

## Verification requirements

`validation-runtime.test.ts` verifies early rejection of oversized constrained
arrays/sets/maps without walking invalid elements; retained cross-field/strict
envelope checks; explicit unknown-value records; form defaults and field errors
through the actual resolver. The bounded fixture is small and never attempts
memory exhaustion against a running service.

`framework-security.test.mjs` checks manifest/lock floors and duplicate locked
validation packages, alongside the existing Next/native runtime checks. It also
requires the normal high-severity audit step without exclusions or ignored
failure. Version floors are regression guards, not a substitute for a fresh
dependency audit at each release.

Full Web/Python/HTTP/container CI, native responsive workflow checks and a fresh
production capacity/backup/restore/source verification remain required. Previous
fixture success or a previous release's audit cannot certify the changed source.

## Primary references

- [Zod constrained collection fix](https://github.com/colinhacks/zod/commit/a0ebf97)
- [Zod4 migration guide](https://zod.dev/v4/changelog)
- [Resolver5.2.2 release](https://github.com/react-hook-form/resolvers/releases/tag/v5.2.2)
- [fast-uri3.1.9 release](https://github.com/fastify/fast-uri/releases/tag/v3.1.9)
