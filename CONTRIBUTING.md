# Contributing

Thanks for your interest. This is a small, focused project — contributions that improve
compatibility, fix bugs, or extend distro support are very welcome.

## Before You Start

- **Check open issues** — someone may already be working on it
- **Open an issue first** for non-trivial changes so we can align before you invest time
- **Read [CLAUDE.md](CLAUDE.md)** — it documents the architecture, critical path chains,
  and things that are easy to break (especially auth and path translation)

## What's Most Useful

- Distro-specific fixes (package names, binary paths, keyring providers)
- New binary resolution paths in the Swift stub
- `install.sh` robustness improvements (edge cases, `--doctor` checks)
- Test coverage additions in `tests/`

## What's Out of Scope

- Auto-update mechanisms (security surface concern — see issue #37)
- Features that require modifying Claude Desktop's unmodified renderer code
- Any change to credential handling that hasn't been reviewed against [OAUTH-COMPLIANCE.md](docs/OAUTH-COMPLIANCE.md)

## Development Setup

```bash
git clone https://github.com/johnzfitch/claude-cowork-linux
cd claude-cowork-linux
./install.sh           # full install
./launch.sh            # launch with auto-asar repack
./launch-devtools.sh   # launch with Node.js inspector
./install.sh --doctor  # validate environment
```

Logs during development:

```bash
# Swift stub trace log (most useful)
tail -f ~/Library/Application\ Support/Claude/logs/claude-swift-trace.log

# Full session log
./launch.sh 2>&1 | tee ~/cowork-full-log.txt
```

## Code Style

- **No emojis in commit messages**
- Commit format: brief summary (50 chars), blank line, explanation (72-char wrap), focus on "why"
- Branch prefixes: `feature/`, `fix/`, `refactor/`, `docs/`, `test/`
- Security: spawned commands use `execFile`/`spawn` with argument arrays — never string interpolation
- Use `trace()` for debug logging (writes to `claude-swift-trace.log`, not stdout)
- Auth-related env var values must never be logged unredacted — use `redactForLogs()`
- Never commit: API keys, tokens, `.env` files, or anything in `~/Library/Application Support/Claude/`

## Security-Sensitive Areas

Changes to these files require extra care and a note in your PR explaining the security impact:

- `stubs/@ant/claude-swift/js/index.js` — `filterEnv()`, `spawn()`, `isPathSafe()`
- `stubs/@ant/claude-native/index.js` — `AuthRequest.start()`, `ALLOWED_AUTH_ORIGINS`
- `cowork/sdk_bridge.js` — `filterEnvForSubprocess()`

If your change affects credential handling, verify it against [OAUTH-COMPLIANCE.md](docs/OAUTH-COMPLIANCE.md).

