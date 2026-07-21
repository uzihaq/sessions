package api

import (
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	lanutil "github.com/uzihaq/sessions/runtime/internal/lan"
	"github.com/uzihaq/sessions/runtime/internal/state"
)

type LANState struct {
	Enabled bool    `json:"enabled"`
	URL     *string `json:"url"`
}

type lanListener struct {
	mu           sync.Mutex
	config       state.Config
	handler      http.Handler
	pickIP       func() (net.IP, error)
	listen       func(string, string) (net.Listener, error)
	settingsPath string
	server       *http.Server
	host         string
	url          string
}

func newLANListener(config state.Config, handler http.Handler) *lanListener {
	settingsPath := config.SettingsPath
	if settingsPath == "" {
		root := config.UserStateRoot
		if root == "" {
			root = config.StateRoot
		}
		settingsPath = filepath.Join(root, "settings.json")
	}
	return &lanListener{
		config: config, handler: handler, pickIP: lanutil.PrimaryIPv4,
		listen: net.Listen, settingsPath: settingsPath,
	}
}

func (l *lanListener) state() LANState {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.stateLocked()
}

func (l *lanListener) stateLocked() LANState {
	if l.server == nil || l.url == "" {
		return LANState{}
	}
	url := l.url
	return LANState{Enabled: true, URL: &url}
}

func (l *lanListener) activeHost() string {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.host
}

func (l *lanListener) enable(persist bool) (LANState, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	ip, err := l.pickIP()
	if err != nil {
		return l.stateLocked(), err
	}
	host := ip.String()
	if l.server != nil && l.host == host {
		if persist {
			if err := l.persistEnabled(true); err != nil {
				return l.stateLocked(), err
			}
		}
		return l.stateLocked(), nil
	}

	address := net.JoinHostPort(host, strconv.Itoa(l.config.Port))
	listener, err := l.listen("tcp", address)
	if err != nil {
		return l.stateLocked(), fmt.Errorf("could not open the LAN listener at %s: %w; make sure this Mac is still on the network that owns %s and port %d is free, then retry `sessions lan enable`", address, err, host, l.config.Port)
	}
	actualAddress, ok := listener.Addr().(*net.TCPAddr)
	if ok {
		address = net.JoinHostPort(host, strconv.Itoa(actualAddress.Port))
	}
	url := "http://" + address
	if persist {
		if err := l.persistEnabled(true); err != nil {
			_ = listener.Close()
			return l.stateLocked(), err
		}
	}

	server := &http.Server{
		Handler: l.handler, ReadHeaderTimeout: 65 * time.Second, IdleTimeout: 60 * time.Second,
	}
	previous := l.server
	l.server = server
	l.host = host
	l.url = url
	go func() {
		if err := server.Serve(listener); err != nil && !errors.Is(err, http.ErrServerClosed) && !errors.Is(err, net.ErrClosed) {
			log.Printf("sessionsd: LAN listener error: %v", err)
			l.mu.Lock()
			if l.server == server {
				l.server = nil
				l.host = ""
				l.url = ""
			}
			l.mu.Unlock()
		}
	}()
	if previous != nil {
		_ = previous.Close()
	}
	return l.stateLocked(), nil
}

func (l *lanListener) disable(persist bool) (LANState, error) {
	l.mu.Lock()
	if persist {
		if err := l.persistEnabled(false); err != nil {
			state := l.stateLocked()
			l.mu.Unlock()
			return state, err
		}
	}
	server := l.server
	l.server = nil
	l.host = ""
	l.url = ""
	l.mu.Unlock()
	if server != nil {
		if err := server.Close(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			return LANState{}, fmt.Errorf("close LAN listener: %w", err)
		}
	}
	return LANState{}, nil
}

func (l *lanListener) persistEnabled(enabled bool) error {
	return state.UpdateSettings(l.settingsPath, func(settings *state.Settings) error {
		settings.LAN = enabled
		return nil
	})
}

func (s *Server) RestoreLAN(logf func(string, ...any)) {
	settings, err := state.LoadSettings(s.lan.settingsPath)
	if err != nil {
		logf("sessionsd: could not load LAN setting: %v; continuing without LAN access", err)
		return
	}
	if !settings.LAN {
		return
	}
	current, err := s.lan.enable(false)
	if err != nil {
		logf("sessionsd: LAN access is enabled in settings but could not start: %v; continuing without LAN access", err)
		return
	}
	logf("sessionsd: LAN access listening on %s", *current.URL)
}

func (s *Server) CloseLAN() error {
	_, err := s.lan.disable(false)
	return err
}

func (s *Server) handleLANRoute(response http.ResponseWriter, request *http.Request, corsOrigin string) bool {
	if request.URL.Path != "/api/lan" {
		return false
	}
	switch request.Method {
	case http.MethodGet:
		s.sendJSON(response, http.StatusOK, s.lan.state(), corsOrigin)
	case http.MethodPost:
		var body struct {
			Enabled *bool `json:"enabled"`
		}
		if err := readJSON(request, &body); err != nil {
			s.sendJSON(response, http.StatusBadRequest, map[string]any{"error": err.Error()}, corsOrigin)
			return true
		}
		if body.Enabled == nil {
			s.sendJSON(response, http.StatusBadRequest, map[string]any{"error": "enabled must be true or false"}, corsOrigin)
			return true
		}
		var (
			current LANState
			err     error
		)
		if *body.Enabled {
			current, err = s.lan.enable(true)
		} else {
			current, err = s.lan.disable(true)
		}
		if err != nil {
			s.sendJSON(response, http.StatusConflict, map[string]any{"error": err.Error()}, corsOrigin)
			return true
		}
		s.sendJSON(response, http.StatusOK, current, corsOrigin)
	default:
		s.sendJSON(response, http.StatusMethodNotAllowed, map[string]any{"error": "method not allowed"}, corsOrigin)
	}
	return true
}
