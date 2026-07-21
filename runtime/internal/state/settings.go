package state

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

const (
	NotifyDone    = "done"
	NotifyWaiting = "waiting"
	NotifyLost    = "lost"
)

var settingsMu sync.Mutex

type NotifySettings struct {
	Done    bool `json:"done"`
	Waiting bool `json:"waiting"`
	Lost    bool `json:"lost"`
}

func DefaultNotifySettings() NotifySettings {
	return NotifySettings{Done: true, Waiting: true, Lost: true}
}

func (n NotifySettings) Enabled(kind string) bool {
	switch kind {
	case NotifyDone:
		return n.Done
	case NotifyWaiting:
		return n.Waiting
	case NotifyLost:
		return n.Lost
	default:
		return false
	}
}

func (n *NotifySettings) Set(kind string, enabled bool) error {
	switch kind {
	case "":
		n.Done = enabled
		n.Waiting = enabled
		n.Lost = enabled
	case NotifyDone:
		n.Done = enabled
	case NotifyWaiting:
		n.Waiting = enabled
	case NotifyLost:
		n.Lost = enabled
	default:
		return fmt.Errorf("unknown notification kind %q; choose done, waiting, or lost", kind)
	}
	return nil
}

// Settings contains daemon choices which persist independently of runner
// state. Additive fields keep this file easy to extend without changing its
// location or format.
type Settings struct {
	LAN    bool            `json:"lan"`
	Notify *NotifySettings `json:"notify,omitempty"`
}

func (s Settings) EffectiveNotify() NotifySettings {
	if s.Notify == nil {
		return DefaultNotifySettings()
	}
	return *s.Notify
}

func LoadSettings(path string) (Settings, error) {
	encoded, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return Settings{}, nil
	}
	if err != nil {
		return Settings{}, fmt.Errorf("read settings: %w", err)
	}
	var settings Settings
	if err := json.Unmarshal(encoded, &settings); err != nil {
		return Settings{}, fmt.Errorf("decode settings: %w", err)
	}
	return settings, nil
}

func SaveSettings(path string, settings Settings) error {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create settings directory: %w", err)
	}
	encoded, err := json.Marshal(settings)
	if err != nil {
		return fmt.Errorf("encode settings: %w", err)
	}
	temporary, err := os.CreateTemp(filepath.Dir(path), ".settings-*")
	if err != nil {
		return fmt.Errorf("create temporary settings: %w", err)
	}
	temporaryPath := temporary.Name()
	defer os.Remove(temporaryPath)
	if err := temporary.Chmod(0o600); err != nil {
		temporary.Close()
		return fmt.Errorf("chmod temporary settings: %w", err)
	}
	if _, err := temporary.Write(append(encoded, '\n')); err != nil {
		temporary.Close()
		return fmt.Errorf("write settings: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("close settings: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("replace settings: %w", err)
	}
	return nil
}

// UpdateSettings serializes read-modify-write callers which share the daemon's
// settings file so independent settings sections are not accidentally erased.
func UpdateSettings(path string, update func(*Settings) error) error {
	settingsMu.Lock()
	defer settingsMu.Unlock()
	settings, err := LoadSettings(path)
	if err != nil {
		return err
	}
	if err := update(&settings); err != nil {
		return err
	}
	return SaveSettings(path, settings)
}
