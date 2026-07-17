package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/uzihaq/pretty-pty/prettygo/internal/waitcond"
)

const laneExitKind waitcond.Kind = "lane_exit"

type laneManifest struct {
	ExitCode       int     `json:"exit_code"`
	Signal         *string `json:"signal"`
	DurationMS     int64   `json:"duration_ms"`
	LastOutputTail string  `json:"last_output_tail"`
	SpecPath       string  `json:"spec_path"`
	FilesChanged   *int    `json:"files_changed,omitempty"`
}

type laneView struct {
	session
	Kind     string        `json:"kind"`
	SpecPath string        `json:"specPath,omitempty"`
	Manifest *laneManifest `json:"manifest,omitempty"`
}

type lanesResponse struct {
	Lanes []laneView `json:"lanes"`
}

func (a *app) cmdLSDispatch(args []string) error {
	kind, present := pluck(&args, "--kind")
	if !present {
		return a.cmdLS(args)
	}
	if kind != "lane" {
		return fail(1, "unsupported --kind %q (valid: lane)", kind)
	}
	return a.cmdLanes(args)
}

func (a *app) cmdLanes(args []string) error {
	filtered := args[:0]
	for _, argument := range args {
		if argument != "-a" && argument != "--include-exited" {
			filtered = append(filtered, argument)
		}
	}
	if len(filtered) != 0 {
		return fail(1, "usage: pretty lanes")
	}
	var response lanesResponse
	if err := a.getJSON("/api/lanes", &response); err != nil {
		return err
	}
	if a.wantJSON {
		return writeJSON(a.stdout, response.Lanes, true)
	}
	if len(response.Lanes) == 0 {
		_, err := io.WriteString(a.stdout, "(no lanes)\n")
		return err
	}
	rows := [][]string{{"ID", "NAME", "TOOL", "CWD", "STATE", "EXIT", "DURATION"}}
	for _, lane := range response.Lanes {
		name := "-"
		if strings.TrimSpace(lane.Name) != "" {
			name = strings.Join(strings.Fields(lane.Name), " ")
		}
		state := "running"
		exit := "-"
		duration := "-"
		if lane.Manifest != nil {
			state = "exited"
			exit = strconv.Itoa(lane.Manifest.ExitCode)
			if lane.Manifest.Signal != nil && *lane.Manifest.Signal != "" {
				exit += "/" + *lane.Manifest.Signal
			}
			duration = formatLaneDuration(lane.Manifest.DurationMS)
		}
		rows = append(rows, []string{
			prefixString(lane.ID, 8), name, toolOfSession(lane.session),
			strings.Replace(lane.Cwd, a.home, "~", 1), state, exit, duration,
		})
	}
	widths := make([]int, len(rows[0]))
	for _, row := range rows {
		for column, cell := range row {
			if jsLength(cell) > widths[column] {
				widths[column] = jsLength(cell)
			}
		}
	}
	for _, row := range rows {
		for column, cell := range row {
			if column > 0 {
				io.WriteString(a.stdout, "  ")
			}
			io.WriteString(a.stdout, cell)
			io.WriteString(a.stdout, strings.Repeat(" ", widths[column]-jsLength(cell)))
		}
		io.WriteString(a.stdout, "\n")
	}
	return nil
}

func formatLaneDuration(milliseconds int64) string {
	if milliseconds < 1000 {
		return fmt.Sprintf("%dms", milliseconds)
	}
	return fmt.Sprintf("%.1fs", float64(milliseconds)/1000)
}

func (a *app) cmdLastDispatch(args []string) error {
	if len(args) == 0 || args[0] == "" {
		return a.cmdLast(args)
	}
	id, lane, err := a.resolveLaneID(args[0])
	if err != nil {
		return err
	}
	if !lane {
		return a.cmdLast(args)
	}
	if len(args) != 1 {
		return fail(1, "usage: pretty last <lane-id> [--json]")
	}
	manifest, statusCode, err := a.fetchLaneManifest(context.Background(), id)
	if err != nil {
		return err
	}
	if statusCode == http.StatusConflict {
		return fail(1, "lane %s is still running", id)
	}
	if statusCode != http.StatusOK {
		return fail(1, "no completion manifest for lane %s", id)
	}
	if a.wantJSON {
		return writeJSON(a.stdout, manifest, true)
	}
	_, err = io.WriteString(a.stdout, manifest.LastOutputTail)
	if err == nil && !strings.HasSuffix(manifest.LastOutputTail, "\n") {
		_, err = io.WriteString(a.stdout, "\n")
	}
	return err
}

func (a *app) cmdWaitDispatch(args []string) error {
	if hasWaitCondition(args) {
		return a.cmdWait(args)
	}
	ids, any, timeout, parseErr := parseLaneWaitArgs(args)
	if parseErr != nil {
		return a.cmdWait(args)
	}
	resolved := make([]string, 0, len(ids))
	for _, candidate := range ids {
		id, lane, err := a.resolveLaneID(candidate)
		if err != nil {
			return err
		}
		if !lane {
			if len(ids) == 1 && !any {
				return a.cmdWait(args)
			}
			return fail(1, "%s is not a lane", candidate)
		}
		resolved = append(resolved, id)
	}
	if len(resolved) > 1 && !any {
		return fail(1, "multiple lanes require --any")
	}
	conditions := make([]waitcond.Condition, 0, len(resolved))
	for _, id := range resolved {
		conditions = append(conditions, &laneExitCondition{app: a, id: id})
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	started := time.Now()
	result, err := waitcond.WaitAny(ctx, conditions)
	if err != nil {
		if errors.Is(err, context.DeadlineExceeded) {
			return a.writeWaitTimeout(timeout, time.Since(started), len(conditions))
		}
		return fail(1, "%s", err)
	}
	manifest, statusCode, err := a.fetchLaneManifest(context.Background(), result.Session)
	if err != nil || statusCode != http.StatusOK {
		if err == nil {
			err = fmt.Errorf("completion manifest returned HTTP %d", statusCode)
		}
		return fail(1, "%s", err)
	}
	if a.wantJSON {
		output := struct {
			ID string `json:"id"`
			laneManifest
		}{ID: result.Session, laneManifest: manifest}
		if err := writeJSON(a.stdout, output, false); err != nil {
			return err
		}
	} else {
		fmt.Fprintf(a.stdout, "%s exited %d after %s\n", result.Session, manifest.ExitCode, formatLaneDuration(manifest.DurationMS))
	}
	if manifest.ExitCode != 0 {
		return status(manifest.ExitCode)
	}
	return nil
}

func hasWaitCondition(args []string) bool {
	for _, argument := range args {
		switch argument {
		case "--until", "--until-file-contains", "--until-idle-stable":
			return true
		}
	}
	return false
}

func parseLaneWaitArgs(args []string) ([]string, bool, time.Duration, error) {
	ids := make([]string, 0, 2)
	any := false
	timeout := 30 * time.Second
	for index := 0; index < len(args); index++ {
		switch args[index] {
		case "--any":
			if any {
				return nil, false, 0, errors.New("duplicate --any")
			}
			any = true
		case "--timeout":
			if index+1 >= len(args) {
				return nil, false, 0, errors.New("missing timeout")
			}
			index++
			parsed, err := parseDuration(args[index], 0)
			if err != nil || parsed <= 0 {
				return nil, false, 0, errors.New("invalid timeout")
			}
			timeout = parsed
		case "--idle":
			if index+1 >= len(args) {
				return nil, false, 0, errors.New("missing idle duration")
			}
			index++
			if parsed, err := parseDuration(args[index], 0); err != nil || parsed < 0 {
				return nil, false, 0, errors.New("invalid idle duration")
			}
		default:
			if strings.HasPrefix(args[index], "-") || args[index] == "" {
				return nil, false, 0, errors.New("not a lane wait")
			}
			ids = append(ids, args[index])
		}
	}
	if len(ids) == 0 {
		return nil, false, 0, errors.New("no lanes")
	}
	return ids, any, timeout, nil
}

type laneExitCondition struct {
	app *app
	id  string
}

func (condition *laneExitCondition) Wait(ctx context.Context) (waitcond.Result, error) {
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		_, statusCode, err := condition.app.fetchLaneManifest(ctx, condition.id)
		if err != nil {
			return waitcond.Result{}, err
		}
		if statusCode == http.StatusOK {
			return waitcond.Result{Kind: laneExitKind, Session: condition.id}, nil
		}
		if statusCode != http.StatusConflict {
			return waitcond.Result{}, fmt.Errorf("lane %s is unavailable", condition.id)
		}
		select {
		case <-ctx.Done():
			return waitcond.Result{}, ctx.Err()
		case <-ticker.C:
		}
	}
}

func (a *app) resolveLaneID(idOrPrefix string) (string, bool, error) {
	var response lanesResponse
	listed, err := a.api.request(context.Background(), http.MethodGet, "/api/lanes", nil, 0)
	if err != nil {
		return "", false, err
	}
	if listed.status == http.StatusNotFound {
		return "", false, nil
	}
	if listed.status >= 400 {
		return "", false, fail(2, "/api/lanes → %d %s", listed.status, prefixBytes(listed.body, 200))
	}
	if err := json.Unmarshal(listed.body, &response); err != nil {
		return "", false, err
	}
	for _, lane := range response.Lanes {
		if lane.ID == idOrPrefix {
			return lane.ID, true, nil
		}
	}
	matches := make([]string, 0, 2)
	for _, lane := range response.Lanes {
		if strings.HasPrefix(lane.ID, idOrPrefix) {
			matches = append(matches, lane.ID)
		}
	}
	if len(matches) == 1 {
		return matches[0], true, nil
	}
	if len(matches) > 1 {
		return "", false, fail(1, "ambiguous lane prefix %q", idOrPrefix)
	}
	if looksLikeLaneID(idOrPrefix) {
		_, statusCode, err := a.fetchLaneManifest(context.Background(), idOrPrefix)
		if err != nil {
			return "", false, err
		}
		if statusCode == http.StatusOK || statusCode == http.StatusConflict {
			return idOrPrefix, true, nil
		}
	}
	return "", false, nil
}

func (a *app) fetchLaneManifest(ctx context.Context, id string) (laneManifest, int, error) {
	response, err := a.api.request(ctx, http.MethodGet, "/api/lanes/"+escapeID(id)+"/manifest", nil, 0)
	if err != nil {
		return laneManifest{}, 0, err
	}
	var manifest laneManifest
	if response.status == http.StatusOK {
		if err := json.Unmarshal(response.body, &manifest); err != nil {
			return laneManifest{}, response.status, err
		}
	}
	return manifest, response.status, nil
}

func looksLikeLaneID(id string) bool {
	if len(id) != 36 {
		return false
	}
	for index, value := range id {
		if index == 8 || index == 13 || index == 18 || index == 23 {
			if value != '-' {
				return false
			}
			continue
		}
		if !strings.ContainsRune("0123456789abcdefABCDEF", value) {
			return false
		}
	}
	return true
}
