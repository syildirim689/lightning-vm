package main

import (
	"context"
	"net"
	"net/netip"
	"testing"

	"github.com/vmware/govmomi/simulator"
)

func TestScanFindsESXiAndVCenter(t *testing.T) {
	g := testGuard()
	for _, tc := range []struct {
		model *simulator.Model
		kind  string
	}{{simulator.ESX(), "esxi"}, {simulator.VPX(), "vcenter"}} {
		host, port, srv := startSim(t, tc.model)
		res, err := scan(context.Background(), g, ScanRequest{Addresses: []string{host}, Port: port})
		if err != nil {
			t.Fatal(err)
		}
		if len(res.Hits) != 1 || res.Hits[0].State != "vsphere" || res.Hits[0].Product == nil || res.Hits[0].Product.Kind != tc.kind {
			t.Fatalf("%s: want one vsphere hit, got %+v", tc.kind, res)
		}
		c := res.Hits[0].Certificate
		if c == nil || c.SHA256 != fingerprint(srv.Certificate().Raw) || c.TrustedName != "" {
			t.Fatalf("%s: certificate wrong or trusted without a CA: %+v", tc.kind, c)
		}
		if res.Hits[0].Product.InstanceID == "" && tc.kind == "vcenter" {
			t.Fatalf("vcenter instance uuid missing")
		}
	}
}

func TestScanCountsClosedBlockedAndOtherHTTPS(t *testing.T) {
	// A port nobody listens on: refused.
	l, _ := net.Listen("tcp", "127.0.0.1:0")
	closedPort := l.Addr().(*net.TCPAddr).Port
	l.Close()
	res, err := scan(context.Background(), testGuard(), ScanRequest{Addresses: []string{"127.0.0.1"}, Port: closedPort, TimeoutMs: 500})
	if err != nil || res.Closed != 1 || len(res.Hits) != 0 {
		t.Fatalf("closed port: %+v %v", res, err)
	}
	// Production guard: loopback and link-local are never scanned.
	res, err = scan(context.Background(), &netGuard{}, ScanRequest{Addresses: []string{"127.0.0.1", "169.254.169.254"}, Port: closedPort})
	if err != nil || res.Blocked != 2 {
		t.Fatalf("blocked: %+v %v", res, err)
	}
}

func TestScanRejectsBadInput(t *testing.T) {
	g := testGuard()
	if _, err := scan(context.Background(), g, ScanRequest{}); classify(err).Code != "INVALID_REQUEST" {
		t.Fatal("empty list accepted")
	}
	if _, err := scan(context.Background(), g, ScanRequest{Addresses: []string{"esxi.local"}}); classify(err).Code != "INVALID_REQUEST" {
		t.Fatal("a name accepted")
	}
	many := make([]string, 257)
	for i := range many {
		many[i] = netip.AddrFrom4([4]byte{10, 0, byte(i / 256), byte(i % 256)}).String()
	}
	if _, err := scan(context.Background(), g, ScanRequest{Addresses: many}); classify(err).Code != "INVALID_REQUEST" {
		t.Fatal("more than 256 accepted")
	}
}
