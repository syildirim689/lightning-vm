package main

// TEST ONLY: vcsim does not implement AcquireTicket, and it has no console. This adds a WebMKS-like
// ticket and a TLS WebSocket endpoint that greets the client and echoes frames, so the console
// chain (API -> adapter -> gateway -> "ESXi") can be exercised. It is not VMware's WebMKS protocol.

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"log"
	"math/big"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/vmware/govmomi/simulator"
	"github.com/vmware/govmomi/vim25/methods"
	"github.com/vmware/govmomi/vim25/soap"
	"github.com/vmware/govmomi/vim25/types"
)

type fakeWebMKS struct {
	host, port   string
	sha1, sha256 string
	mu           sync.Mutex
	tickets      map[string]string // ticket -> VM name, single use
}

func newFakeWebMKS(host, port string) (*fakeWebMKS, *tls.Config) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	tmpl := &x509.Certificate{SerialNumber: big.NewInt(time.Now().UnixNano()), Subject: pkix.Name{CommonName: host},
		NotBefore: time.Now().Add(-time.Hour), NotAfter: time.Now().Add(24 * time.Hour), DNSNames: []string{host}}
	if ip := net.ParseIP(host); ip != nil {
		tmpl.IPAddresses = []net.IP{ip}
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		log.Fatal(err)
	}
	s1, s256 := sha1.Sum(der), sha256.Sum256(der)
	f := &fakeWebMKS{host: host, port: port, sha1: hex.EncodeToString(s1[:]), sha256: hex.EncodeToString(s256[:]), tickets: map[string]string{}}
	return f, &tls.Config{Certificates: []tls.Certificate{{Certificate: [][]byte{der}, PrivateKey: key}}}
}

func (f *fakeWebMKS) issue(vm string) string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	t := hex.EncodeToString(b)
	f.mu.Lock()
	f.tickets[t] = vm
	f.mu.Unlock()
	return t
}

func (f *fakeWebMKS) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	t := strings.TrimPrefix(r.URL.Path, "/ticket/")
	f.mu.Lock()
	vm, ok := f.tickets[t]
	delete(f.tickets, t)
	f.mu.Unlock()
	if !ok {
		http.Error(w, "unknown or used ticket", http.StatusForbidden)
		return
	}
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"binary", "base64", "uint8utf8"}})
	if err != nil {
		return
	}
	defer c.CloseNow()
	ctx := r.Context()
	_ = c.Write(ctx, websocket.MessageText, []byte("fake-webmks "+vm))
	for {
		typ, data, err := c.Read(ctx)
		if err != nil {
			return
		}
		if c.Write(ctx, typ, data) != nil {
			return
		}
	}
}

type ticketVM struct {
	*simulator.VirtualMachine
	mks *fakeWebMKS
}

func (vm *ticketVM) AcquireTicket(req *types.AcquireTicket) soap.HasFault {
	body := &methods.AcquireTicketBody{}
	if req.TicketType != "webmks" {
		body.Fault_ = simulator.Fault("", &types.InvalidArgument{InvalidProperty: "ticketType"})
		return body
	}
	port, _ := strconv.Atoi(vm.mks.port)
	body.Res = &types.AcquireTicketResponse{Returnval: types.VirtualMachineTicket{
		Ticket: vm.mks.issue(vm.Name), Host: vm.mks.host, Port: int32(port), SslThumbprint: vm.mks.sha1,
		CertThumbprintList: []types.VirtualMachineCertThumbprint{{Thumbprint: vm.mks.sha256, HashAlgorithm: "sha256"}},
	}}
	return body
}

// enableWebMKS wraps every simulated VM and starts the fake endpoint on host:port.
func enableWebMKS(model *simulator.Model, host, port string) {
	f, cfg := newFakeWebMKS(host, port)
	for _, e := range model.Map().All("VirtualMachine") {
		model.Map().Put(&ticketVM{VirtualMachine: e.(*simulator.VirtualMachine), mks: f})
	}
	srv := &http.Server{Addr: net.JoinHostPort("0.0.0.0", port), Handler: f, TLSConfig: cfg, ReadHeaderTimeout: 10 * time.Second}
	go func() { log.Fatal(srv.ListenAndServeTLS("", "")) }()
	log.Printf("fake WebMKS on %s:%s (TEST ONLY, not VMware's protocol)", host, port)
}
