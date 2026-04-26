# parsers/

Tool-specific parsers (Claude Code, Codex, plain terminal). Carried over from
`~/pretty-tmux/src/parsers/` and **wired in Phase 3** via the snapshot-extractor
pipeline:

```
xterm buffer ─► SerializeAddon.serialize() ─► detectTool() ─► parser.parse() ─► Block[]
                                                          ╰─► extractSidebarFindings()
```

Per `parsers/types.ts`, parsers are **stateless**: each call sees ONE buffer
snapshot and returns transient findings. All latching (frozen prefix, own-clock
timer, file accumulation) lives in `hooks/usePrettyParser.ts`.
