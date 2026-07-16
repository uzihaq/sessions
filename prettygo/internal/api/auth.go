package api

import (
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

var hostedShellOrigins = map[string]struct{}{
	"https://pretty-pty.somewhere.tech": {},
	"https://pretty-pty.somewhere.site": {},
}

type tokenStore struct {
	path string
	mu   sync.Mutex
}

func (s *tokenStore) token() (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if encoded, err := os.ReadFile(s.path); err == nil {
		value := strings.TrimSpace(string(encoded))
		if validToken(value) {
			return value, nil
		}
	}
	if err := os.MkdirAll(filepath.Dir(s.path), 0o700); err != nil {
		return "", fmt.Errorf("create token directory: %w", err)
	}
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", fmt.Errorf("generate auth token: %w", err)
	}
	value := hex.EncodeToString(bytes)
	if err := os.WriteFile(s.path, []byte(value), 0o600); err != nil {
		return "", fmt.Errorf("write auth token: %w", err)
	}
	if err := os.Chmod(s.path, 0o600); err != nil {
		return "", fmt.Errorf("chmod auth token: %w", err)
	}
	return value, nil
}

func validToken(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

func tokenEqual(provided, expected string) bool {
	if len(provided) != len(expected) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(expected)) == 1
}

func isLoopbackPeer(request *http.Request) bool {
	for key := range request.Header {
		if strings.EqualFold(key, "X-Forwarded-For") {
			return false
		}
	}
	host, _, err := net.SplitHostPort(request.RemoteAddr)
	if err != nil {
		host = strings.Trim(request.RemoteAddr, "[]")
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

func allowedOrigin(origin, bindHost string) bool {
	if origin == "" {
		return true
	}
	parsed, err := url.Parse(origin)
	if err != nil || parsed.Scheme == "" || parsed.Host == "" {
		return false
	}
	normalized := normalizedOrigin(parsed)
	if _, allowed := hostedShellOrigins[normalized]; allowed {
		return true
	}
	hostname := strings.ToLower(parsed.Hostname())
	if hostname == "127.0.0.1" || hostname == "localhost" || hostname == "::1" {
		return true
	}
	return strings.EqualFold(hostname, strings.Trim(bindHost, "[]"))
}

func normalizedOrigin(parsed *url.URL) string {
	scheme := strings.ToLower(parsed.Scheme)
	host := strings.ToLower(parsed.Hostname())
	if strings.Contains(host, ":") {
		host = "[" + host + "]"
	}
	port := parsed.Port()
	if (scheme == "https" && port == "443") || (scheme == "http" && port == "80") {
		port = ""
	}
	if port != "" {
		host += ":" + port
	}
	return scheme + "://" + host
}
