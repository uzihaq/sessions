package main

import "testing"

func TestCodexInterruptInputDoesNotConfuseBracketedPaste(t *testing.T) {
	for _, value := range []string{"\x1b", "\x03"} {
		if !isCodexInterruptInput(value) {
			t.Fatalf("%q was not recognized as an interrupt", value)
		}
	}
	for _, value := range []string{
		"",
		"hello",
		"\r",
		"\x1b[200~hello\x1b[201~",
		"\x1b[A",
	} {
		if isCodexInterruptInput(value) {
			t.Fatalf("%q was incorrectly recognized as an interrupt", value)
		}
	}
}
