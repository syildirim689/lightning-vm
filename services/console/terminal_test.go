package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// The real shell is the host's (nsenter into PID 1); these tests run "cat" instead to prove the gateway's rules:
// one-time ticket, input reaches the shell and its output comes back, resize frames, idle close.
func terminalSetup(t *testing.T, idle time.Duration) (*memStore, *httptest.Server) {
	t.Setenv("TERMINAL_SHELL", "exec cat")
	store := &memStore{sessions: map[string]*Session{}, revoke: make(chan Revocation)}
	g := &Gateway{store: store, guard: &netGuard{allow: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}},
		allowedOrigins: map[string]bool{}, active: map[*conn]struct{}{}, maxPerUser: 1, maxTotal: 3, maxDuration: time.Minute, idle: idle}
	go g.revocationLoop(context.Background())
	mux := http.NewServeMux()
	mux.HandleFunc("GET /terminal/ws", g.serveTerminal)
	front := httptest.NewServer(mux)
	t.Cleanup(front.Close)
	return store, front
}

func dialTerminal(front *httptest.Server, tok string) (*websocket.Conn, *http.Response, error) {
	h := http.Header{"Origin": {front.URL}, "Cookie": {terminalCookie + "=" + tok}}
	return websocket.Dial(context.Background(), strings.Replace(front.URL, "http", "ws", 1)+"/terminal/ws", &websocket.DialOptions{HTTPHeader: h})
}

func TestTerminalEchoesThroughTheShellOnce(t *testing.T) {
	store, front := terminalSetup(t, time.Minute)
	addSession(store, token, Session{UserID: "admin-1", VM: "host"})
	c, _, err := dialTerminal(front, token)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = c.Write(ctx, websocket.MessageText, []byte(`{"type":"resize","cols":120,"rows":40}`))
	_ = c.Write(ctx, websocket.MessageBinary, []byte("hello-terminal\n"))
	var got strings.Builder
	for !strings.Contains(got.String(), "hello-terminal") {
		_, data, err := c.Read(ctx)
		if err != nil {
			t.Fatalf("no echo: %v (got %q)", err, got.String())
		}
		got.Write(data)
	}
	c.Close(websocket.StatusNormalClosure, "")
	// The ticket was used up: the same cookie opens nothing.
	again, _, err := dialTerminal(front, token)
	if err != nil {
		t.Fatal(err)
	}
	if code, reason := closeCode(t, again); code != closeSession || reason != "TERMINAL_SESSION_INVALID" {
		t.Fatalf("reused ticket: %d %q", code, reason)
	}
	events := store.eventNames()
	if !strings.Contains(events, "terminal_opened") || !strings.Contains(events, "terminal_denied") {
		t.Fatalf("events: %s", events)
	}
}

func TestTerminalClosesWhenIdle(t *testing.T) {
	store, front := terminalSetup(t, time.Millisecond)
	addSession(store, token, Session{UserID: "admin-1", VM: "host"})
	c, _, err := dialTerminal(front, token)
	if err != nil {
		t.Fatal(err)
	}
	// The idle check runs every 15 s; give it one round.
	ctx, cancel := context.WithTimeout(context.Background(), 25*time.Second)
	defer cancel()
	for {
		if _, _, err := c.Read(ctx); err != nil {
			if websocket.CloseStatus(err) != closeExpired {
				t.Fatalf("want idle close %d, got %v", closeExpired, err)
			}
			return
		}
	}
}

func (m *memStore) eventNames() string {
	m.mu.Lock()
	defer m.mu.Unlock()
	var names []string
	for _, e := range m.events {
		names = append(names, e["event"].(string))
	}
	return strings.Join(names, ",")
}
