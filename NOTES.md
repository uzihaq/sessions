# MIRROR lane notes

## Result

Implemented `prettygo/internal/mirror` as a pure-Go, concurrency-safe 300x50 terminal mirror with:

- raw PTY `Write`
- plain active-viewport `Snapshot`
- screen-reproducing `SerializeANSI`
- `ReflowTo(width)` matching `prettyd/src/reflow.ts`
- primary/alternate buffers, cursor movement, erase/edit operations, wrapping and viewport scrolling, DEC scroll regions, SGR (ANSI/256/truecolor), OSC 8 links, combining characters, emoji, and CJK cells

The TypeScript source was treated as normative. In particular, the Go reflow keeps the current TS behavior of padding short segments, expanding cursor-forward sequences, preserving hard CRLF boundaries, preserving box/pipe-table rows, and carrying SGR state over inserted wraps.

## VT library evaluation

Chosen: `github.com/charmbracelet/x/vt` at `v0.0.0-20260713092006-0d683c34c74b`.

- Pure Go and clean with `CGO_ENABLED=0`.
- Its cell model retains modern graphemes, ANSI/256/truecolor styling, OSC 8 links, alternate screen state, editing operations, scrolling, and DEC margins.
- The wrapper adds xterm-compatible soft-wrap bookkeeping because `x/vt` does not expose xterm's per-line `isWrapped` bit. It also drains terminal query responses, preserves main-buffer serialization while the alternate buffer is active, and works around `x/vt`'s ASCII-plus-combining segmentation behavior.

Rejected:

- `github.com/hinshun/vt10x`: older, narrower terminal/cell model; replacing its missing modern grapheme and serialization behavior would require substantially more custom emulation.
- `github.com/danielgatis/go-vte`: bindings/CGO conflict with the architecture's `CGO_ENABLED=0` pin.

`github.com/creack/pty` is used only by the recording utility.

## Acceptance method and isolation

`prettygo/internal/mirror/testdata/oracle.cjs` loads the repository-local `prettyd/node_modules/@xterm/headless` and `@xterm/addon-serialize` at 300x50. `verify.cjs` builds the Go harness with `CGO_ENABLED=0`, feeds both implementations identical bytes, and checks:

1. exact normalized viewport text;
2. Go serialization re-fed through both Go and xterm;
3. exact canonical rendered cells (text, width, foreground/background, and style flags);
4. Go and TS reflow output re-fed into xterm at width 60 and compared as text plus canonical cells.

The six PTY captures cover colored `ls`, Vim, curses-style redraws, prose, Unicode, and a real Codex TUI startup. The Codex capture used temporary `HOME` and `CODEX_HOME` under `/tmp/pretty-mirror-codex-home`, was killed at the recorder timeout, and did not use default pretty-PTY/Codex state or contact a real pretty-PTY daemon. All acceptance work used files or fresh processes scoped to this worktree and temporary directories.

Recording sizes (real command output):

```text
$ wc -c internal/mirror/testdata/recordings/*.bin
     555 internal/mirror/testdata/recordings/bash-colored-ls.bin
   47590 internal/mirror/testdata/recordings/codex-startup.bin
     589 internal/mirror/testdata/recordings/curses-redraw.bin
     544 internal/mirror/testdata/recordings/long-prose.bin
     228 internal/mirror/testdata/recordings/unicode-cjk-emoji.bin
   14178 internal/mirror/testdata/recordings/vim-open.bin
   63684 total
```

## Proof output

```text
$ CGO_ENABLED=0 /opt/homebrew/bin/go test -race ./...
ok  	github.com/uzihaq/pretty-pty/prettygo/internal/mirror	1.418s
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/harness	[no test files]
?   	github.com/uzihaq/pretty-pty/prettygo/internal/mirror/cmd/record	[no test files]
```

```text
$ CGO_ENABLED=0 /opt/homebrew/bin/go vet ./...
(no stdout/stderr; exit 0)
```

```text
$ CGO_ENABLED=0 /opt/homebrew/bin/go build ./...
(no stdout/stderr; exit 0)
```

```text
$ node internal/mirror/testdata/verify.cjs
mirror oracle acceptance (6 PTY recordings + 4 control probes, 300x50, reflow=60)
  PASS bash-colored-ls.bin: snapshot exact; ANSI roundtrip cells exact; reflow render exact
  PASS codex-startup.bin: snapshot exact; ANSI roundtrip cells exact; reflow render exact
  PASS curses-redraw.bin: snapshot exact; ANSI roundtrip cells exact; reflow render exact
  PASS long-prose.bin: snapshot exact; ANSI roundtrip cells exact; reflow render exact
  PASS unicode-cjk-emoji.bin: snapshot exact; ANSI roundtrip cells exact; reflow render exact
  PASS vim-open.bin: snapshot exact; ANSI roundtrip cells exact; reflow render exact
  PASS sgr-controls.probe: snapshot exact; ANSI roundtrip cells exact; reflow render exact
  PASS alternate-screen.probe: snapshot exact; ANSI roundtrip cells exact; reflow render exact
  PASS wrap-scroll.probe: snapshot exact; ANSI roundtrip cells exact; reflow render exact
  PASS unicode-controls.probe: snapshot exact; ANSI roundtrip cells exact; reflow render exact
10/10 cases passed
  KNOWN DIVERGENCE sgr-overline.probe bytes=1b5b35336d6f7665726c696e651b5b306d: text exact; x/vt omits SGR 53 overline metadata
```

## Known divergence

The only observed differential divergence is SGR 53 overline metadata:

```text
bytes: 1b 5b 35 33 6d 6f 76 65 72 6c 69 6e 65 1b 5b 30 6d
text:  ESC [ 5 3 m o v e r l i n e ESC [ 0 m
```

Viewport text remains exact, but `x/vt` does not retain overline on its cells, so Go serialization cannot reproduce that one style flag. Overline is outside the required cursor/erase/color subset. The acceptance script asserts this remains an explicit known divergence and will fail if the upstream behavior changes, forcing this note to be updated.

`git diff --check` also completed with no output and exit 0. No commit was created.
