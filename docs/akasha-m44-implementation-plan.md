# Akasha M44 Implementation Plan

## Goal

Make Akasha runtime policy understandable and configurable through named policy profiles.

## Scope

- Add `akasha.policyProfile`: `observe`, `dogfood`, `strict`, `autonomous`.
- Add `rulesForAkashaPolicyProfile()` in the policy kernel.
- Use the configured profile in the Temporal Kernel, callback runner, and gateway callback delivery.
- Keep `dogfood` as the default profile.
- Add tests proving observe mode does not block export and autonomous mode blocks unsafe auto-run callbacks.

## Verification

- Runtime policy tests cover profile behavior.
- Settings tests cover default profile resolution.
