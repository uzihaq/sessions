package api

import (
	"bytes"
	"context"
	"crypto/aes"
	"crypto/cipher"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/uzihaq/pretty-pty/prettygo/internal/proto"
	"github.com/uzihaq/pretty-pty/prettygo/internal/proto/prototest"
	sessionruntime "github.com/uzihaq/pretty-pty/prettygo/internal/session"
	"github.com/uzihaq/pretty-pty/prettygo/internal/state"
	"golang.org/x/crypto/hkdf"
)

type pushTestSubscription struct {
	value      map[string]any
	privateKey []byte
	publicKey  []byte
	auth       []byte
}

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

func TestWorkingToIdleSendsEncryptedPushToMock(t *testing.T) {
	type capturedPush struct {
		method string
		header http.Header
		body   []byte
	}
	received := make(chan capturedPush, 1)
	mock := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read mock push body: %v", err)
		}
		received <- capturedPush{method: request.Method, header: request.Header.Clone(), body: body}
		response.WriteHeader(http.StatusCreated)
	}))
	defer mock.Close()

	config, launcher, manager := newPushTestManager(t)
	manager.Push().SetHTTPClient(mock.Client())
	handler := New(config, manager, manager.Push())

	vapid := serve(t, handler, http.MethodGet, "/api/push/vapid", nil, "127.0.0.1:1", nil)
	if vapid.Code != http.StatusOK {
		t.Fatalf("vapid status=%d body=%s", vapid.Code, vapid.Body.String())
	}
	var vapidBody map[string]string
	decodeBody(t, vapid, &vapidBody)
	if vapidBody["publicKey"] == "" {
		t.Fatalf("vapid response = %#v", vapidBody)
	}
	assertMode(t, filepath.Join(config.UserStateRoot, "vapid.json"), 0o600)

	subscription := validPushSubscription(t, mock.URL)
	encodedSubscription, err := json.Marshal(subscription.value)
	if err != nil {
		t.Fatal(err)
	}
	subscribed := serve(t, handler, http.MethodPost, "/api/push/subscribe", bytes.NewReader(encodedSubscription), "127.0.0.1:1", nil)
	if subscribed.Code != http.StatusOK {
		t.Fatalf("subscribe status=%d body=%s", subscribed.Code, subscribed.Body.String())
	}
	assertMode(t, filepath.Join(config.UserStateRoot, "push-subscriptions.json"), 0o600)

	created, err := manager.Create(context.Background(), state.CreateSessionRequest{
		Cmd: "/bin/sh", Cwd: config.DefaultCwd, Name: "encrypted edge",
	})
	if err != nil {
		t.Fatal(err)
	}
	select {
	case unexpected := <-received:
		t.Fatalf("push sent without a working to idle edge: %#v", unexpected)
	case <-time.After(3 * 10 * time.Millisecond):
	}
	const plaintextMarker = "AUTHPUSH_IDLE_PAYLOAD_MARKER"
	launcher.Runner(created.ID).AddOutput(strings.Repeat("completed work ", 20) + "\n" + plaintextMarker + "\nAll checks passed\n")

	var push capturedPush
	select {
	case push = <-received:
	case <-time.After(2 * time.Second):
		t.Fatal("mock endpoint did not receive the working to idle notification")
	}
	if push.method != http.MethodPost {
		t.Fatalf("push method = %q", push.method)
	}
	if got := push.header.Get("Content-Encoding"); got != "aes128gcm" {
		t.Fatalf("Content-Encoding = %q", got)
	}
	if got := push.header.Get("Content-Type"); got != "application/octet-stream" {
		t.Fatalf("Content-Type = %q", got)
	}
	if push.header.Get("Authorization") == "" || push.header.Get("TTL") != "3600" || push.header.Get("Urgency") != "normal" {
		t.Fatalf("push headers = %#v", push.header)
	}
	if len(push.body) < 100 || bytes.Contains(push.body, []byte(plaintextMarker)) {
		t.Fatalf("push body is not an encrypted payload: bytes=%d plaintext=%t", len(push.body), bytes.Contains(push.body, []byte(plaintextMarker)))
	}
	payload := decryptPushPayload(t, push.body, subscription)
	if payload.Title != "🟢 encrypted edge — done" {
		t.Fatalf("decrypted notification = %#v", payload)
	}
}

func TestWorkingToIdleNotificationShapes(t *testing.T) {
	tests := []struct {
		name       string
		snapshot   string
		wantPrefix string
	}{
		{name: "done", snapshot: "Implemented the change.\nAll checks passed.\n", wantPrefix: "🟢 done — done"},
		{name: "blocked", snapshot: "The migration changes data.\nContinue? [y/N]\n", wantPrefix: "🟡 blocked — needs you"},
		{name: "error", snapshot: "Traceback: request failed.\nFatal error: connection failed\n", wantPrefix: "🔴 error — hit an error"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			bodies := make(chan []byte, 1)
			mock := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
				body, err := io.ReadAll(request.Body)
				if err != nil {
					t.Errorf("read mock push body: %v", err)
				}
				bodies <- body
				response.WriteHeader(http.StatusCreated)
			}))
			defer mock.Close()
			config, launcher, manager := newPushTestManager(t)
			manager.Push().SetHTTPClient(mock.Client())
			subscription := validPushSubscription(t, mock.URL)
			if err := manager.Push().AddSubscription(subscription.value); err != nil {
				t.Fatal(err)
			}
			created, err := manager.Create(context.Background(), state.CreateSessionRequest{
				Cmd: "/bin/sh", Cwd: config.DefaultCwd, Name: test.name,
			})
			if err != nil {
				t.Fatal(err)
			}
			launcher.Runner(created.ID).AddOutput(strings.Repeat("context ", 30) + "\n" + test.snapshot)
			select {
			case body := <-bodies:
				notification := decryptPushPayload(t, body, subscription)
				if notification.Title != test.wantPrefix {
					t.Fatalf("notification title = %q, want %q", notification.Title, test.wantPrefix)
				}
			case <-time.After(2 * time.Second):
				t.Fatal("working to idle notification was not observed")
			}
		})
	}
}

func TestLaneDeathSendsEncryptedPushToMock(t *testing.T) {
	bodies := make(chan []byte, 1)
	mock := httptest.NewServer(http.HandlerFunc(func(response http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read mock push body: %v", err)
		}
		bodies <- body
		response.WriteHeader(http.StatusCreated)
	}))
	defer mock.Close()
	config, launcher, manager := newPushTestManager(t)
	manager.Push().SetHTTPClient(mock.Client())
	subscription := validPushSubscription(t, mock.URL)
	if err := manager.Push().AddSubscription(subscription.value); err != nil {
		t.Fatal(err)
	}
	created, err := manager.Create(context.Background(), state.CreateSessionRequest{
		Cmd: "/bin/sh", Cwd: config.DefaultCwd, Name: "scratch death", Kind: state.KindLane,
	})
	if err != nil {
		t.Fatal(err)
	}
	code := 7
	launcher.Runner(created.ID).Emit(proto.Event{Kind: proto.EventExit, Exit: proto.ExitEvent{Code: &code}})
	select {
	case body := <-bodies:
		payload := decryptPushPayload(t, body, subscription)
		if payload.Title != "🔴 scratch death died (exit 7)" {
			t.Fatalf("lane death notification = %#v", payload)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("mock endpoint did not receive the lane death notification")
	}
}

func newPushTestManager(t *testing.T) (state.Config, *prototest.Launcher, *sessionruntime.Manager) {
	t.Helper()
	root := t.TempDir()
	config := state.Config{
		Host: "127.0.0.1", Port: 0,
		DefaultShell: "/bin/sh", DefaultCwd: root, DefaultCols: 300, DefaultRows: 50,
		StateRoot:       filepath.Join(root, "state"),
		UserStateRoot:   filepath.Join(root, "user-state"),
		RunnerStateDir:  filepath.Join(root, "state", "runners"),
		TokenPath:       filepath.Join(root, "state", "token"),
		OpenPath:        filepath.Join(root, "state", "open"),
		LaunchAgentsDir: filepath.Join(root, "agents"),
	}
	launcher := prototest.NewLauncher()
	manager := sessionruntime.NewManager(config, launcher, sessionruntime.ManagerOptions{
		DisableWatchers: true, ActivityInterval: 10 * time.Millisecond,
	})
	t.Cleanup(manager.Close)
	return config, launcher, manager
}

func validPushSubscription(t *testing.T, endpoint string) pushTestSubscription {
	t.Helper()
	privateKey, x, y, err := elliptic.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatal(err)
	}
	publicKey := elliptic.Marshal(elliptic.P256(), x, y)
	auth := make([]byte, 16)
	if _, err := rand.Read(auth); err != nil {
		t.Fatal(err)
	}
	return pushTestSubscription{
		value: map[string]any{
			"endpoint": endpoint, "expirationTime": nil,
			"keys": map[string]string{
				"p256dh": base64.RawURLEncoding.EncodeToString(publicKey),
				"auth":   base64.RawURLEncoding.EncodeToString(auth),
			},
		},
		privateKey: privateKey, publicKey: publicKey, auth: auth,
	}
}

func decryptPushPayload(t *testing.T, body []byte, subscription pushTestSubscription) sessionruntime.PushPayload {
	t.Helper()
	if len(body) < 21 {
		t.Fatalf("encrypted push is too short: %d", len(body))
	}
	salt := body[:16]
	recordSize := binary.BigEndian.Uint32(body[16:20])
	serverKeyLength := int(body[20])
	headerLength := 21 + serverKeyLength
	if recordSize == 0 || serverKeyLength == 0 || len(body) <= headerLength {
		t.Fatalf("invalid encrypted push header: record=%d key=%d bytes=%d", recordSize, serverKeyLength, len(body))
	}
	serverPublicKey := body[21:headerLength]
	serverX, serverY := elliptic.Unmarshal(elliptic.P256(), serverPublicKey)
	if serverX == nil {
		t.Fatal("invalid server public key in encrypted push")
	}
	sharedX, _ := elliptic.P256().ScalarMult(serverX, serverY, subscription.privateKey)
	sharedSecret := make([]byte, 32)
	sharedX.FillBytes(sharedSecret)
	info := append([]byte("WebPush: info\x00"), subscription.publicKey...)
	info = append(info, serverPublicKey...)
	ikm := hkdfBytes(t, sharedSecret, subscription.auth, info, 32)
	contentKey := hkdfBytes(t, ikm, salt, []byte("Content-Encoding: aes128gcm\x00"), 16)
	nonce := hkdfBytes(t, ikm, salt, []byte("Content-Encoding: nonce\x00"), 12)
	block, err := aes.NewCipher(contentKey)
	if err != nil {
		t.Fatal(err)
	}
	gcm, err := cipher.NewGCM(block)
	if err != nil {
		t.Fatal(err)
	}
	plaintext, err := gcm.Open(nil, nonce, body[headerLength:], nil)
	if err != nil {
		t.Fatalf("decrypt push: %v", err)
	}
	delimiter := bytes.IndexByte(plaintext, 0x02)
	if delimiter < 0 {
		t.Fatal("decrypted push has no record delimiter")
	}
	for _, padding := range plaintext[delimiter+1:] {
		if padding != 0 {
			t.Fatal("decrypted push has invalid padding")
		}
	}
	var payload sessionruntime.PushPayload
	if err := json.Unmarshal(plaintext[:delimiter], &payload); err != nil {
		t.Fatalf("decode decrypted push %q: %v", plaintext[:delimiter], err)
	}
	return payload
}

func hkdfBytes(t *testing.T, secret, salt, info []byte, size int) []byte {
	t.Helper()
	value := make([]byte, size)
	if _, err := io.ReadFull(hkdf.New(sha256.New, secret, salt, info), value); err != nil {
		t.Fatal(err)
	}
	return value
}
