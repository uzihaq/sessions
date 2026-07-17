# BACKUP lane notes

## Delivered

- Added opt-in configuration at `~/.config/pretty/backup.json`, written atomically with mode `0600`. The file stores the somewhere project and the path to `~/.somewhere/config.json`; it never stores the `smt_` credential itself.
- Added `pretty backup enable --project <project> [--interval 15m]`, `pretty backup now`, and `pretty backup status` (including `--json` output through the existing global flag).
- Added authenticated daemon routes for backup status, immediate push, and periodic-config reload. The daemon reloads enabled backup configuration at construction and a live daemon is nudged after `enable`.
- Added a dependency-free periodic timer. No timer goroutine is started for missing or disabled configuration.
- Added direct raw-byte `PUT` uploads to `https://api.somewhere.tech/v1/fs/<project>/pretty-sessions/<machine>/<tool>/<session-id>.jsonl`. No Pretty-operated relay is involved; the local daemon talks directly to the user's own somewhere account API.
- Added `manifest.json` at `pretty-sessions/<machine>/manifest.json`, keyed by session ID with only name, cwd, tool, last activity, and remote transcript path.
- Resolves Claude JSONL and Codex rollout files through `internal/watch`. Both live daemon sessions and durable runner metadata for known sessions are considered; unsupported or unresolved tools are not uploaded.
- Incremental state is the transcript size plus nanosecond mtime, keyed by project and remote path. Unchanged transcripts are skipped while the manifest is refreshed. Successful transcript progress is retained even if a later upload fails.
- Per-session opt-out is honored from runner metadata fields `backup:false`, `backupOptOut:true`, or `noBackup:true`, and from a `<runner-state>/<session-id>.no-backup` sentinel. Opted-out sessions are absent from both transcript uploads and the manifest.
- Upload eligibility is deliberately narrow: only resolved conversation files and the generated manifest. Process args, environment, runner logs/events, terminal output, auth tokens, and other state files are never included.

The lane spec names `commands.go` for the CLI dispatch line, but the current checkout's actual dispatch switch is in `cmd/pretty/app.go`; the single backup dispatch case was added there.

## Isolated verification

All network-path tests use loopback `httptest` servers and synthetic HOME/state/transcript fixtures. No request was made to the real somewhere API, `100.86.76.84`, or the soak daemon on `:8787`.

Coverage asserts:

- exact method, authorization header, endpoint shape, content type, and fixture transcript bytes;
- manifest presence and its restricted schema;
- second-push incremental transcript skip;
- Claude and Codex resolution;
- known-session discovery and both metadata/sentinel opt-out forms;
- private config mode and absence of copied token bytes;
- enabled/disabled periodic behavior;
- CLI enable/status/now behavior and API route integration.

## Gates

Run from `prettygo/` on 2026-07-16:

- `CGO_ENABLED=0 go build ./...` — PASS
- `go vet ./...` — PASS
- `go test ./...` — PASS
- `go test -race ./internal/backup ./internal/api ./cmd/pretty` — PASS
- `go test -count=10 ./internal/backup` — PASS

No commit was created.
