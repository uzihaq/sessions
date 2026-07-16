package api

import (
	"encoding/json"
	"errors"
	"io"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/uzihaq/pretty-pty/prettygo/internal/state"
)

const maxJSONBody = 2 * 1024 * 1024

type Server struct {
	config   state.Config
	registry *state.Registry
	tokens   tokenStore
}

func New(config state.Config, registry *state.Registry) *Server {
	return &Server{config: config, registry: registry, tokens: tokenStore{path: config.TokenPath}}
}

func (s *Server) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	path := request.URL.Path
	origin := request.Header.Get("Origin")
	corsOrigin := ""
	if allowedOrigin(origin, s.config.Host) {
		corsOrigin = origin
	}

	if request.Method == http.MethodOptions {
		s.sendJSON(response, http.StatusNoContent, map[string]any{}, corsOrigin)
		return
	}
	if isStaticRequest(path, request.Method) {
		if !s.serveStatic(response, request) {
			s.sendJSON(response, http.StatusNotFound, map[string]any{
				"error": "web build not found", "path": s.config.WebDir,
			}, corsOrigin)
		}
		return
	}
	if path == "/api/health" && request.Method == http.MethodGet {
		s.sendJSON(response, http.StatusOK, map[string]any{
			"ok": true, "name": "prettyd", "version": "0.1.0",
			"listen":         map[string]any{"host": s.config.Host, "port": s.config.Port},
			"discovering":    s.registry.IsDiscovering(),
			"sessionsLoaded": len(s.registry.List(true)),
		}, corsOrigin)
		return
	}
	if path == "/api/health/deep" && request.Method == http.MethodGet {
		s.sendJSON(response, http.StatusOK, map[string]any{
			"ok": true, "name": "prettyd", "version": "0.1.0",
			"discovering":    s.registry.IsDiscovering(),
			"sessionsLoaded": len(s.registry.List(true)),
			"uptimeSec":      int64(math.Round(s.registry.Uptime().Seconds())),
			"sessions":       s.registry.DeepDiagnostics(),
		}, corsOrigin)
		return
	}

	authorized, err := s.authorized(request)
	if err != nil {
		s.sendJSON(response, http.StatusInternalServerError, map[string]any{"error": err.Error()}, corsOrigin)
		return
	}
	if !authorized {
		s.sendJSON(response, http.StatusUnauthorized, map[string]any{"error": "unauthorized"}, corsOrigin)
		return
	}
	if path == "/ws" {
		if !allowedOrigin(origin, s.config.Host) {
			s.sendJSON(response, http.StatusForbidden, map[string]any{"error": "forbidden origin"}, "")
			return
		}
		s.serveWebSocket(response, request)
		return
	}
	if path == "/api/sessions" && request.Method == http.MethodGet {
		includeExited := request.URL.Query().Get("include_exited") == "1"
		s.sendJSON(response, http.StatusOK, map[string]any{"sessions": s.registry.List(includeExited)}, corsOrigin)
		return
	}
	if path == "/api/sessions" && request.Method == http.MethodPost {
		var body state.CreateSessionRequest
		if err := readJSON(request, &body); err != nil {
			s.sendJSON(response, http.StatusBadRequest, map[string]any{"error": err.Error()}, corsOrigin)
			return
		}
		info, err := s.registry.Create(request.Context(), body)
		if err != nil {
			s.sendJSON(response, http.StatusBadRequest, map[string]any{"error": err.Error()}, corsOrigin)
			return
		}
		s.sendJSON(response, http.StatusCreated, info, corsOrigin)
		return
	}

	id, suffix, matched := sessionRoute(path)
	if matched {
		s.handleSessionRoute(response, request, id, suffix, corsOrigin)
		return
	}
	s.sendJSON(response, http.StatusNotFound, map[string]any{"error": "not found", "path": path}, corsOrigin)
}

func (s *Server) authorized(request *http.Request) (bool, error) {
	if isLoopbackPeer(request) {
		return true, nil
	}
	if _, err := os.Stat(s.config.OpenPath); err == nil {
		return true, nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return false, err
	}
	expected, err := s.tokens.token()
	if err != nil {
		return false, err
	}
	authorization := request.Header.Get("Authorization")
	if strings.HasPrefix(authorization, "Bearer ") && tokenEqual(strings.TrimPrefix(authorization, "Bearer "), expected) {
		return true, nil
	}
	provided := request.URL.Query().Get("token")
	return provided != "" && tokenEqual(provided, expected), nil
}

func (s *Server) handleSessionRoute(response http.ResponseWriter, request *http.Request, id, suffix, corsOrigin string) {
	session, ok := s.registry.Get(id)
	if suffix == "" && request.Method == http.MethodDelete {
		if !ok {
			s.sendJSON(response, http.StatusNotFound, map[string]any{"ok": false}, corsOrigin)
			return
		}
		result := session.Kill(request.Context())
		status := http.StatusOK
		if !result {
			status = http.StatusNotFound
		}
		s.sendJSON(response, status, map[string]any{"ok": result}, corsOrigin)
		return
	}
	if suffix == "/snapshot" && request.Method == http.MethodGet {
		if !ok {
			s.sendJSON(response, http.StatusNotFound, map[string]any{"error": "unknown session", "id": id}, corsOrigin)
			return
		}
		cols := int(nonnegativeUint(request.URL.Query().Get("cols")))
		if cols < 0 {
			cols = 0
		}
		text, seq, err := session.Snapshot(request.Context(), cols)
		if err != nil {
			s.sendJSON(response, http.StatusInternalServerError, map[string]any{"error": err.Error()}, corsOrigin)
			return
		}
		response.Header().Set("Content-Type", "text/plain; charset=utf-8")
		response.Header().Set("Vary", "Origin")
		if corsOrigin != "" {
			response.Header().Set("Access-Control-Allow-Origin", corsOrigin)
			response.Header().Set("Access-Control-Expose-Headers", "X-Pretty-Seq")
		}
		response.Header().Set("X-Pretty-Seq", strconv.FormatUint(uint64(seq), 10))
		response.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(response, text)
		return
	}
	if suffix == "/events" && request.Method == http.MethodGet {
		if !ok {
			s.sendJSON(response, http.StatusNotFound, map[string]any{"error": "unknown session", "id": id}, corsOrigin)
			return
		}
		since := queryIndex(request.URL.Query(), "since")
		tail := queryIndex(request.URL.Query(), "tail")
		before := queryIndex(request.URL.Query(), "before")
		window := session.EventsWindow(since, tail, before)
		s.sendJSON(response, http.StatusOK, map[string]any{
			"events": window.Events, "nextIndex": window.NextIndex, "totalCount": window.TotalCount,
			"startIndex": window.StartIndex, "endIndex": window.EndIndex,
		}, corsOrigin)
		return
	}
	if suffix == "/input" && request.Method == http.MethodPost {
		var body struct {
			Data string `json:"data"`
		}
		if err := readJSON(request, &body); err != nil {
			s.sendJSON(response, http.StatusBadRequest, map[string]any{"error": err.Error()}, corsOrigin)
			return
		}
		result := ok && session.Input(request.Context(), body.Data)
		status := http.StatusOK
		if !result {
			status = http.StatusNotFound
		}
		s.sendJSON(response, status, map[string]any{"ok": result}, corsOrigin)
		return
	}
	s.sendJSON(response, http.StatusNotFound, map[string]any{"error": "not found", "path": request.URL.Path}, corsOrigin)
}

func (s *Server) sendJSON(response http.ResponseWriter, status int, body any, corsOrigin string) {
	response.Header().Set("Content-Type", "application/json")
	if corsOrigin != "" {
		response.Header().Set("Access-Control-Allow-Origin", corsOrigin)
	}
	response.Header().Set("Vary", "Origin")
	response.Header().Set("Access-Control-Allow-Methods", "GET,POST,DELETE,OPTIONS")
	response.Header().Set("Access-Control-Allow-Headers", "content-type, authorization")
	response.WriteHeader(status)
	if status == http.StatusNoContent {
		return
	}
	_ = json.NewEncoder(response).Encode(body)
}

func readJSON(request *http.Request, target any) error {
	reader := http.MaxBytesReader(nil, request.Body, maxJSONBody)
	decoder := json.NewDecoder(reader)
	if err := decoder.Decode(target); err != nil {
		if errors.Is(err, io.EOF) {
			return nil
		}
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			return errors.New("request body too large")
		}
		return err
	}
	return nil
}

func sessionRoute(path string) (id, suffix string, ok bool) {
	const prefix = "/api/sessions/"
	if !strings.HasPrefix(path, prefix) {
		return "", "", false
	}
	rest := strings.TrimPrefix(path, prefix)
	parts := strings.SplitN(rest, "/", 2)
	if parts[0] == "" {
		return "", "", false
	}
	decoded, err := url.PathUnescape(parts[0])
	if err != nil {
		return "", "", false
	}
	suffix = ""
	if len(parts) == 2 {
		suffix = "/" + parts[1]
	}
	return decoded, suffix, true
}

func queryIndex(values url.Values, key string) *int64 {
	raw, present := values[key]
	if !present || len(raw) == 0 {
		return nil
	}
	value, err := strconv.ParseFloat(raw[0], 64)
	if err != nil || math.IsNaN(value) || math.IsInf(value, 0) {
		return nil
	}
	integer := int64(value)
	return &integer
}

func isStaticRequest(path, method string) bool {
	return method == http.MethodGet && !strings.HasPrefix(path, "/api/") && path != "/api" && !strings.HasPrefix(path, "/ws")
}

func (s *Server) serveStatic(response http.ResponseWriter, request *http.Request) bool {
	info, err := os.Stat(s.config.WebDir)
	if err != nil || !info.IsDir() {
		return false
	}
	escaped := request.URL.EscapedPath()
	decoded, err := url.PathUnescape(escaped)
	if err != nil {
		s.sendJSON(response, http.StatusBadRequest, map[string]any{"error": "invalid path"}, "")
		return true
	}
	relative := strings.TrimLeft(decoded, "/")
	normalized := filepath.Clean(relative)
	if normalized == "." {
		normalized = ""
	}
	if normalized == ".." || strings.HasPrefix(normalized, ".."+string(filepath.Separator)) || filepath.IsAbs(normalized) {
		s.sendJSON(response, http.StatusBadRequest, map[string]any{"error": "invalid path"}, "")
		return true
	}
	candidate := filepath.Join(s.config.WebDir, normalized)
	resolved, err := filepath.Abs(candidate)
	if err != nil || (resolved != s.config.WebDir && !strings.HasPrefix(resolved, s.config.WebDir+string(filepath.Separator))) {
		s.sendJSON(response, http.StatusBadRequest, map[string]any{"error": "invalid path"}, "")
		return true
	}
	file := readableFile(resolved)
	if file == "" {
		file = readableFile(filepath.Join(s.config.WebDir, "index.html"))
	}
	if file == "" {
		return false
	}
	opened, err := os.Open(file)
	if err != nil {
		return false
	}
	defer opened.Close()
	fileInfo, err := opened.Stat()
	if err != nil {
		return false
	}
	http.ServeContent(response, request, filepath.Base(file), fileInfo.ModTime(), opened)
	return true
}

func readableFile(path string) string {
	info, err := os.Stat(path)
	if err != nil {
		return ""
	}
	if info.Mode().IsRegular() {
		return path
	}
	if info.IsDir() {
		index := filepath.Join(path, "index.html")
		if info, err := os.Stat(index); err == nil && info.Mode().IsRegular() {
			return index
		}
	}
	return ""
}
