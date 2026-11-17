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

func TestTerminalWithoutCookieIsRefusedWithoutEvent(t *testing.T) {
	store, front := terminalSetup(t, time.Minute)
	if _, res, err := dialTerminal(front, ""); err == nil || res == nil || res.StatusCode != http.StatusUnauthorized {
		t.Fatalf("want 401 without a ticket, got %v %v", res, err)
	}
	if names := store.eventNames(); names != "" {
		t.Fatalf("anonymous requests must not be audited, got %q", names)
	}
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

func TestTerminalUnknownTicketsAreAuditedAtABoundedRate(t *testing.T) {
	store, front := terminalSetup(t, time.Minute)
	for i := 0; i < 20; i++ {
		c, _, err := dialTerminal(front, token+"-junk-"+string(rune('a'+i)))
		if err != nil {
			t.Fatal(err)
		}
		if code, reason := closeCode(t, c); code != closeSession || reason != "TERMINAL_SESSION_INVALID" {
			t.Fatalf("got %d %q", code, reason)
		}
	}
	if names := store.eventNames(); strings.Count(names, "terminal_denied") != deniedPerMinute || strings.Count(names, ",") != deniedPerMinute-1 {
		t.Fatalf("20 junk tickets wrote %q", names)
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

// An interactive bash writes its prompt, line editing and errors to stderr: the host shell must not silence it.
func TestHostShellKeepsStderr(t *testing.T) {
	t.Setenv("TERMINAL_SHELL", "")
	argv := hostShell()
	script := argv[len(argv)-1]
	if !strings.Contains(script, "exec bash -l") || strings.Contains(script, "bash -l 2>") {
		t.Fatalf("host shell script %q hides bash's stderr", script)
	}
}

// A terminal ticket issued before the administrator's session was revoked (a role taken away, a sign-out) starts no
// shell afterwards; one asked for after it does.
func TestTerminalPendingTicketIsRefusedAfterRevocation(t *testing.T) {
	store, front := terminalSetup(t, time.Minute)
	store.revoke <- Revocation{AuthHash: "auth-admin"}
	store.revoke <- Revocation{UserID: "nobody"} // taken once the first is applied
	addSession(store, token, Session{UserID: "admin-1", AuthHash: "auth-admin", VM: "host", IssuedAt: time.Now().Add(-time.Second).UnixMilli()})
	c, _, err := dialTerminal(front, token)
	if err != nil {
		t.Fatal(err)
	}
	if code, reason := closeCode(t, c); code != closeRevoked || reason != "TERMINAL_REVOKED" {
		t.Fatalf("want the ticket refused as revoked, got %d %q", code, reason)
	}
	if names := store.eventNames(); names != "terminal_denied" {
		t.Fatalf("events: %q (no shell may have been opened)", names)
	}

	later := token + "-later"
	addSession(store, later, Session{UserID: "admin-1", AuthHash: "auth-admin", VM: "host", IssuedAt: time.Now().Add(time.Minute).UnixMilli()})
	again, _, err := dialTerminal(front, later)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	_ = again.Write(ctx, websocket.MessageBinary, []byte("after-revocation\n"))
	var got strings.Builder
	for !strings.Contains(got.String(), "after-revocation") {
		_, data, err := again.Read(ctx)
		if err != nil {
			t.Fatalf("no echo: %v (got %q)", err, got.String())
		}
		got.Write(data)
	}
	again.Close(websocket.StatusNormalClosure, "")
}
