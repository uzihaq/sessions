package state

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSettingsRoundTrip(t *testing.T) {
	path := filepath.Join(t.TempDir(), "nested", "settings.json")
	settings, err := LoadSettings(path)
	if err != nil || settings.LAN {
		t.Fatalf("missing settings = %#v, %v", settings, err)
	}
	if err := SaveSettings(path, Settings{LAN: true}); err != nil {
		t.Fatal(err)
	}
	settings, err = LoadSettings(path)
	if err != nil || !settings.LAN {
		t.Fatalf("loaded settings = %#v, %v", settings, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0o600 {
		t.Fatalf("settings mode = %04o, want 0600", info.Mode().Perm())
	}
	if err := SaveSettings(path, Settings{}); err != nil {
		t.Fatal(err)
	}
	settings, err = LoadSettings(path)
	if err != nil || settings.LAN {
		t.Fatalf("disabled settings = %#v, %v", settings, err)
	}
}
