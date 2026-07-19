package main

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/uzihaq/pretty-pty/prettygo/internal/api"
	"github.com/uzihaq/pretty-pty/prettygo/internal/ledger"
	"github.com/uzihaq/pretty-pty/prettygo/internal/session"
	"github.com/uzihaq/pretty-pty/prettygo/internal/state"
)

var anyHosts = map[string]struct{}{"0.0.0.0": {}, "::": {}, "::0": {}, "*": {}}

func main() {
	config, err := state.ConfigFromEnv()
	if err != nil {
		log.Fatal(err)
	}
	if _, refused := anyHosts[config.Host]; refused {
		fmt.Fprintf(os.Stderr,
			"\n  prettyd: refusing to bind to %s.\n  Set PRETTYD_HOST to a specific address — 127.0.0.1 for loopback only,\n  or a tailnet IP (100.x.y.z) for access from other devices on your tailnet.\n\n",
			config.Host,
		)
		os.Exit(2)
	}
	if os.Getenv("PRETTYD_SMOKE") == "1" {
		return
	}

	ledgerStore, err := ledger.Open(context.Background(), ledger.Options{})
	if err != nil {
		log.Fatalf("open lane ledger: %v", err)
	}
	defer func() {
		if err := ledgerStore.Close(); err != nil {
			log.Printf("close lane ledger: %v", err)
		}
	}()
	manager := session.NewManager(config, state.NewLaunchdLauncher(config), session.ManagerOptions{
		Boundaries: ledgerStore.Boundaries(), Observations: ledgerStore.Observations(), LedgerReader: ledgerStore,
	})
	defer manager.Close()
	handler := api.New(config, manager, manager.Push())
	handler.RestoreLAN(log.Printf)
	defer func() {
		if err := handler.CloseLAN(); err != nil {
			log.Printf("close LAN listener: %v", err)
		}
	}()
	server := &http.Server{
		Addr: config.ListenAddress(), Handler: handler,
		ReadHeaderTimeout: 65 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	go manager.RunDiscoveryLoop()
	go func() {
		log.Printf("prettyd listening on http://%s", config.ListenAddress())
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("prettyd: server error: %v", err)
		}
	}()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	sig := <-stop
	log.Printf("prettyd: %s received, shutting down", sig)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		log.Printf("prettyd shutdown: %v", err)
	}
}
