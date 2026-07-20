package usage

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "modernc.org/sqlite"
)

type Service struct {
	options Options
	once    sync.Once
	db      *sql.DB
	openErr error
	mu      sync.Mutex
}

func NewService(options Options) *Service {
	if options.Now == nil {
		options.Now = time.Now
	}
	return &Service{options: options}
}

func (s *Service) database(ctx context.Context) (*sql.DB, error) {
	s.once.Do(func() {
		if s.options.Path == "" {
			s.openErr = errors.New("usage database path is empty")
			return
		}
		if err := os.MkdirAll(filepath.Dir(s.options.Path), 0o700); err != nil {
			s.openErr = fmt.Errorf("create usage state directory: %w", err)
			return
		}
		db, err := sql.Open("sqlite", s.options.Path)
		if err != nil {
			s.openErr = err
			return
		}
		db.SetMaxOpenConns(1)
		if _, err = db.ExecContext(ctx, `
PRAGMA journal_mode=WAL;
PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS usage_sources (
  path TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  offset_bytes INTEGER NOT NULL DEFAULT 0,
  size_bytes INTEGER NOT NULL DEFAULT 0,
  mtime_ns INTEGER NOT NULL DEFAULT 0,
  parser_state TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS usage_entries (
  event_key TEXT PRIMARY KEY,
  source_path TEXT NOT NULL,
  source_offset INTEGER NOT NULL,
  provider TEXT NOT NULL,
  provider_session_id TEXT NOT NULL,
  timestamp_ms INTEGER NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL,
  output_tokens INTEGER NOT NULL,
  cache_creation_tokens INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  recorded_cost_usd REAL,
  calculated_cost_usd REAL NOT NULL,
  pricing_found INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS usage_entries_time ON usage_entries(timestamp_ms);
CREATE INDEX IF NOT EXISTS usage_entries_session ON usage_entries(provider, provider_session_id);
CREATE INDEX IF NOT EXISTS usage_entries_source ON usage_entries(source_path);
`); err != nil {
			_ = db.Close()
			s.openErr = fmt.Errorf("initialize usage ledger: %w", err)
			return
		}
		if err := os.Chmod(s.options.Path, 0o600); err != nil {
			_ = db.Close()
			s.openErr = fmt.Errorf("protect usage ledger: %w", err)
			return
		}
		s.db = db
	})
	return s.db, s.openErr
}

func (s *Service) Close() error {
	if s.db == nil {
		return nil
	}
	return s.db.Close()
}
