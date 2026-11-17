package main

import (
	"context"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Session is written by the API (single use, short TTL) and consumed here. It holds the VMware
// ticket URL, which therefore never reaches the browser, a URL or a log line.
type Session struct {
	Key          string   `json:"-"`
	URL          string   `json:"url"`
	SHA1         string   `json:"sha1"`
	SHA256       []string `json:"sha256"`
	CertPEM      string   `json:"certPem"`
	UserID       string   `json:"userId"`
	AuthHash     string   `json:"authHash"`
	VM           string   `json:"vm"`
	VMName       string   `json:"vmName"`
	ConnectionID string   `json:"connectionId"`
}

type Revocation struct {
	SessionKey string `json:"sessionKey,omitempty"`
	UserID     string `json:"userId,omitempty"`
	AuthHash   string `json:"authHash,omitempty"`
	All        bool   `json:"all,omitempty"`
}

type Store interface {
	Consume(ctx context.Context, key string) (*Session, error) // nil, nil when unknown, expired or already used
	Active(ctx context.Context, s *Session, started time.Time) error
	Inactive(ctx context.Context, s *Session) error
	Event(ctx context.Context, fields map[string]any)
	Revocations(ctx context.Context) <-chan Revocation
}

// Close codes the web UI maps to translated messages; the reason is the stable code.
const (
	closeSession   = 4401
	closeRevoked   = 4403
	closeExpired   = 4408
	closeTooMany   = 4429
	closeUpstream  = 4502
	closeTLS       = 4503
	cookieName     = "lvm_console"
	subprotocolSet = "binary,base64,uint8utf8"
)

type Gateway struct {
	store          Store
	guard          *netGuard
	allowedOrigins map[string]bool
	originHosts    []string // their hosts, for websocket.Accept, which makes its own check
	maxPerUser     int
	maxTotal       int
	maxDuration    time.Duration
	idle           time.Duration // terminal mode: closes after this long without input

	mu     sync.Mutex
	active map[*conn]struct{}
	denied deniedLimiter
}

type conn struct {
	s      *Session
	cancel context.CancelCauseFunc
}

var errRevoked = errors.New("CONSOLE_REVOKED")

func sessionKey(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// originOf normalises an Origin ("https://Panel.example/" becomes "https://panel.example") and returns its host.
func originOf(raw string) (origin, host string, ok bool) {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || u.Host == "" || (u.Scheme != "https" && u.Scheme != "http") {
		return "", "", false
	}
	host = strings.ToLower(u.Host)
	return u.Scheme + "://" + host, host, true
}

// originPattern is a host as a literal pattern for websocket.AcceptOptions.OriginPatterns (path.Match syntax:
// the brackets of an IPv6 address would otherwise start a character class).
func originPattern(host string) string {
	return strings.NewReplacer(`\`, `\\`, "*", `\*`, "?", `\?`, "[", `\[`).Replace(host)
}

// originAllowed: the page must come from the same host it connects to (Caddy keeps Host), or an
// explicitly configured origin. Cross-site WebSocket hijacking is refused before the upgrade.
// When the request arrived over TLS (here, or at the proxy in front) the page must be an https one as well:
// an http page on the same host name is not the panel. Plain-http local mode keeps working.
func (g *Gateway) originAllowed(r *http.Request) bool {
	origin, host, ok := originOf(r.Header.Get("Origin"))
	if !ok {
		return false
	}
	if g.allowedOrigins[origin] {
		return true
	}
	if !strings.EqualFold(host, r.Host) {
		return false
	}
	secure := r.TLS != nil || strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https")
	return !secure || strings.HasPrefix(origin, "https://")
}

// A ticket nobody issued belongs to no principal, and anyone can send one: these requests are logged and
// counted, and only a few per minute become audit events, so a loop cannot fill the audit table or push real
// console events out of the stream. The next event written says how many were left out.
const deniedPerMinute = 5

type deniedLimiter struct {
	mu         sync.Mutex
	now        func() time.Time // tests move the clock
	windowEnd  time.Time
	written    int
	suppressed int64
}

// allow reports whether one more event may be written, and how many were left out since the last one.
func (l *deniedLimiter) allow() (bool, int64) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if l.now != nil {
		now = l.now()
	}
	if !now.Before(l.windowEnd) {
		l.windowEnd, l.written = now.Add(time.Minute), 0
	}
	if l.written >= deniedPerMinute {
		l.suppressed++
		return false, 0
	}
	l.written++
	left := l.suppressed
	l.suppressed = 0
	return true, left
}

// unknownTicket records a rejected ticket that names no session: always a log line, an audit event within the limit.
func (g *Gateway) unknownTicket(ctx context.Context, event, reason string) {
	ok, left := g.denied.allow()
	logger.Warn("ticket_unknown", "event", event, "audited", ok)
	if !ok {
		return
	}
	fields := map[string]any{"event": event, "reason": reason}
	if left > 0 {
		fields["suppressed"] = left
	}
	g.store.Event(ctx, fields)
}

// reserve takes a slot for c unless its user or the gateway is at the limit. Counting and taking are one
// step under the lock: sessions opened in parallel would otherwise all pass a check made before any of them
// is counted. The caller releases the slot when the session ends or never starts.
func (g *Gateway) reserve(c *conn) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	user := 0
	for o := range g.active {
		if o.s.UserID == c.s.UserID {
			user++
		}
	}
	if user >= g.maxPerUser || len(g.active) >= g.maxTotal {
		return false
	}
	g.active[c] = struct{}{}
	return true
}

func (g *Gateway) release(c *conn) {
	g.mu.Lock()
	delete(g.active, c)
	g.mu.Unlock()
}

func (g *Gateway) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !g.originAllowed(r) {
		logger.Warn("console_origin_rejected")
		http.Error(w, "origin not allowed", http.StatusForbidden)
		return
	}
	// No cookie, or one that cannot be a ticket: refused before the upgrade and without an audit event, so a
	// loop of anonymous requests cannot fill the audit table. A ticket that is presented and rejected is still
	// recorded below, a few times a minute at most (unknownTicket).
	cookie, err := r.Cookie(cookieName)
	if err != nil || len(cookie.Value) < 32 {
		http.Error(w, "console session required", http.StatusUnauthorized)
		return
	}
	subprotocols := strings.Split(subprotocolSet, ",")
	client, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: subprotocols, OriginPatterns: g.originHosts})
	if err != nil {
		return
	}
	defer client.CloseNow()
	ctx := r.Context()

	s, err := g.store.Consume(ctx, sessionKey(cookie.Value))
	if s == nil {
		if err != nil {
			logger.Error("console_store_failed", "error", err.Error())
		}
		g.unknownTicket(ctx, "denied", "CONSOLE_SESSION_INVALID")
		client.Close(closeSession, "CONSOLE_SESSION_INVALID")
		return
	}
	// The slot is taken before the upstream dial, so the session is revocable from here on.
	runCtx, cancel := context.WithCancelCause(ctx)
	c := &conn{s: s, cancel: cancel}
	if !g.reserve(c) {
		g.store.Event(ctx, map[string]any{"event": "denied", "reason": "CONSOLE_LIMIT", "userId": s.UserID, "vm": s.VM, "connectionId": s.ConnectionID})
		client.Close(closeTooMany, "CONSOLE_LIMIT")
		return
	}

	upstream, code, err := g.dialUpstream(ctx, s, client.Subprotocol())
	if err != nil {
		g.release(c)
		logger.Warn("console_upstream_failed", "code", code, "vm", s.VM)
		g.store.Event(ctx, map[string]any{"event": "failed", "reason": code, "userId": s.UserID, "vm": s.VM, "connectionId": s.ConnectionID})
		status := websocket.StatusCode(closeUpstream)
		if code == "CONSOLE_TLS_MISMATCH" {
			status = closeTLS
		}
		client.Close(status, code)
		return
	}
	defer upstream.CloseNow()

	runCtx, stop := context.WithTimeoutCause(runCtx, g.maxDuration, errors.New("CONSOLE_EXPIRED"))
	defer stop()
	started := time.Now()
	_ = g.store.Active(ctx, s, started)
	g.store.Event(ctx, map[string]any{"event": "opened", "userId": s.UserID, "vm": s.VM, "vmName": s.VMName, "connectionId": s.ConnectionID})
	logger.Info("console_opened", "vm", s.VM)

	errs := make(chan error, 2)
	// Relays read with the request context: cancelling a read in coder/websocket drops the connection
	// without a close frame, and the browser needs the close code to explain why the console ended.
	go func() { errs <- relay(ctx, client, upstream) }()
	go func() { errs <- relay(ctx, upstream, client) }()
	select {
	case <-errs:
	case <-runCtx.Done():
	}
	reason := "CONSOLE_CLOSED"
	switch cause := context.Cause(runCtx); {
	case errors.Is(cause, errRevoked):
		reason = "CONSOLE_REVOKED"
		client.Close(closeRevoked, reason)
	case cause != nil && cause.Error() == "CONSOLE_EXPIRED":
		reason = "CONSOLE_EXPIRED"
		client.Close(closeExpired, reason)
	default:
		client.Close(websocket.StatusNormalClosure, reason)
	}
	upstream.Close(websocket.StatusNormalClosure, "")

	g.release(c)
	_ = g.store.Inactive(context.WithoutCancel(ctx), s)
	g.store.Event(context.WithoutCancel(ctx), map[string]any{"event": "closed", "reason": reason, "userId": s.UserID, "vm": s.VM,
		"connectionId": s.ConnectionID, "durationMs": time.Since(started).Milliseconds()})
	logger.Info("console_closed", "vm", s.VM, "reason", reason)
}

func relay(ctx context.Context, from, to *websocket.Conn) error {
	for {
		typ, data, err := from.Read(ctx)
		if err != nil {
			return err
		}
		if err := to.Write(ctx, typ, data); err != nil {
			return err
		}
	}
}

// dialUpstream connects to the host's WebMKS endpoint, accepting only the certificate whose
// thumbprint (or PEM) came with the ticket over the verified vCenter/ESXi API channel.
func (g *Gateway) dialUpstream(ctx context.Context, s *Session, subprotocol string) (*websocket.Conn, string, error) {
	// The address guard and the certificate pin are part of the TLS dial: a ws:// ticket would go around both.
	if u, err := url.Parse(s.URL); err != nil || u.Scheme != "wss" {
		return nil, "CONSOLE_ENDPOINT_BLOCKED", errBlocked
	}
	var pinned []byte
	if s.CertPEM != "" {
		if b, _ := pem.Decode([]byte(s.CertPEM)); b != nil {
			pinned = b.Bytes
		}
	}
	verify := func(raw [][]byte, _ [][]*x509.Certificate) error {
		if len(raw) == 0 {
			return errTLSMismatch
		}
		s1, s256 := sha1.Sum(raw[0]), sha256.Sum256(raw[0])
		if pinned != nil && subtle.ConstantTimeCompare(pinned, raw[0]) == 1 {
			return nil
		}
		if s.SHA1 != "" && hex.EncodeToString(s1[:]) == s.SHA1 { // SHA-1 only as given by the ticket; SHA-256 preferred below
			return nil
		}
		for _, h := range s.SHA256 {
			if hex.EncodeToString(s256[:]) == h {
				return nil
			}
		}
		return errTLSMismatch
	}
	tr := &http.Transport{
		Proxy:       nil,
		DialContext: g.guard.dialContext, // no plain connection is expected; if one is made, it is guarded too
		DialTLSContext: func(ctx context.Context, network, addr string) (net.Conn, error) {
			raw, err := g.guard.dialContext(ctx, network, addr)
			if err != nil {
				return nil, err
			}
			host, _, _ := net.SplitHostPort(addr)
			c := tls.Client(raw, &tls.Config{ServerName: host, MinVersion: tls.VersionTLS12, InsecureSkipVerify: true, VerifyPeerCertificate: verify})
			if err := c.HandshakeContext(ctx); err != nil {
				raw.Close()
				return nil, err
			}
			return c, nil
		},
	}
	dialCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	opts := &websocket.DialOptions{HTTPClient: &http.Client{Transport: tr}}
	if subprotocol != "" {
		opts.Subprotocols = []string{subprotocol}
	}
	up, res, err := websocket.Dial(dialCtx, s.URL, opts)
	if err != nil {
		switch {
		case errors.Is(err, errTLSMismatch):
			return nil, "CONSOLE_TLS_MISMATCH", err
		case errors.Is(err, errBlocked):
			return nil, "CONSOLE_ENDPOINT_BLOCKED", err
		case res != nil:
			return nil, "CONSOLE_TICKET_REJECTED", err
		}
		return nil, "CONSOLE_UNREACHABLE", err
	}
	up.SetReadLimit(16 << 20)
	return up, "", nil
}

var errTLSMismatch = errors.New("upstream certificate does not match the ticket")

// revocationLoop closes live consoles when the API revokes them (sign-out, disabled user, admin action).
func (g *Gateway) revocationLoop(ctx context.Context) {
	for rev := range g.store.Revocations(ctx) {
		g.revoke(rev)
	}
}

func (g *Gateway) revoke(rev Revocation) {
	g.mu.Lock()
	defer g.mu.Unlock()
	for c := range g.active {
		if rev.All || (rev.SessionKey != "" && rev.SessionKey == c.s.Key) || (rev.UserID != "" && rev.UserID == c.s.UserID) ||
			(rev.AuthHash != "" && rev.AuthHash == c.s.AuthHash) {
			c.cancel(errRevoked)
		}
	}
}
