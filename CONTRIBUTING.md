# Contributing to workmux

Thanks for your interest in contributing! This guide covers development setup,
testing, and the PR process.

## Before contributing

This is a small project maintained by one person. Reviewing and testing pull
requests often takes more time than implementing a feature from scratch. Please
don't be surprised if your PR is not accepted, even if the idea itself is good.
To avoid wasted effort, open an issue first to discuss your proposed change.

## Prerequisites

- Rust toolchain (stable)
- Python 3.10+ with a virtual environment at `tests/venv/`
- [just](https://github.com/casey/just) command runner
- tmux (required for tests)
- WezTerm (optional, for testing WezTerm backend)
- Zellij (optional, for testing Zellij backend)

## Development setup

```bash
# Clone and build
git clone https://github.com/raine/workmux.git
cd workmux
cargo build

# Set up Python test environment
python -m venv tests/venv
source tests/venv/bin/activate
pip install -r tests/requirements.txt

# Install dev binary (symlinks to ~/.cargo/bin)
just install-dev
```

## Running tests

Tests are written in Python using pytest and run against an isolated multiplexer
environment.

```bash
# Run unit tests
just test

# Run integration tests (tmux backend, parallel)
just itest

# Run specific integration test file
just itest tests/test_workmux_add/test_basic.py

# Run with verbose output (shows backend in test names)
just itest tests/test_agent_state.py -vvv
```

### Pi subagent status smoke test (opt-in)

The Pi status unit tests run with `bun test tests/pi_status_extension.test.ts`.
For the real extension/RPC/process/sidebar boundary, an optional smoke helper uses
Pi, a locally installed pi-subagents extension with fleet status v1, and tmux:

```bash
cargo build
python3 tests/pi_subagents_smoke.py \
  --pi-subagents /path/to/pi-subagents/index.js
```

The helper defaults to `target/debug/workmux` and finds `pi` and `tmux` on PATH.
Use `--workmux`, `--pi`, or `--tmux` to select other binaries. It takes about
30 seconds and is deliberately excluded from the ordinary pytest suite.

It creates a private tmux server and temporary HOME, Pi configuration, and XDG
state. The only model endpoint is a deterministic loopback fixture; no real
credentials, paid model calls, package installation, or existing sessions are
used. Three native children complete, fail, and stop while the parent settles.
The helper checks actual sidebar snapshots beyond the inactivity timeout,
heartbeat timestamps, preserved elapsed time, final completion, and child status
suppression. The command logger forwards to the real workmux binary; it never
supplies fake status results.

Failures retain logs and snapshots and print their directory. Pass
`--keep-artifacts` to retain successful runs too. Cleanup asks Pi to stop only the
runs created by the helper, shuts down Pi, and removes the private tmux server and
its sidebar daemon.
If the platform's temporary directory is too long for Unix sockets, set a shorter
`TMPDIR` before running.

### Testing different backends

By default, tests run against **tmux only**.

```bash
# Test with WezTerm (requires WezTerm to be running)
WORKMUX_TEST_BACKEND=wezterm just itest

# Test both backends
just itest --backend=tmux,wezterm

# Run a specific backend and test file
just itest --backend=wezterm tests/test_agent_state.py -vvv
```

When running with `-vvv`, test names show the backend:

```
test_state_file_has_correct_fields[wezterm] PASSED
test_state_file_has_correct_fields[tmux] PASSED
```

**Note:** WezTerm tests are slower due to GUI mux-server overhead and worker
throttling (8 workers vs unlimited for tmux).

### Marking tmux-only tests

Some tests only make sense for tmux. Use the marker:

```python
@pytest.mark.tmux_only
def test_tmux_specific_feature():
    ...
```

## Code quality

```bash
# Run static checks, Rust lints, docs checks, and unit tests
just check

# Run integration tests
just itest

# Individual commands
just format      # Format Rust and Python
just clippy      # Lint Rust code
just ruff-check  # Lint Python tests
just pyright     # Type check Python tests
```

## Pull request guidelines

1. **Discuss first**: For large or complex changes, open an issue or discussion
   before starting work.

2. **Keep PRs focused**: One feature or fix per PR. Smaller PRs are easier to
   review.

3. **Run checks locally**: Before pushing, run `just check` and `just itest` to
   catch issues early.

4. **Test multiple backends**: If your change affects multiplexer interaction,
   test with other backends:

   ```bash
   just itest --backend=tmux,wezterm
   ```

5. **Update docs**: If adding features, update relevant documentation in `docs/`
   or `README.md`.
