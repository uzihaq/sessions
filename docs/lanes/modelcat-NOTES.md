# MODELCAT lane notes

## Result

Pretty now treats the Codex app-server model catalog as the authority for
declared structured-session requirements.

- `internal/codexapp.Client.ListModels` calls the paginated `model/list`
  protocol method and includes hidden entries so validation covers the full
  server-advertised catalog.
- `codexapp.ResolveModelChoice` requires exact model IDs, reasoning efforts,
  and service-tier IDs. Errors list the valid live values; invalid choices
  return no fallback value.
- `internal/session.Manager.Create` loads and resolves the catalog before any
  runner launch or `thread/start`. If only effort or Fast is declared, it
  resolves the live default model to make that validation explicit rather
  than racing a later implicit default.
- Initial effort is sent through
  `thread/start.config.model_reasoning_effort`; `serviceTier` is sent through
  `thread/start`, `thread/resume`, and every `turn/start`. Pretty's existing
  `--fast` translation remains the exact service-tier declaration
  `priority`.
- HTTP error payloads are surfaced directly by the CLI, so a rejected create
  prints the catalog error instead of an opaque status/body wrapper.

For example, an unavailable declaration fails before launch with:

```text
model "missing" not available; valid: [codex-auto-review, gpt-5.3-codex-spark, gpt-5.4, gpt-5.4-mini, gpt-5.5, gpt-5.6-luna, gpt-5.6-sol, gpt-5.6-terra]
```

There is no downgrade path: invalid model, effort, and `priority` selections
all return an error and unit tests assert that the runner launch count stays
zero.

## `pretty models`

`pretty models` opens a short-lived app-server client and prints the live
catalog. `pretty models --json` emits the typed entries, including
descriptions, defaults, effort descriptions, service-tier descriptions, and
the hidden marker.

Live output captured on 2026-07-17:

```text
MODEL                DISPLAY NAME         DEFAULT MODEL  DEFAULT EFFORT  HIDDEN  EFFORTS                          SERVICE TIERS
gpt-5.6-sol          GPT-5.6-Sol          yes            low                     low,medium,high,xhigh,max,ultra  priority
gpt-5.6-terra        GPT-5.6-Terra                       medium                  low,medium,high,xhigh,max,ultra  priority
gpt-5.6-luna         GPT-5.6-Luna                        medium                  low,medium,high,xhigh,max        priority
gpt-5.5              GPT-5.5                             medium                  low,medium,high,xhigh            priority
gpt-5.4              GPT-5.4                             medium                  low,medium,high,xhigh            priority
gpt-5.4-mini         GPT-5.4-Mini                        medium                  low,medium,high,xhigh            -
gpt-5.3-codex-spark  GPT-5.3-Codex-Spark                 high                    low,medium,high,xhigh            -
codex-auto-review    Codex Auto Review                   medium          yes     low,medium,high,xhigh            -
```

The catalog is intentionally live, not pinned in Pretty; these entries can
rotate with the installed Codex app-server and account policy.

## Gated real-catalog proof

The gated integration test makes no model turn and spends no inference. It
connects to the real app-server, requires a non-empty typed catalog, checks
every ID, logs the catalog JSON, and proves that a sentinel invalid model is
rejected by `ResolveModelChoice`.

```sh
cd prettygo
CODEXAPP_INTEGRATION=1 CGO_ENABLED=0 \
  go test -v ./internal/codexapp \
  -run '^TestRealAppServerModelCatalog$' -count=1
```

Captured result:

```text
=== RUN   TestRealAppServerModelCatalog
    integration_test.go:120: CATALOG [{"id":"gpt-5.6-sol",...},{"id":"gpt-5.6-terra",...},{"id":"gpt-5.6-luna",...},{"id":"gpt-5.5",...},{"id":"gpt-5.4",...},{"id":"gpt-5.4-mini",...},{"id":"gpt-5.3-codex-spark",...},{"id":"codex-auto-review",...}]
    integration_test.go:125: INVALID_REJECTED model "pretty-model-that-must-not-exist" not available; valid: [codex-auto-review, gpt-5.3-codex-spark, gpt-5.4, gpt-5.4-mini, gpt-5.5, gpt-5.6-luna, gpt-5.6-sol, gpt-5.6-terra]
--- PASS: TestRealAppServerModelCatalog (0.18s)
PASS
```

## Deterministic coverage

The ordinary suite covers:

- multi-page `model/list` request/response behavior with `includeHidden=true`;
- valid exact selection and implicit live-default resolution;
- invalid model, invalid effort, and unsupported Fast/service-tier errors;
- proof that rejected creates never launch a runner;
- propagation of effort and service tier through thread start, resume, and
  subsequent turn start;
- human and JSON `pretty models` rendering; and
- clear CLI rendering of daemon catalog-validation errors.

## Verification

```sh
cd prettygo
CGO_ENABLED=0 go build ./...
CGO_ENABLED=0 go vet ./...
CGO_ENABLED=0 go test ./... -count=1
```

Final result: build exited 0 with no output, vet exited 0 with no output, and
the full test suite passed in every package.

No commit was created.
