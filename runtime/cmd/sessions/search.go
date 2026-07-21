package main

import (
	"fmt"
	"io"
	"net/url"
	"strconv"
	"strings"

	historysearch "github.com/uzihaq/sessions/runtime/internal/search"
)

func (a *app) cmdSearch(args []string) error {
	if len(args) == 0 || args[0] == "" {
		return searchUsage()
	}
	queryText := args[0]
	args = args[1:]
	regex := removeFirst(&args, "--regex")
	ranked := removeFirst(&args, "--ranked")
	if ranked && regex {
		return fail(1, "--ranked cannot combine with --regex")
	}
	sessionID, hasSession := pluck(&args, "--session")
	role, hasRole := pluck(&args, "--role")
	tool, hasTool := pluck(&args, "--tool")
	limitText, hasLimit := pluck(&args, "-n")
	if len(args) != 0 {
		if strings.HasPrefix(queryText, "-") {
			return fail(1, "the query must come before flags, but %q looks like a flag used as the query.\ntry: sessions search %q %s ...\n%s", queryText, args[0], queryText, searchUsageText)
		}
		return fail(1, "unknown search option: %s\n%s", args[0], searchUsageText)
	}
	if hasSession && strings.TrimSpace(sessionID) == "" {
		return fail(1, "--session needs a session id")
	}
	role = strings.ToLower(role)
	if hasRole && role != "user" && role != "assistant" {
		return fail(1, "--role must be \"user\" or \"assistant\"")
	}
	tool = strings.ToLower(tool)
	if hasTool && tool != "claude" && tool != "codex" && tool != "shell" {
		return fail(1, "--tool must be \"claude\", \"codex\", or \"shell\"")
	}
	limit := 0
	if hasLimit {
		parsed, err := strconv.Atoi(limitText)
		if err != nil || parsed < 1 || parsed > historysearch.MaxLimit {
			return fail(1, "-n must be between 1 and %d", historysearch.MaxLimit)
		}
		limit = parsed
	}

	parameters := url.Values{"q": {queryText}}
	if hasSession {
		parameters.Set("session", sessionID)
	}
	if hasRole {
		parameters.Set("role", role)
	}
	if hasTool {
		parameters.Set("tool", tool)
	}
	if regex {
		parameters.Set("regex", "true")
	}
	if ranked {
		parameters.Set("ranked", "1")
	}
	if hasLimit {
		parameters.Set("limit", strconv.Itoa(limit))
	}
	var result historysearch.Response
	if err := a.getJSON("/api/search?"+parameters.Encode(), &result); err != nil {
		return err
	}
	if a.wantJSON {
		return writeJSON(a.stdout, result, true)
	}
	if len(result.Matches) == 0 {
		_, err := io.WriteString(a.stdout, "(no matches)\n")
		return err
	}
	currentSession := ""
	for _, match := range result.Matches {
		if match.SessionID != currentSession {
			if currentSession != "" {
				fmt.Fprintln(a.stdout)
			}
			name := match.Name
			if name == "" {
				name = "(unnamed)"
			}
			fmt.Fprintf(a.stdout, "%s  %s  %s\n", prefixString(match.SessionID, 8), name, match.Tool)
			currentSession = match.SessionID
		}
		timestamp := "(no timestamp)"
		if match.Timestamp != nil && *match.Timestamp != "" {
			timestamp = *match.Timestamp
		}
		fmt.Fprintf(a.stdout, "  %s  %s\n    %s\n", match.Role, timestamp, match.Snippet)
	}
	return nil
}

const searchUsageText = "usage: sessions search <query> [--session ID] [--role user|assistant] [--tool claude|codex|shell] [-n N] [--regex | --ranked] [--json]\nthe query comes FIRST, before any flags"

func searchUsage() error {
	return fail(1, searchUsageText)
}
