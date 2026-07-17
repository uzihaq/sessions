package main

import (
	"fmt"
	"io"
)

func (a *app) cmdToken() error {
	token := a.api.readToken()
	if token == "" {
		fmt.Fprintf(a.stderr, "pretty: no token found at %s\n", a.api.tokenPath)
		io.WriteString(a.stderr, "        start the daemon first (or run: pretty install), then retry.\n")
		return status(1)
	}
	_, err := fmt.Fprintln(a.stdout, token)
	return err
}
