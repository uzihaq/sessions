package main

import (
	"fmt"

	"github.com/uzihaq/sessions/runtime/internal/recovery"
)

func (a *app) cmdAdopt(args []string) error {
	force := removeFirst(&args, "--force")
	if len(args) != 1 || args[0] == "" {
		return fail(1, "usage: sessions adopt <path-or-uuid> [--force]")
	}
	var result recovery.AdoptResult
	if err := a.postJSON("/api/recovery/adopt", map[string]any{"target": args[0], "force": force}, &result, 2); err != nil {
		return err
	}
	if a.wantJSON {
		return writeJSON(a.stdout, result, true)
	}
	_, err := fmt.Fprintln(a.stdout, result.LaneID)
	return err
}
