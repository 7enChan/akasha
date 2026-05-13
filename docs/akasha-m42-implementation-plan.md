# Akasha M42 Implementation Plan

## Goal

Move the Telegram gateway from notify-only callback delivery to configurable callback delivery modes while keeping autonomous execution opt-in and bounded.

## Scope

- Add `akasha.gateway.callbackMode` with `notify_only`, `inbox_only`, `ask_before_run`, and `auto_run_safe`.
- Preserve `notify_only` as the default behavior.
- Let `inbox_only` and `ask_before_run` dispatch callbacks into the resume inbox.
- Let `auto_run_safe` create inbox prompts and then run the Agent only for safe promise/prediction callbacks.
- Record mode metadata in `gateway.callback.delivered`.

## Verification

- Gateway runner tests cover notify, inbox, and auto-run delivery modes.
- Existing Telegram command/menu behavior remains unchanged.
