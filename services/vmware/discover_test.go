package main

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strconv"
	"testing"

	"github.com/vmware/govmomi/simulator"
)

// These tests run against govmomi's vcsim simulator. They prove the adapter's logic and TLS
// handling, not behaviour of a real ESXi or vCenter.

func startSim(t *testing.T, model *simulator.Model) (host string, port int, srv *simulator.Server) {
	t.Helper()
	if err := model.Create(); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(model.Remove)
	model.Service.TLS = new(tls.Config) // HTTPS with a certificate the simulator generates itself
	srv = model.Service.NewServer()
	t.Cleanup(srv.Close)
	h := srv.URL.Hostname()
	p, _ := strconv.Atoi(srv.URL.Port())
	return h, p, srv
}

// The simulator listens on 127.0.0.1, which production blocks; tests allow it explicitly.
func testGuard() *netGuard {
	return &netGuard{allow: []netip.Prefix{netip.MustParsePrefix("127.0.0.0/8")}}
}

func req(host string, port int, tls TLSSettings) Request {
	return Request{Host: host, Port: port, Username: "user", Password: "pass", TLS: tls}
}

func TestSelfSignedCertificateIsRejectedAndShown(t *testing.T) {
	host, port, srv := startSim(t, simulator.ESX())
	_, err := discover(context.Background(), testGuard(), req(host, port, TLSSettings{Mode: "system"}))
	f := classify(err)
	if f.Code != "TLS_UNTRUSTED" && f.Code != "TLS_HOSTNAME_MISMATCH" {
		t.Fatalf("want TLS failure, got %s", f.Code)
	}
	if f.Certificate == nil || f.Certificate.SHA256 != fingerprint(srv.Certificate().Raw) {
		t.Fatalf("presented certificate missing or wrong: %+v", f.Certificate)
	}
}

func TestPinnedCertificate(t *testing.T) {
	host, port, srv := startSim(t, simulator.ESX())
	good := fingerprint(srv.Certificate().Raw)
	if _, err := discover(context.Background(), testGuard(), req(host, port, TLSSettings{Mode: "pinned", SHA256: good})); err != nil {
		t.Fatalf("pinned certificate should be accepted: %v", err)
	}
	bad := "00" + good[2:]
	_, err := discover(context.Background(), testGuard(), req(host, port, TLSSettings{Mode: "pinned", SHA256: bad}))
	if f := classify(err); f.Code != "TLS_PIN_MISMATCH" {
		t.Fatalf("want TLS_PIN_MISMATCH, got %s", f.Code)
	}
}

func TestBlockedEndpoint(t *testing.T) {
	host, port, _ := startSim(t, simulator.ESX())
	_, err := discover(context.Background(), &netGuard{}, req(host, port, TLSSettings{Mode: "system"}))
	if f := classify(err); f.Code != "ENDPOINT_BLOCKED" {
		t.Fatalf("loopback must be blocked by default, got %s", f.Code)
	}
	if (&netGuard{}).permitted(netip.MustParseAddr("169.254.169.254")) {
		t.Fatal("cloud metadata address must be blocked")
	}
	g := &netGuard{deny: []netip.Prefix{netip.MustParsePrefix("172.18.0.0/16")}}
	if g.permitted(netip.MustParseAddr("172.18.0.5")) || !g.permitted(netip.MustParseAddr("10.20.0.5")) {
		t.Fatal("own-network subnet must be blocked, other private networks allowed")
	}
}

func TestInvalidLogin(t *testing.T) {
	host, port, srv := startSim(t, simulator.ESX())
	// With its default listener vcsim rejects a login whose password is empty.
	r := req(host, port, TLSSettings{Mode: "pinned", SHA256: fingerprint(srv.Certificate().Raw)})
	r.Password = ""
	_, err := discover(context.Background(), testGuard(), r)
	if err == nil {
		t.Fatal("login with rejected credentials must fail")
	}
	if f := classify(err); f.Code != "INVALID_LOGIN" {
		t.Fatalf("want INVALID_LOGIN, got %s", f.Code)
	}
}

func TestDiscoverESXi(t *testing.T) {
	host, port, srv := startSim(t, simulator.ESX())
	res, err := discover(context.Background(), testGuard(), req(host, port, TLSSettings{Mode: "pinned", SHA256: fingerprint(srv.Certificate().Raw)}))
	if err != nil {
		t.Fatal(err)
	}
	if res.Product.Kind != "esxi" || res.Product.APIType != "HostAgent" || res.Operations["automationApi"] || res.Operations["cloneFromImage"] {
		t.Fatalf("standalone ESXi misdetected: %+v %+v", res.Product, res.Operations)
	}
	if len(res.Hosts) != 1 || res.Hosts[0].HardwareUUID == "" || len(res.Datastores) == 0 || len(res.Networks) == 0 {
		t.Fatalf("inventory incomplete: hosts=%d datastores=%d networks=%d", len(res.Hosts), len(res.Datastores), len(res.Networks))
	}
}

func TestDiscoverVCenter(t *testing.T) {
	model := simulator.VPX()
	model.Cluster, model.Host, model.ClusterHost = 1, 1, 2
	host, port, srv := startSim(t, model)
	res, err := discover(context.Background(), testGuard(), req(host, port, TLSSettings{Mode: "pinned", SHA256: fingerprint(srv.Certificate().Raw)}))
	if err != nil {
		t.Fatal(err)
	}
	if res.Product.Kind != "vcenter" || !res.Operations["automationApi"] {
		t.Fatalf("vCenter misdetected: %+v", res.Product)
	}
	seen := map[string]bool{}
	for _, h := range res.Hosts {
		if h.HardwareUUID == "" || seen[h.HardwareUUID] {
			t.Fatalf("hosts need distinct hardware UUIDs for de-duplication: %+v", res.Hosts)
		}
		seen[h.HardwareUUID] = true
	}
	if len(res.Hosts) != 3 || len(res.VMs) == 0 {
		t.Fatalf("want 3 hosts and some VMs, got hosts=%d vms=%d", len(res.Hosts), len(res.VMs))
	}
	clusters := 0
	for _, c := range res.Compute {
		if c.Kind == "cluster" {
			clusters++
		}
	}
	if clusters != 1 {
		t.Fatalf("want 1 cluster, got %d", clusters)
	}
}

func TestHTTPAuthAndValidation(t *testing.T) {
	h := handler("0123456789abcdef0123456789abcdef", testGuard())
	call := func(token string, body any) *httptest.ResponseRecorder {
		b, _ := json.Marshal(body)
		r := httptest.NewRequest("POST", "/v1/discover", bytes.NewReader(b))
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := call("wrong", map[string]string{}); w.Code != http.StatusUnauthorized {
		t.Fatalf("want 401 without the service token, got %d", w.Code)
	}
	if w := call("0123456789abcdef0123456789abcdef", map[string]string{}); w.Code != http.StatusBadRequest {
		t.Fatalf("want 400 for an empty request, got %d", w.Code)
	}
}
