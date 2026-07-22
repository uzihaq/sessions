package api

import (
	"context"
	"net/http"
	"strings"
	"testing"

	"github.com/somewhere-tech/sessions/runtime/internal/recap"
	"github.com/somewhere-tech/sessions/runtime/internal/state"
)

func TestRecapSettingsAndGeneration(t *testing.T) {
	daemon := newTestDaemon(t)
	if err := state.SaveSettings(daemon.handler.lan.settingsPath, state.Settings{LAN: true}); err != nil {
		t.Fatal(err)
	}
	daemon.handler.recaps = recap.NewServiceWithRunner(daemon.config.StateRoot, func(_ context.Context, settings state.RecapSettings, prompt string) (string, error) {
		if settings.Provider != state.RecapProviderCodex {
			t.Fatalf("settings = %#v", settings)
		}
		if !strings.Contains(prompt, `"date":"2026-07-22"`) {
			t.Fatalf("prompt = %q", prompt)
		}
		return "# Daily recap\n\nA quiet but valid day.", nil
	})

	off := serve(t, daemon.handler, http.MethodGet, "/api/recap/settings", nil, "127.0.0.1:1", nil)
	if off.Code != http.StatusOK || !strings.Contains(off.Body.String(), `"provider":"off"`) {
		t.Fatalf("off settings: status=%d body=%s", off.Code, off.Body.String())
	}
	updated := serve(t, daemon.handler, http.MethodPut, "/api/recap/settings", strings.NewReader(`{"provider":"codex"}`), "127.0.0.1:1", nil)
	if updated.Code != http.StatusOK {
		t.Fatalf("update settings: status=%d body=%s", updated.Code, updated.Body.String())
	}
	settings, err := state.LoadSettings(daemon.handler.lan.settingsPath)
	if err != nil || !settings.LAN || settings.EffectiveRecap().Provider != state.RecapProviderCodex {
		t.Fatalf("preserved settings = %#v, %v", settings, err)
	}

	generated := serve(t, daemon.handler, http.MethodPost, "/api/recap/generate", strings.NewReader(`{"date":"2026-07-22"}`), "127.0.0.1:1", nil)
	if generated.Code != http.StatusOK || !strings.Contains(generated.Body.String(), "A quiet but valid day") {
		t.Fatalf("generate: status=%d body=%s", generated.Code, generated.Body.String())
	}
	loaded := serve(t, daemon.handler, http.MethodGet, "/api/recap?date=2026-07-22", nil, "127.0.0.1:1", nil)
	if loaded.Code != http.StatusOK || !strings.Contains(loaded.Body.String(), `"provider":"codex"`) {
		t.Fatalf("loaded: status=%d body=%s", loaded.Code, loaded.Body.String())
	}
	badDate := serve(t, daemon.handler, http.MethodGet, "/api/recap?date=yesterday", nil, "127.0.0.1:1", nil)
	if badDate.Code != http.StatusBadRequest {
		t.Fatalf("bad date: status=%d body=%s", badDate.Code, badDate.Body.String())
	}
}
