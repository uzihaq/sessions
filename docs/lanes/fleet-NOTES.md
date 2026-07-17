# FLEET lane notes

## What changed

- Added `FleetView`, a browser-side aggregate of every server in the existing
  `useServers` store. Each server renders as a named machine group with its
  configured endpoint, a `/api/health` reachability dot, and session rows built
  from the existing canonical session label and parser-icon components.
- Each machine group owns an independent 3-second polling loop with a 5-second
  request timeout. Health is fetched without auth; the server-scoped session
  request uses that server's configured token and explicitly requests exited
  sessions. No poll changes the active server and no daemon proxies another.
- Reachable rows show `working`, `idle`, or `exited`. If a machine becomes
  unreachable, its last successful rows remain visible but are greyed and
  disabled, while the other machine groups continue polling normally.
- Extended the persisted layout selector to `tabs / fleet / grid`. Opening a
  fleet row activates its owning server and session, then returns to tabs.

## Manual trace

Ran the frontend in headless Chrome against loopback-only scratch fixtures:

- Vite: `127.0.0.1:15273`
- scratch daemon A: `127.0.0.1:18987`
- scratch daemon B: `127.0.0.1:18988`

With both scratch daemons initially reachable, the fleet showed both machine
groups. Daemon A exposed three rows and rendered all three states: `Alpha lane`
working, `Beta review` idle, and `gamma` exited. Daemon B exposed `Delta lane`
working. After stopping only daemon B, the next independent health poll changed
its group to a red `unreachable` state; `Delta lane` remained visible, disabled,
and greyed at computed opacity `0.48`. Daemon A stayed green/reachable, its rows
stayed enabled, and its health request count advanced to four during the trace.
The `grid` control rendered `.grid-view`, and switching back to `fleet` rendered
`.fleet-view` with the fleet control active.

No request in the trace targeted port `8787` or `100.86.76.84`.

## Gates

- `cd frontend && npx tsc --noEmit` — PASS
- `cd frontend && npx vite build` — PASS (95 modules transformed)
- `cd frontend && npm run test:markdown` — PASS (13 passed, 0 failed)
