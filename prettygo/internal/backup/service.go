package backup

import (
	"context"
	"errors"
	"log"
	"os"
	"sync"
	"time"

	"github.com/uzihaq/pretty-pty/prettygo/internal/state"
)

type Service struct {
	pusher   *Pusher
	sessions func() []state.SessionInfo

	pushMu     sync.Mutex
	periodicMu sync.Mutex
	stop       chan struct{}
}

func NewService(options Options, sessions func() []state.SessionInfo) *Service {
	return &Service{pusher: NewPusher(options), sessions: sessions}
}

func (s *Service) Push(ctx context.Context) (Result, error) {
	s.pushMu.Lock()
	defer s.pushMu.Unlock()
	var sessions []state.SessionInfo
	if s.sessions != nil {
		sessions = s.sessions()
	}
	return s.pusher.Push(ctx, sessions)
}

func (s *Service) Status() (Status, error) {
	config, err := LoadConfig(s.pusher.options.ConfigPath)
	if errors.Is(err, os.ErrNotExist) {
		return Status{}, nil
	}
	if err != nil {
		return Status{}, err
	}
	return config.Status(), nil
}

// ReloadPeriodic applies the current enable flag and interval. It is called at
// daemon construction and after `pretty backup enable`; no goroutine runs for
// a disabled or absent configuration.
func (s *Service) ReloadPeriodic() error {
	config, err := LoadConfig(s.pusher.options.ConfigPath)
	if errors.Is(err, os.ErrNotExist) {
		s.stopPeriodic()
		return nil
	}
	if err != nil {
		return err
	}
	s.stopPeriodic()
	if !config.Enabled {
		return nil
	}
	interval, err := config.interval()
	if err != nil {
		return err
	}
	stop := make(chan struct{})
	s.periodicMu.Lock()
	s.stop = stop
	s.periodicMu.Unlock()
	go func() {
		ticker := time.NewTicker(interval)
		defer ticker.Stop()
		for {
			select {
			case <-ticker.C:
				if _, err := s.Push(context.Background()); err != nil {
					log.Printf("periodic session backup: %v", err)
				}
			case <-stop:
				return
			}
		}
	}()
	return nil
}

func (s *Service) Close() {
	s.stopPeriodic()
}

func (s *Service) stopPeriodic() {
	s.periodicMu.Lock()
	defer s.periodicMu.Unlock()
	if s.stop != nil {
		close(s.stop)
		s.stop = nil
	}
}
