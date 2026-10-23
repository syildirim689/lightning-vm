package main

import (
	"context"
	"errors"
	"net"
	"net/netip"
	"os"
	"strings"
)

// Copied from services/vmware/netguard.go (separate module, same rules).
// netGuard decides which addresses a console ticket's host (from ESXi/vCenter) may resolve to.
// It blocks loopback, link-local (cloud metadata), unspecified and multicast addresses and the
// subnets this container itself sits on (PostgreSQL, Redis and the API live there), unless a
// subnet is listed in CONSOLE_ALLOW_NETWORKS. CONSOLE_DENY_NETWORKS adds more blocked ranges.
type netGuard struct {
	allow []netip.Prefix
	deny  []netip.Prefix
}

func parsePrefixes(list string) []netip.Prefix {
	var out []netip.Prefix
	for _, s := range strings.Split(list, ",") {
		if p, err := netip.ParsePrefix(strings.TrimSpace(s)); err == nil {
			out = append(out, p.Masked())
		}
	}
	return out
}

func newNetGuard() *netGuard {
	g := &netGuard{allow: parsePrefixes(os.Getenv("CONSOLE_ALLOW_NETWORKS")), deny: parsePrefixes(os.Getenv("CONSOLE_DENY_NETWORKS"))}
	addrs, _ := net.InterfaceAddrs()
	for _, a := range addrs {
		if p, err := netip.ParsePrefix(a.String()); err == nil && !p.Addr().IsLoopback() {
			g.deny = append(g.deny, p.Masked())
		}
	}
	return g
}

func (g *netGuard) permitted(ip netip.Addr) bool {
	ip = ip.Unmap()
	for _, p := range g.allow {
		if p.Contains(ip) {
			return true
		}
	}
	if ip.IsLoopback() || ip.IsLinkLocalUnicast() || ip.IsLinkLocalMulticast() || ip.IsUnspecified() || ip.IsMulticast() {
		return false
	}
	for _, p := range g.deny {
		if p.Contains(ip) {
			return false
		}
	}
	return true
}

// dialContext resolves once, checks every address and dials the checked IP, so a DNS answer
// cannot change between the check and the connection.
func (g *netGuard) dialContext(ctx context.Context, network, addr string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(addr)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupNetIP(ctx, "ip", host)
	if err != nil {
		return nil, err
	}
	for _, ip := range ips {
		if !g.permitted(ip) {
			return nil, errBlocked
		}
	}
	var d net.Dialer
	return d.DialContext(ctx, network, net.JoinHostPort(ips[0].String(), port))
}

var errBlocked = errors.New("endpoint address is not permitted")
