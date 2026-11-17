package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// The upstream here is a TLS WebSocket echo server standing in for a host's WebMKS endpoint.
// These tests prove the gateway's rules, not compatibility with VMware's console protocol.

type memStore struct {
	mu       sync.Mutex
	sessions map[string]*Session
	events   []map[string]any
	revoke   chan Revocation
	marks    map[string]int64 // the API's revocation markers: "user:<id>", "auth:<hash>", "all" -> Unix milliseconds
	broken   bool             // the store cannot be asked about markers
}

func (m *memStore) Consume(_ context.Context, key string) (*Session, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	s := m.sessions[key]
	delete(m.sessions, key)
	if s != nil {
		s.Key = key
	}
	return s, nil
}
func (m *memStore) Active(context.Context, *Session, time.Time) error { return nil }
func (m *memStore) Inactive(context.Context, *Session) error          { return nil }
func (m *memStore) Event(_ context.Context, f map[string]any) {
	m.mu.Lock()
	m.events = append(m.events, f)
	m.mu.Unlock()
}
func (m *memStore) Revocations(context.Context) <-chan Revocation { return m.revoke }

func (m *memStore) Revoked(_ context.Context, s *Session) (bool, error) {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.broken {
		return false, errors.New("redis unavailable")
	}
	for _, k := range []string{"all", "user:" + s.UserID, "auth:" + s.AuthHash} {
		if at, ok := m.marks[k]; ok && at >= s.IssuedAt {
			return true, nil
		}
	}
	return false, nil
}

func upstream(t *testing.T) (*httptest.Server, string) {
	srv := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"binary"}})
		if err != nil {
			return
		}
		defer c.CloseNow()
		_ = c.Write(r.Context(), websocket.MessageText, []byte("hello from vm"))
		for {
			typ, data, err := c.Read(r.Context())
			if err != nil || c.Write(r.Context(), typ, data) != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	sum := sha256.Sum256(srv.Certificate().Raw)
	return srv, hex.EncodeToString(sum[:])
}

func setup(t *testing.T) (*Gateway, *memStore, *httptest.Server) {
	store := &memStore{sessions: map[string]*Session{}, revoke: make(chan Revocation)}
	g := &Gateway{store: store, guard: &netGuard{allow: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}},
		allowedOrigins: map[string]bool{}, active: map[*conn]struct{}{}, maxPerUser: 1, maxTotal: 10, maxDuration: time.Minute}
	go g.revocationLoop(context.Background())
	front := httptest.NewServer(g)
	t.Cleanup(front.Close)
	return g, store, front
}

func addSession(store *memStore, token string, s Session) {
	store.mu.Lock()
	store.sessions[sessionKey(token)] = &s
	store.mu.Unlock()
}

func dial(t *testing.T, front *httptest.Server, origin, token string) (*websocket.Conn, *http.Response, error) {
	h := http.Header{}
	if origin != "" {
		h.Set("Origin", origin)
	}
	if token != "" {
		h.Set("Cookie", cookieName+"="+token)
	}
	ws := strings.Replace(front.URL, "http", "ws", 1) + "/console/ws"
	return websocket.Dial(context.Background(), ws, &websocket.DialOptions{HTTPHeader: h, Subprotocols: []string{"binary"}})
}

func closeCode(t *testing.T, c *websocket.Conn) (websocket.StatusCode, string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for {
		if _, _, err := c.Read(ctx); err != nil {
			var ce websocket.CloseError
			if ok := asClose(err, &ce); ok {
				return ce.Code, ce.Reason
			}
			t.Fatalf("expected close frame, got %v", err)
		}
	}
}

func asClose(err error, ce *websocket.CloseError) bool { return errors.As(err, ce) }

const token = "0123456789abcdef0123456789abcdef0123456789"

func TestCrossOriginIsRefusedBeforeUpgrade(t *testing.T) {
	_, _, front := setup(t)
	_, res, err := dial(t, front, "https://evil.example", token)
	if err == nil || res == nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("want 403 for a foreign origin, got %v %v", res, err)
	}
	if _, res, _ := dial(t, front, "", token); res == nil || res.StatusCode != http.StatusForbidden {
		t.Fatal("a missing Origin must be refused too")
	}
}

// An https panel (TLS ends at the proxy, which says so) is not opened from an http page on the same host name.
func TestHTTPSPanelRefusesAnHTTPOrigin(t *testing.T) {
	_, _, front := setup(t)
	ws := strings.Replace(front.URL, "http", "ws", 1) + "/console/ws"
	try := func(origin string) (*websocket.Conn, *http.Response, error) {
		h := http.Header{"Origin": {origin}, "Cookie": {cookieName + "=" + token}, "X-Forwarded-Proto": {"https"}}
		return websocket.Dial(context.Background(), ws, &websocket.DialOptions{HTTPHeader: h, Subprotocols: []string{"binary"}})
	}
	if _, res, err := try(front.URL); err == nil || res == nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("want 403 for an http origin on an https panel, got %v %v", res, err)
	}
	c, _, err := try(strings.Replace(front.URL, "http://", "https://", 1))
	if err != nil {
		t.Fatalf("the https origin of the same host must pass: %v", err)
	}
	if code, _ := closeCode(t, c); code != closeSession {
		t.Fatalf("got %d", code)
	}
}

// CONSOLE_ALLOWED_ORIGINS: a configured origin passes both checks (ours and the one in websocket.Accept); its
// http twin does not.
func TestConfiguredOriginIsAccepted(t *testing.T) {
	g, _, front := setup(t)
	origin, host, ok := originOf("https://Panel.Example/")
	if !ok || origin != "https://panel.example" {
		t.Fatalf("originOf: %q %v", origin, ok)
	}
	g.allowedOrigins, g.originHosts = map[string]bool{origin: true}, []string{originPattern(host)}
	c, _, err := dial(t, front, "https://panel.example", token)
	if err != nil {
		t.Fatalf("configured origin refused: %v", err)
	}
	if code, _ := closeCode(t, c); code != closeSession {
		t.Fatalf("got %d", code)
	}
	if _, res, err := dial(t, front, "http://panel.example", token); err == nil || res == nil || res.StatusCode != http.StatusForbidden {
		t.Fatalf("want 403 for the http twin, got %v %v", res, err)
	}
	if p := originPattern("[::1]:3000"); p != `\[::1]:3000` {
		t.Fatalf("pattern %q", p)
	}
}

// Junk tickets come from anyone: many of them leave a bounded number of audit events, and the first event of
// the next minute says how many were left out.
func TestUnknownTicketsAreAuditedAtABoundedRate(t *testing.T) {
	g, store, front := setup(t)
	var mu sync.Mutex
	now := time.Now()
	g.denied.now = func() time.Time { mu.Lock(); defer mu.Unlock(); return now }
	const n = 40
	junk := func(i int) {
		c, _, err := dial(t, front, front.URL, fmt.Sprintf("%s-junk-%04d", token, i))
		if err != nil {
			t.Fatal(err)
		}
		if code, reason := closeCode(t, c); code != closeSession || reason != "CONSOLE_SESSION_INVALID" {
			t.Fatalf("got %d %q", code, reason)
		}
	}
	for i := 0; i < n; i++ {
		junk(i)
	}
	store.mu.Lock()
	events := len(store.events)
	store.mu.Unlock()
	if events != deniedPerMinute {
		t.Fatalf("%d junk tickets wrote %d audit events, want %d", n, events, deniedPerMinute)
	}
	mu.Lock()
	now = now.Add(time.Minute)
	mu.Unlock()
	junk(n)
	store.mu.Lock()
	defer store.mu.Unlock()
	last := store.events[len(store.events)-1]
	if len(store.events) != deniedPerMinute+1 || last["event"] != "denied" || last["suppressed"] != int64(n-deniedPerMinute) {
		t.Fatalf("after a minute: %d events, last %v", len(store.events), last)
	}
}

// Without a cookie that can be a ticket there is no upgrade and nothing is written to the audit log.
func TestMissingCookieIsRefusedWithoutEvent(t *testing.T) {
	_, store, front := setup(t)
	for _, tok := range []string{"", "too-short"} {
		if _, res, err := dial(t, front, front.URL, tok); err == nil || res == nil || res.StatusCode != http.StatusUnauthorized {
			t.Fatalf("want 401 for cookie %q, got %v %v", tok, res, err)
		}
	}
	store.mu.Lock()
	defer store.mu.Unlock()
	if len(store.events) != 0 {
		t.Fatalf("anonymous requests must not be audited, got %v", store.events)
	}
}

func TestUnknownSessionIsClosed(t *testing.T) {
	_, _, front := setup(t)
	c, _, err := dial(t, front, front.URL, token)
	if err != nil {
		t.Fatal(err)
	}
	if code, reason := closeCode(t, c); code != closeSession || reason != "CONSOLE_SESSION_INVALID" {
		t.Fatalf("got %d %q", code, reason)
	}
}

func TestRelayAndSingleUse(t *testing.T) {
	_, store, front := setup(t)
	up, pin := upstream(t)
	addSession(store, token, Session{URL: strings.Replace(up.URL, "https", "wss", 1) + "/ticket/x", SHA256: []string{pin}, UserID: "u1", VM: "vm-1"})
	c, _, err := dial(t, front, front.URL, token)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, msg, err := c.Read(ctx); err != nil || string(msg) != "hello from vm" {
		t.Fatalf("greeting not relayed: %q %v", msg, err)
	}
	_ = c.Write(ctx, websocket.MessageBinary, []byte{1, 2, 3})
	if typ, msg, err := c.Read(ctx); err != nil || typ != websocket.MessageBinary || string(msg) != "\x01\x02\x03" {
		t.Fatalf("binary frame not relayed: %v %v", msg, err)
	}
	c.Close(websocket.StatusNormalClosure, "")

	again, _, err := dial(t, front, front.URL, token)
	if err != nil {
		t.Fatal(err)
	}
	if code, _ := closeCode(t, again); code != closeSession {
		t.Fatalf("a used session must not work twice, got %d", code)
	}
}

func TestWrongThumbprintIsRefused(t *testing.T) {
	_, store, front := setup(t)
	up, _ := upstream(t)
	addSession(store, token, Session{URL: strings.Replace(up.URL, "https", "wss", 1) + "/ticket/x", SHA256: []string{strings.Repeat("0", 64)}, UserID: "u1"})
	c, _, err := dial(t, front, front.URL, token)
	if err != nil {
		t.Fatal(err)
	}
	if code, reason := closeCode(t, c); code != closeTLS || reason != "CONSOLE_TLS_MISMATCH" {
		t.Fatalf("got %d %q", code, reason)
	}
}

func TestBlockedUpstream(t *testing.T) {
	g, store, front := setup(t)
	g.guard = &netGuard{} // production default: loopback is not a valid ESXi host
	up, pin := upstream(t)
	addSession(store, token, Session{URL: strings.Replace(up.URL, "https", "wss", 1) + "/ticket/x", SHA256: []string{pin}, UserID: "u1"})
	c, _, _ := dial(t, front, front.URL, token)
	if code, reason := closeCode(t, c); code != closeUpstream || reason != "CONSOLE_ENDPOINT_BLOCKED" {
		t.Fatalf("got %d %q", code, reason)
	}
}

// A ticket URL that is not wss:// would skip the address guard and the certificate pin.
func TestPlainWebSocketTicketIsRefused(t *testing.T) {
	_, store, front := setup(t)
	up, pin := upstream(t)
	addSession(store, token, Session{URL: strings.Replace(up.URL, "https", "ws", 1) + "/ticket/x", SHA256: []string{pin}, UserID: "u1"})
	c, _, err := dial(t, front, front.URL, token)
	if err != nil {
		t.Fatal(err)
	}
	if code, reason := closeCode(t, c); code != closeUpstream || reason != "CONSOLE_ENDPOINT_BLOCKED" {
		t.Fatalf("got %d %q", code, reason)
	}
}

// Sessions opened at the same moment are counted one by one: only as many open as the limit allows.
func TestParallelOpensStayWithinTheLimit(t *testing.T) {
	g, store, front := setup(t) // one console per user
	up, pin := upstream(t)
	url := strings.Replace(up.URL, "https", "wss", 1) + "/ticket/x"
	type result struct {
		c    *websocket.Conn
		open bool
	}
	const n = 6
	results := make(chan result, n)
	for i := 0; i < n; i++ {
		tok := token + "-" + string(rune('a'+i))
		addSession(store, tok, Session{URL: url, SHA256: []string{pin}, UserID: "u1"})
		go func() {
			c, _, err := dial(t, front, front.URL, tok)
			if err != nil {
				results <- result{}
				return
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, _, err = c.Read(ctx) // the greeting, or the close frame of a refused session
			results <- result{c, err == nil}
		}()
	}
	// Every connection stays open until all have answered: a slot freed early could be taken again fairly.
	open := 0
	var conns []*websocket.Conn
	for i := 0; i < n; i++ {
		r := <-results
		if r.open {
			open++
		}
		if r.c != nil {
			conns = append(conns, r.c)
		}
	}
	for _, c := range conns {
		c.CloseNow()
	}
	if open != 1 {
		t.Fatalf("want exactly 1 console for the user, got %d of %d", open, n)
	}
	// A refused or failed session leaves no slot behind.
	deadline := time.Now().Add(3 * time.Second)
	for {
		g.mu.Lock()
		left := len(g.active)
		g.mu.Unlock()
		if left == 0 {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d slots still taken after every console closed", left)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

func TestPerUserLimitAndRevocation(t *testing.T) {
	_, store, front := setup(t)
	up, pin := upstream(t)
	url := strings.Replace(up.URL, "https", "wss", 1) + "/ticket/x"
	addSession(store, token, Session{URL: url, SHA256: []string{pin}, UserID: "u1", AuthHash: "auth-1"})
	second := token + "-second"
	addSession(store, second, Session{URL: url, SHA256: []string{pin}, UserID: "u1", AuthHash: "auth-1"})

	first, _, err := dial(t, front, front.URL, token)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, _, err := first.Read(ctx); err != nil { // greeting: the console is live
		t.Fatal(err)
	}
	c2, _, _ := dial(t, front, front.URL, second)
	if code, reason := closeCode(t, c2); code != closeTooMany || reason != "CONSOLE_LIMIT" {
		t.Fatalf("limit: got %d %q", code, reason)
	}
	store.revoke <- Revocation{AuthHash: "auth-1"} // e.g. the user signed out
	if code, reason := closeCode(t, first); code != closeRevoked || reason != "CONSOLE_REVOKED" {
		t.Fatalf("revocation: got %d %q", code, reason)
	}
	// The closed event is written after the browser already saw the close frame; wait for it.
	deadline := time.Now().Add(3 * time.Second)
	for {
		store.mu.Lock()
		var opened, closed bool
		for _, e := range store.events {
			opened = opened || e["event"] == "opened"
			closed = closed || (e["event"] == "closed" && e["reason"] == "CONSOLE_REVOKED")
		}
		events := len(store.events)
		store.mu.Unlock()
		if opened && closed {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("audit events missing (%d events)", events)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A ticket is issued up to a minute before it is presented. A revocation in that minute (the server was handed to
// another account, a sign-out, a ban, a role taken away) reaches no live session, so the gateway refuses the ticket
// itself: by the revocations it heard, and by the markers the API leaves in Redis. A ticket asked for after the
// revocation, and one of somebody else, open as before.
func TestPendingTicketIsRefusedAfterRevocation(t *testing.T) {
	g, store, front := setup(t)
	up, pin := upstream(t)
	url := strings.Replace(up.URL, "https", "wss", 1) + "/ticket/x"
	before := time.Now().Add(-time.Second).UnixMilli()
	after := time.Now().Add(time.Minute).UnixMilli()
	ticket := func(user, auth string, issuedAt int64) Session {
		return Session{URL: url, SHA256: []string{pin}, UserID: user, AuthHash: auth, VM: "vm-9", IssuedAt: issuedAt}
	}
	refused := func(name string, s Session) {
		t.Helper()
		tok := token + "-" + name
		addSession(store, tok, s)
		c, _, err := dial(t, front, front.URL, tok)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		if code, reason := closeCode(t, c); code != closeRevoked || reason != "CONSOLE_REVOKED" {
			t.Fatalf("%s: want the ticket refused as revoked, got %d %q", name, code, reason)
		}
	}
	opens := func(name string, s Session) {
		t.Helper()
		tok := token + "-" + name
		addSession(store, tok, s)
		c, _, err := dial(t, front, front.URL, tok)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, msg, err := c.Read(ctx); err != nil || string(msg) != "hello from vm" {
			t.Fatalf("%s: the console did not open: %q %v", name, msg, err)
		}
		c.Close(websocket.StatusNormalClosure, "")
	}

	// Heard on the channel. The loop takes one message at a time: once the third is taken, the first two are applied.
	store.revoke <- Revocation{UserID: "prev-owner"} // a hand-over
	store.revoke <- Revocation{AuthHash: "auth-out"} // a sign-out
	store.revoke <- Revocation{UserID: "nobody"}
	refused("by-user", ticket("prev-owner", "auth-prev", before))
	refused("by-session", ticket("u2", "auth-out", before))
	refused("no-time", ticket("prev-owner", "auth-prev", 0)) // an older API wrote no time: before any revocation
	opens("asked-later", ticket("prev-owner", "auth-prev", after))
	opens("someone-else", ticket("u3", "auth-3", before))

	// Not heard (the gateway was restarting): the API's markers say the same.
	now := time.Now().UnixMilli()
	store.mu.Lock()
	store.marks = map[string]int64{"user:banned": now, "auth:auth-gone": now}
	store.mu.Unlock()
	refused("marked-user", ticket("banned", "auth-4", before))
	refused("marked-session", ticket("u5", "auth-gone", before))
	opens("marked-but-later", ticket("banned", "auth-4", after))
	store.mu.Lock()
	store.marks = map[string]int64{"all": now}
	store.mu.Unlock()
	refused("marked-all", ticket("u6", "auth-6", before))

	// Markers that cannot be read: refused rather than opened unchecked.
	store.mu.Lock()
	store.marks, store.broken = nil, true
	store.mu.Unlock()
	refused("store-down", ticket("u7", "auth-7", before))

	// Each refusal is audited with its account, and none of them keeps a slot.
	store.mu.Lock()
	denied := 0
	for _, e := range store.events {
		if e["event"] == "denied" && e["reason"] == "CONSOLE_REVOKED" && e["userId"] != "" {
			denied++
		}
	}
	store.mu.Unlock()
	if denied != 7 {
		t.Fatalf("want 7 audited refusals, got %d", denied)
	}
	deadline := time.Now().Add(3 * time.Second)
	for {
		g.mu.Lock()
		left := len(g.active)
		g.mu.Unlock()
		if left == 0 {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("%d slots still taken", left)
		}
		time.Sleep(20 * time.Millisecond)
	}
}

// A revocation is forgotten once no ticket issued before it can still be presented.
func TestHeardRevocationsAreForgotten(t *testing.T) {
	g := &Gateway{active: map[*conn]struct{}{}}
	g.heard = []heardRevocation{{rev: Revocation{UserID: "old"}, at: time.Now().Add(-2 * revocationMemory)}}
	g.revoke(Revocation{UserID: "new"})
	g.revoke(Revocation{SessionKey: "one-live-session"}) // names a live session only: nothing to remember
	if len(g.heard) != 1 || g.heard[0].rev.UserID != "new" {
		t.Fatalf("remembered %v", g.heard)
	}
}
