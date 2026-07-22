package search

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"hash/fnv"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/somewhere-tech/sessions/runtime/internal/integrations"
	"github.com/somewhere-tech/sessions/runtime/internal/state"
	_ "modernc.org/sqlite"
)

const indexSchema = `
CREATE VIRTUAL TABLE IF NOT EXISTS messages USING fts5(
    session_id UNINDEXED, name UNINDEXED, tool UNINDEXED, role UNINDEXED, ts UNINDEXED,
    text, tokenize='porter unicode61'
);
CREATE TABLE IF NOT EXISTS session_fingerprint (session_id TEXT PRIMARY KEY, fp TEXT NOT NULL);
`

type rankedSession struct {
	history integrations.HistorySession
	tool    string
}

func runRanked(ctx context.Context, source HistorySource, live []state.SessionInfo, options Options, indexPath string) (Response, error) {
	matchExpression, err := rankedMatchExpression(options.Query)
	if err != nil {
		return Response{}, err
	}
	if strings.TrimSpace(indexPath) == "" {
		return Response{}, errors.New("search index path is required for ranked search")
	}

	sessions, err := source.SearchSessions(live)
	if err != nil {
		return Response{}, err
	}
	selectedID, err := resolveSessionID(sessions, options.SessionID)
	if err != nil {
		return Response{}, err
	}
	options.SessionID = selectedID
	candidates := make([]rankedSession, 0, len(sessions))
	for _, session := range sessions {
		tool := normalizeTool(session.Tool)
		if selectedID != "" && session.ID != selectedID {
			continue
		}
		if options.Tool != "" && tool != options.Tool {
			continue
		}
		if !session.ConversationAvailable {
			continue
		}
		candidates = append(candidates, rankedSession{history: session, tool: tool})
	}
	if len(candidates) == 0 {
		return Response{Matches: []Match{}}, nil
	}

	db, err := openIndex(ctx, indexPath)
	if err != nil {
		return Response{}, err
	}
	defer db.Close()

	querySessionIDs := make([]string, 0, len(candidates))
	for _, candidate := range candidates {
		if err := ctx.Err(); err != nil {
			return Response{}, err
		}
		transcript, err := source.TranscriptLimited(live, candidate.history.ID, MaxFileReadBytes)
		if errors.Is(err, integrations.ErrHistoryNotFound) {
			if err := removeIndexedSession(ctx, db, candidate.history.ID); err != nil {
				return Response{}, err
			}
			continue
		}
		if err != nil {
			return Response{}, err
		}
		if err := refreshIndexedSession(ctx, db, candidate, transcript.Messages); err != nil {
			return Response{}, err
		}
		querySessionIDs = append(querySessionIDs, candidate.history.ID)
	}
	if len(querySessionIDs) == 0 {
		return Response{Matches: []Match{}}, nil
	}
	if err := replaceQuerySessions(ctx, db, querySessionIDs); err != nil {
		return Response{}, err
	}

	return queryRanked(ctx, db, matchExpression, options)
}

func rankedMatchExpression(query string) (string, error) {
	if query == "" || strings.TrimSpace(query) == "" {
		return "", &optionError{message: "q is required"}
	}
	fields := strings.Fields(query)
	explicitSyntax := strings.Contains(query, `"`)
	for _, field := range fields {
		if field == "AND" || field == "OR" || field == "NOT" {
			explicitSyntax = true
			break
		}
	}
	if explicitSyntax {
		return strings.TrimSpace(query), nil
	}
	quoted := make([]string, 0, len(fields))
	for _, field := range fields {
		quoted = append(quoted, `"`+strings.ReplaceAll(field, `"`, `""`)+`"`)
	}
	return strings.Join(quoted, " "), nil
}

func openIndex(ctx context.Context, path string) (*sql.DB, error) {
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return nil, fmt.Errorf("create search index directory: %w", err)
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create search index: %w", err)
	}
	if err := file.Chmod(0o600); err != nil {
		_ = file.Close()
		return nil, fmt.Errorf("chmod search index: %w", err)
	}
	if err := file.Close(); err != nil {
		return nil, fmt.Errorf("close search index bootstrap file: %w", err)
	}

	db, err := sql.Open("sqlite", path)
	if err != nil {
		return nil, fmt.Errorf("open search index: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if _, err := db.ExecContext(ctx, "PRAGMA busy_timeout=5000"); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("configure search index: %w", err)
	}
	if _, err := db.ExecContext(ctx, indexSchema); err != nil {
		_ = db.Close()
		return nil, fmt.Errorf("initialize search index: %w", err)
	}
	return db, nil
}

func refreshIndexedSession(ctx context.Context, db *sql.DB, session rankedSession, messages []integrations.TranscriptMessage) error {
	fingerprint := transcriptFingerprint(session, messages)
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin search index refresh for %s: %w", session.history.ID, err)
	}
	defer tx.Rollback()

	var existing string
	err = tx.QueryRowContext(ctx, "SELECT fp FROM session_fingerprint WHERE session_id = ?", session.history.ID).Scan(&existing)
	if err == nil && existing == fingerprint {
		if err := tx.Commit(); err != nil {
			return fmt.Errorf("finish unchanged search index refresh for %s: %w", session.history.ID, err)
		}
		return nil
	}
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return fmt.Errorf("read search index fingerprint for %s: %w", session.history.ID, err)
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM messages WHERE session_id = ?", session.history.ID); err != nil {
		return fmt.Errorf("clear search index session %s: %w", session.history.ID, err)
	}
	insert, err := tx.PrepareContext(ctx, "INSERT INTO messages(session_id, name, tool, role, ts, text) VALUES (?, ?, ?, ?, ?, ?)")
	if err != nil {
		return fmt.Errorf("prepare search index messages for %s: %w", session.history.ID, err)
	}
	defer insert.Close()
	for _, message := range messages {
		var timestamp any
		if message.Timestamp != nil {
			timestamp = *message.Timestamp
		}
		if _, err := insert.ExecContext(ctx, session.history.ID, session.history.Name, session.tool, message.Role, timestamp, message.Text); err != nil {
			return fmt.Errorf("index search message for %s: %w", session.history.ID, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `
INSERT INTO session_fingerprint(session_id, fp) VALUES (?, ?)
ON CONFLICT(session_id) DO UPDATE SET fp = excluded.fp`, session.history.ID, fingerprint); err != nil {
		return fmt.Errorf("write search index fingerprint for %s: %w", session.history.ID, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit search index refresh for %s: %w", session.history.ID, err)
	}
	return nil
}

func transcriptFingerprint(session rankedSession, messages []integrations.TranscriptMessage) string {
	hash := fnv.New64a()
	writeFingerprintPart := func(value string) {
		_, _ = hash.Write([]byte(strconv.Itoa(len(value))))
		_, _ = hash.Write([]byte{0})
		_, _ = hash.Write([]byte(value))
		_, _ = hash.Write([]byte{0xff})
	}
	writeFingerprintPart(session.history.Name)
	writeFingerprintPart(session.tool)
	for _, message := range messages {
		writeFingerprintPart(message.Role)
		if message.Timestamp != nil {
			writeFingerprintPart(*message.Timestamp)
		} else {
			writeFingerprintPart("")
		}
		writeFingerprintPart(message.Text)
	}
	return fmt.Sprintf("%d:%016x", len(messages), hash.Sum64())
}

func removeIndexedSession(ctx context.Context, db *sql.DB, sessionID string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin stale search index cleanup for %s: %w", sessionID, err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "DELETE FROM messages WHERE session_id = ?", sessionID); err != nil {
		return fmt.Errorf("clear stale search index session %s: %w", sessionID, err)
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM session_fingerprint WHERE session_id = ?", sessionID); err != nil {
		return fmt.Errorf("clear stale search index fingerprint %s: %w", sessionID, err)
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit stale search index cleanup for %s: %w", sessionID, err)
	}
	return nil
}

func replaceQuerySessions(ctx context.Context, db *sql.DB, sessionIDs []string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin ranked search session selection: %w", err)
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "CREATE TEMP TABLE IF NOT EXISTS search_query_sessions (session_id TEXT PRIMARY KEY)"); err != nil {
		return fmt.Errorf("create ranked search session selection: %w", err)
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM search_query_sessions"); err != nil {
		return fmt.Errorf("reset ranked search session selection: %w", err)
	}
	insert, err := tx.PrepareContext(ctx, "INSERT INTO search_query_sessions(session_id) VALUES (?)")
	if err != nil {
		return fmt.Errorf("prepare ranked search session selection: %w", err)
	}
	defer insert.Close()
	for _, sessionID := range sessionIDs {
		if _, err := insert.ExecContext(ctx, sessionID); err != nil {
			return fmt.Errorf("select ranked search session %s: %w", sessionID, err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit ranked search session selection: %w", err)
	}
	return nil
}

func queryRanked(ctx context.Context, db *sql.DB, matchExpression string, options Options) (Response, error) {
	where := []string{
		"messages MATCH ?",
		"messages.session_id IN (SELECT session_id FROM search_query_sessions)",
	}
	arguments := []any{matchExpression}
	if options.Role != "" {
		where = append(where, "messages.role = ?")
		arguments = append(arguments, options.Role)
	}
	if options.Tool != "" {
		where = append(where, "messages.tool = ?")
		arguments = append(arguments, options.Tool)
	}
	if options.SessionID != "" {
		where = append(where, "messages.session_id = ?")
		arguments = append(arguments, options.SessionID)
	}
	arguments = append(arguments, options.Limit)
	query := `
SELECT messages.session_id, messages.name, messages.tool, messages.role, messages.ts,
       messages.text, snippet(messages, 5, '[[', ']]', '…', 32)
FROM messages
WHERE ` + strings.Join(where, " AND ") + `
ORDER BY bm25(messages) ASC, messages.rowid ASC
LIMIT ?`
	rows, err := db.QueryContext(ctx, query, arguments...)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return Response{}, ctxErr
		}
		return Response{}, &optionError{message: fmt.Sprintf("invalid ranked query: %v", err)}
	}
	defer rows.Close()

	result := Response{Matches: make([]Match, 0, min(options.Limit, 16))}
	for rows.Next() {
		var match Match
		if err := rows.Scan(&match.SessionID, &match.Name, &match.Tool, &match.Role, &match.Timestamp, &match.Text, &match.Snippet); err != nil {
			return Response{}, fmt.Errorf("read ranked search result: %w", err)
		}
		result.Matches = append(result.Matches, match)
	}
	if err := rows.Err(); err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return Response{}, ctxErr
		}
		return Response{}, &optionError{message: fmt.Sprintf("invalid ranked query: %v", err)}
	}
	result.Total = len(result.Matches)
	return result, nil
}
