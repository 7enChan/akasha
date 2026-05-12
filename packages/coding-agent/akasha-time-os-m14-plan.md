# Akasha M14 Product Entry and Dogfood Shell Plan

**Goal:** Make Akasha visible as a daily-use product entry while keeping the existing pi-coding-agent runtime and package identity stable.

**Scope**

1. **CLI Alias**
   - Add an `akasha` binary alias that launches the same runtime with Akasha-branded help/title.
   - Keep `pi` unchanged.
   - Reuse the same `.pi` config directory in M14 to avoid splitting user sessions and settings.

2. **Akasha Preset**
   - Add a conservative local-first Akasha preset:
     - event collection on
     - temporal brief on
     - action gate on
     - destructive-command enforcement on
     - maintenance and heartbeat on
     - embeddings and reflection off by default
   - Allow writing the preset to project settings by default and global settings with `--global`.

3. **Entrypoint Commands**
   - Add `akasha init [--global]` to write the preset.
   - Add `akasha enable [--global]` as an alias for the preset write.
   - Add `akasha status` to show resolved Akasha state and the active settings paths.

4. **In-session Commands**
   - Add `/akasha init [global]` and `/akasha enable [global]` for already-enabled sessions.
   - These commands mainly support updating an existing Akasha configuration from inside the product shell.

5. **Docs**
   - Add an Akasha quickstart document.
   - Update settings docs and package README with the new alias and init flow.

**Non-goals**

- No npm package rename.
- No `.akasha` config directory migration.
- No product website or branding overhaul.
- No model/provider opinionated setup.

**Validation**

- Add tests for the preset and entrypoint command behavior.
- Run focused Akasha/settings tests, package build, and full repo check.
