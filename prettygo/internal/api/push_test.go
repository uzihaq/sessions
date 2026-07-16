package api

import (
	"bytes"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"
	"testing"
)

func TestPushRoutesPersistAndRemoveSubscriptions(t *testing.T) {
	daemon := newTestDaemon(t)
	vapid := serve(t, daemon.handler, http.MethodGet, "/api/push/vapid", nil, "127.0.0.1:1", nil)
	if vapid.Code != http.StatusOK {
		t.Fatalf("vapid status=%d body=%s", vapid.Code, vapid.Body.String())
	}
	var vapidBody map[string]any
	decodeBody(t, vapid, &vapidBody)
	if vapidBody["publicKey"] == "" {
		t.Fatalf("vapid response = %#v", vapidBody)
	}

	invalid := serve(t, daemon.handler, http.MethodPost, "/api/push/subscribe", bytes.NewBufferString(`{"endpoint":""}`), "127.0.0.1:1", nil)
	if invalid.Code != http.StatusBadRequest || !bytes.Contains(invalid.Body.Bytes(), []byte("invalid push subscription")) {
		t.Fatalf("invalid subscription status=%d body=%s", invalid.Code, invalid.Body.String())
	}
	subscription := map[string]any{
		"endpoint": "https://push.example/subscription", "expirationTime": nil,
		"keys": map[string]string{"p256dh": "public", "auth": "secret"},
	}
	encoded, _ := json.Marshal(subscription)
	added := serve(t, daemon.handler, http.MethodPost, "/api/push/subscribe", bytes.NewReader(encoded), "127.0.0.1:1", nil)
	if added.Code != http.StatusOK {
		t.Fatalf("subscribe status=%d body=%s", added.Code, added.Body.String())
	}
	path := filepath.Join(daemon.config.StateRoot, "push-subscriptions.json")
	stored, err := os.ReadFile(path)
	if err != nil || !bytes.Contains(stored, []byte("push.example")) {
		t.Fatalf("stored subscriptions=%s err=%v", stored, err)
	}
	removed := serve(t, daemon.handler, http.MethodPost, "/api/push/unsubscribe", bytes.NewBufferString(`{"endpoint":"https://push.example/subscription"}`), "127.0.0.1:1", nil)
	if removed.Code != http.StatusOK {
		t.Fatalf("unsubscribe status=%d body=%s", removed.Code, removed.Body.String())
	}
	stored, err = os.ReadFile(path)
	if err != nil || string(stored) != "[]" {
		t.Fatalf("subscriptions after remove=%q err=%v", stored, err)
	}
}
