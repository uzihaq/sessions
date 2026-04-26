# parsers/

Carried over verbatim from `~/pretty-tmux/src/parsers/` for **Phase 3** reuse.

These files are **unwired in Phase 1**. The terminal stream goes straight to
xterm.js. In Phase 3 we'll feed PTY output through these parsers in parallel
to derive Pretty cards (messages, tool cards, file cards, thinking state)
without taking the raw terminal away.

If a parser bug surfaces, fix it here — `pretty-tmux/` is now archive.
