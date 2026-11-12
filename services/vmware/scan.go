package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"errors"
	"net"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/vmware/govmomi/vim25"
	"github.com/vmware/govmomi/vim25/soap"
)

// Network discovery: which addresses of a block answer as ESXi or vCenter. Each address is asked
// only for the public ServiceContent (product, version, instance UUID), the same call any vSphere
// client makes before logging in. No credentials are sent, so the certificate is read without
// trusting it; trust is decided later, when the admin adds the endpoint.

const (
	scanMaxAddresses = 256
	scanParallel     = 32
)

type ScanRequest struct {
	Addresses []string `json:"addresses"`
	Port      int      `json:"port"`
	TimeoutMs int      `json:"timeoutMs"`
}

// ScanCert is what the results list shows; the PEM is left out to keep a large scan small.
type ScanCert struct {
	Subject     string   `json:"subject"`
	Issuer      string   `json:"issuer"`
	NotAfter    string   `json:"notAfter"`
	SHA256      string   `json:"sha256"`
	DNSNames    []string `json:"dnsNames"`
	IPs         []string `json:"ips"`
	SelfSigned  bool     `json:"selfSigned"`
	TrustedName string   `json:"trustedName"` // a name the system CAs verify this certificate for; empty when not trusted
}

// ScanHit is one address that answered over TLS: "vsphere" (with Product) or "https" (some other service).
type ScanHit struct {
	Address     string    `json:"address"`
	State       string    `json:"state"`
	Hostname    string    `json:"hostname,omitempty"`
	Product     *Product  `json:"product,omitempty"`
	Certificate *ScanCert `json:"certificate,omitempty"`
}

type ScanResult struct {
	Hits    []ScanHit `json:"hits"`
	Closed  int       `json:"closed"`  // refused the connection
	Silent  int       `json:"silent"`  // no answer in time, or not TLS
	Blocked int       `json:"blocked"` // not permitted by the address guard
}

func scan(ctx context.Context, g *netGuard, r ScanRequest) (*ScanResult, error) {
	if len(r.Addresses) == 0 || len(r.Addresses) > scanMaxAddresses {
		return nil, &Failure{Code: "INVALID_REQUEST", Message: "1 to 256 addresses per call"}
	}
	if r.Port == 0 {
		r.Port = 443
	}
	if r.Port < 1 || r.Port > 65535 {
		return nil, &Failure{Code: "INVALID_REQUEST", Message: "invalid port"}
	}
	timeout := time.Duration(min(max(r.TimeoutMs, 300), 5000)) * time.Millisecond
	if r.TimeoutMs == 0 {
		timeout = 1500 * time.Millisecond
	}
	ips := make([]netip.Addr, 0, len(r.Addresses))
	for _, a := range r.Addresses {
		ip, err := netip.ParseAddr(strings.TrimSpace(a))
		if err != nil {
			return nil, &Failure{Code: "INVALID_REQUEST", Message: "addresses must be IP addresses"}
		}
		ips = append(ips, ip.Unmap())
	}
	out := &ScanResult{Hits: []ScanHit{}}
	var mu sync.Mutex
	var wg sync.WaitGroup
	slots := make(chan struct{}, scanParallel)
	for _, ip := range ips {
		if !g.permitted(ip) {
			out.Blocked++
			continue
		}
		wg.Add(1)
		slots <- struct{}{}
		go func(ip netip.Addr) {
			defer func() { <-slots; wg.Done() }()
			hit, state := probe(ctx, g, ip, r.Port, timeout)
			mu.Lock()
			defer mu.Unlock()
			switch state {
			case "closed":
				out.Closed++
			case "silent":
				out.Silent++
			default:
				out.Hits = append(out.Hits, *hit)
			}
		}(ip)
	}
	wg.Wait()
	return out, ctx.Err()
}

// probe: TCP, then a TLS handshake that only reads the certificate, then the anonymous
// RetrieveServiceContent. State is "closed", "silent", "https" or "vsphere".
func probe(parent context.Context, g *netGuard, ip netip.Addr, port int, timeout time.Duration) (*ScanHit, string) {
	addr := net.JoinHostPort(ip.String(), strconv.Itoa(port))
	ctx, cancel := context.WithTimeout(parent, timeout)
	defer cancel()
	raw, err := g.dialContext(ctx, "tcp", addr)
	if err != nil {
		if errors.Is(err, syscall.ECONNREFUSED) {
			return nil, "closed"
		}
		return nil, "silent"
	}
	conn := tls.Client(raw, &tls.Config{InsecureSkipVerify: true}) // inspection only: nothing secret is sent
	if conn.HandshakeContext(ctx) != nil || len(conn.ConnectionState().PeerCertificates) == 0 {
		raw.Close()
		return nil, "silent"
	}
	chain := conn.ConnectionState().PeerCertificates
	conn.Close()

	hit := &ScanHit{Address: ip.String(), State: "https", Hostname: reverseName(parent, ip), Certificate: scanCert(chain, ip.String())}
	if hit.Hostname != "" && hit.Certificate.TrustedName == "" && chain[0].VerifyHostname(hit.Hostname) == nil && verifiesChain(chain) {
		hit.Certificate.TrustedName = hit.Hostname
	}
	// The SOAP call gets its own, longer budget: a vCenter can take a moment to answer.
	sctx, scancel := context.WithTimeout(parent, timeout+3*time.Second)
	defer scancel()
	if p := about(sctx, g, addr); p != nil {
		hit.State, hit.Product = "vsphere", p
	}
	return hit, hit.State
}

func about(ctx context.Context, g *netGuard, addr string) *Product {
	sc := soap.NewClient(&url.URL{Scheme: "https", Host: addr, Path: "/sdk"}, true)
	tr := sc.DefaultTransport()
	tr.Proxy = nil
	tr.DialContext = g.dialContext
	tr.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		raw, err := g.dialContext(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		conn := tls.Client(raw, &tls.Config{InsecureSkipVerify: true}) // anonymous call, no credentials
		if err := conn.HandshakeContext(ctx); err != nil {
			raw.Close()
			return nil, err
		}
		return conn, nil
	}
	if err := sc.UseServiceVersion(); err != nil {
		sc.Version, sc.Namespace = "", ""
	}
	c, err := vim25.NewClient(ctx, sc)
	if err != nil {
		return nil
	}
	a := c.ServiceContent.About
	kind := ""
	switch a.ApiType {
	case "VirtualCenter":
		kind = "vcenter"
	case "HostAgent":
		kind = "esxi"
	default:
		return nil
	}
	return &Product{Kind: kind, Name: a.Name, FullName: a.FullName, Version: a.Version, Build: a.Build, APIType: a.ApiType, APIVersion: a.ApiVersion, InstanceID: a.InstanceUuid}
}

func verifiesChain(chain []*x509.Certificate) bool {
	inter := x509.NewCertPool()
	for _, c := range chain[1:] {
		inter.AddCert(c)
	}
	_, err := chain[0].Verify(x509.VerifyOptions{Intermediates: inter})
	return err == nil
}

func scanCert(chain []*x509.Certificate, address string) *ScanCert {
	c := chain[0]
	info := certInfo(c)
	out := &ScanCert{Subject: info.Subject, Issuer: info.Issuer, NotAfter: info.NotAfter, SHA256: info.SHA256, DNSNames: info.DNSNames, IPs: info.IPs,
		SelfSigned: c.Subject.String() == c.Issuer.String() && c.CheckSignatureFrom(c) == nil}
	if out.DNSNames == nil {
		out.DNSNames = []string{}
	}
	if verifiesChain(chain) && c.VerifyHostname(address) == nil {
		out.TrustedName = address
	}
	return out
}

// reverseName: the PTR name, if one answers quickly; trailing dot removed.
func reverseName(parent context.Context, ip netip.Addr) string {
	ctx, cancel := context.WithTimeout(parent, 700*time.Millisecond)
	defer cancel()
	names, err := net.DefaultResolver.LookupAddr(ctx, ip.String())
	if err != nil || len(names) == 0 {
		return ""
	}
	return strings.TrimSuffix(names[0], ".")
}
