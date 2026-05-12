# Akasha Time OS Control Plane Implementation Plan

**Goal:** Move Akasha from passive temporal recall toward a local Time OS control plane.

**Scope**

1. **Action Gate**
   - Add an opt-in action gate context injection.
   - The gate summarizes current project state, open loops, Karma pressure, and user timeline facts before the model acts.
   - The gate is sent as hidden context and is not persisted to the normal transcript.

2. **Heartbeat Maintenance**
   - Add an opt-in in-process heartbeat under Akasha maintenance settings.
   - The heartbeat runs the existing maintenance pass on a wall-clock interval while the session is alive.
   - It remains local-first and stops on session shutdown.

3. **User Timeline**
   - Add a user-level projection from all local Akasha session logs, independent of project `cwd`.
   - Track preferences, long-term goals, open commitments, due predictions, corrected predictions, and collaboration style hints.
   - Expose it through `/akasha user-timeline`.

**Non-goals**

- No external daemon or OS service yet.
- No cloud sync.
- No blocking hard policy gate for tool calls yet.
- No UI beyond slash commands and hidden context injection.

**Validation**

- Focused Akasha tests.
- Nearby extension/session tests.
- Coding-agent build.
