package main

import (
	"errors"
	"net"
	"testing"
)

func TestServeStatusHelpers(t *testing.T) {
	status := &serveJSON{Web: map[string]serveWeb{
		"pretty.example.ts.net:443": {Handlers: map[string]serveHandler{
			"/": {Proxy: "http://127.0.0.1:8787"},
		}},
	}}
	if got := endpointFromServeJSON(status, "http://127.0.0.1:8787/"); got != "https://pretty.example.ts.net:443" {
		t.Fatalf("endpoint=%q", got)
	}
	endpoint, proxy := rootHandlerFromServeJSON(status)
	if endpoint != "https://pretty.example.ts.net:443" || proxy != "http://127.0.0.1:8787" {
		t.Fatalf("root endpoint=%q proxy=%q", endpoint, proxy)
	}
	if got := endpointFromServeText("Available on your tailnet:\nhttps://pretty.example.ts.net"); got != "https://pretty.example.ts.net" {
		t.Fatalf("text endpoint=%q", got)
	}
}

func TestRemoteDiagnosticsHelpers(t *testing.T) {
	target, err := formatDaemonTarget("::1", 8787)
	if err != nil || target != "http://[::1]:8787" {
		t.Fatalf("target=%q err=%v", target, err)
	}
	if _, err := formatDaemonTarget("127.0.0.1", 70000); err == nil {
		t.Fatal("invalid port accepted")
	}
	if !isMagicDNSResolutionError(&net.DNSError{Err: "no such host", Name: "pretty.example.ts.net", IsNotFound: true}) {
		t.Fatal("DNS not-found was not classified")
	}
	if isMagicDNSResolutionError(errors.New("TLS certificate expired")) {
		t.Fatal("TLS error misclassified as MagicDNS")
	}
	if got := walkthroughURL("https://pretty.example.ts.net"); got != "https://pretty-pty.somewhere.site/#endpoint=https%3A%2F%2Fpretty.example.ts.net" {
		t.Fatalf("walkthrough URL=%q", got)
	}
}
