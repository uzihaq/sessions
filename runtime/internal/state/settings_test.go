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
	if notify := settings.EffectiveNotify(); !notify.Done || !notify.Waiting || !notify.Lost {
		t.Fatalf("missing notify defaults = %#v", notify)
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
	if err := UpdateSettings(path, func(settings *Settings) error {
		notify := settings.EffectiveNotify()
		if err := notify.Set(NotifyWaiting, false); err != nil {
			return err
		}
		settings.Notify = &notify
		settings.LAN = true
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	settings, err = LoadSettings(path)
	if err != nil || !settings.LAN {
		t.Fatalf("updated settings = %#v, %v", settings, err)
	}
	notify := settings.EffectiveNotify()
	if !notify.Done || notify.Waiting || !notify.Lost {
		t.Fatalf("updated notify settings = %#v", notify)
	}
	if err := notify.Set("unknown", true); err == nil {
		t.Fatal("unknown notification kind was accepted")
	}
}
