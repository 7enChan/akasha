# Akasha

Akasha is a time-native coding agent. It keeps the normal coding-agent workflow, then makes time a local operating layer: append-only events, temporal projections, action-gate context, policy checks, daemon callbacks, explicit time syscalls, and memory governance.

Start with:

```bash
cd packages/coding-agent
npm install
npm run build
npm link
akasha init
akasha
```

The `akasha` command is the canonical entrypoint. Runtime state lives under `.akasha/settings.json` for a project and `~/.akasha/agent/settings.json` globally.

For the Akasha guide, see [packages/coding-agent/docs/akasha.md](packages/coding-agent/docs/akasha.md).

## Runtime

* **[@earendil-works/akasha-coding-agent](packages/coding-agent)**: Interactive coding agent CLI with the Akasha entrypoint
* **[@earendil-works/akasha-agent-core](packages/agent)**: Agent runtime with tool calling and state management
* **[@earendil-works/akasha-ai](packages/ai)**: Unified multi-provider LLM API (OpenAI, Anthropic, Google, ...)

## All Packages

| Package | Description |
|---------|-------------|
| **[@earendil-works/akasha-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@earendil-works/akasha-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@earendil-works/akasha-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@earendil-works/akasha-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@earendil-works/akasha-web-ui](packages/web-ui)** | Web components for AI chat interfaces |

For Slack/chat automation and workflows see [earendil-works/akasha-chat](https://github.com/earendil-works/akasha-chat).

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./akasha-test.sh         # Run akasha from sources (can be run from any directory)
```

> **Note:** `npm run check` requires `npm run build` to be run first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## License

MIT
