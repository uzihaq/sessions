package main

import (
	"fmt"
	"strconv"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/uzihaq/pretty-pty/prettygo/internal/ledger"
	"github.com/uzihaq/pretty-pty/prettygo/internal/recovery"
)

func (a *app) cmdRecover(args []string) error {
	reopen := removeFirst(&args, "--reopen")
	force := removeFirst(&args, "--force")
	if len(args) != 0 {
		return fail(1, "usage: pretty recover [--reopen [--force]]")
	}
	if force && !reopen {
		return fail(1, "--force requires --reopen")
	}
	if reopen {
		var result recovery.ReopenResult
		if err := a.postJSON("/api/recovery/reopen", map[string]any{"force": force}, &result, 2); err != nil {
			return err
		}
		if a.wantJSON {
			if err := writeJSON(a.stdout, result, true); err != nil {
				return err
			}
		} else if err := writeReopenResult(a, result); err != nil {
			return err
		}
		if !result.OK {
			return status(1)
		}
		return nil
	}

	var report recovery.Report
	if err := a.getJSON("/api/recovery", &report); err != nil {
		return err
	}
	if a.wantJSON {
		return writeJSON(a.stdout, report, true)
	}
	return writeRecoveryPlan(a, report)
}

func writeRecoveryPlan(a *app, report recovery.Report) error {
	recipes := make(map[string]ledger.RecoveryRecipe, len(report.Plan.Recipes))
	for _, recipe := range report.Plan.Recipes {
		recipes[recipe.SourceLaneID] = recipe
	}
	w := tabwriter.NewWriter(a.stdout, 0, 4, 2, ' ', 0)
	if _, err := fmt.Fprintln(w, "NAME\tTOOL\tCWD\tLAST-ACTIVITY\tRESUME"); err != nil {
		return err
	}
	count := 0
	for _, lane := range report.Lanes {
		if lane.Class != ledger.ClassUnexpectedlyLost {
			continue
		}
		count++
		name := lane.Name
		if name == "" {
			name = lane.ID
		}
		resume := "<provider-unbound>"
		if recipe, ok := recipes[lane.ID]; ok {
			resume = shellRecipe(append([]string{recipe.Cmd}, recipe.Args...))
			if recipe.Blocked {
				resume += " [blocked: resume source missing]"
			}
		}
		if _, err := fmt.Fprintf(w, "%s\t%s\t%s\t%s\t%s\n",
			name, lane.Tool, lane.Cwd, recoveryTime(lane.LastActivityAtMS), resume); err != nil {
			return err
		}
	}
	if count == 0 {
		if _, err := fmt.Fprintln(w, "(no unexpectedly-lost lanes)\t\t\t\t"); err != nil {
			return err
		}
	}
	return w.Flush()
}

func writeReopenResult(a *app, result recovery.ReopenResult) error {
	if len(result.Outcomes) == 0 {
		_, err := fmt.Fprintln(a.stdout, "no unexpectedly-lost lanes")
		return err
	}
	for _, outcome := range result.Outcomes {
		name := outcome.Name
		if name == "" {
			name = outcome.SourceLaneID
		}
		line := fmt.Sprintf("%s: %s", name, outcome.Status)
		if outcome.NewLaneID != "" {
			line += " " + outcome.NewLaneID
		}
		if outcome.Error != "" {
			line += " (" + outcome.Error + ")"
		}
		if _, err := fmt.Fprintln(a.stdout, line); err != nil {
			return err
		}
	}
	return nil
}

func recoveryTime(atMS int64) string {
	if atMS == 0 {
		return "-"
	}
	return time.UnixMilli(atMS).Format(time.RFC3339)
}

func shellRecipe(argv []string) string {
	quoted := make([]string, 0, len(argv))
	for _, value := range argv {
		if value != "" && !strings.ContainsAny(value, " \t\n\"'\\$`!&;|<>()[]{}*?") {
			quoted = append(quoted, value)
		} else {
			quoted = append(quoted, strconv.Quote(value))
		}
	}
	return strings.Join(quoted, " ")
}
