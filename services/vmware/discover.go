package main

import (
	"context"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/pem"
	"errors"
	"net"
	"net/url"
	"strconv"
	"strings"
	"syscall"

	"github.com/vmware/govmomi/fault"
	"github.com/vmware/govmomi/license"
	"github.com/vmware/govmomi/object"
	"github.com/vmware/govmomi/session"
	"github.com/vmware/govmomi/view"
	"github.com/vmware/govmomi/vim25"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/soap"
	"github.com/vmware/govmomi/vim25/types"
)

var (
	errBlocked     = errors.New("endpoint address is not permitted")
	errPinMismatch = errors.New("certificate fingerprint does not match the pinned value")
)

// TLSSettings: "system" verifies against the system CAs, "ca" adds a custom CA bundle (hostname
// still verified), "pinned" accepts exactly one leaf certificate by SHA-256. Verification is never off.
type TLSSettings struct {
	Mode   string `json:"mode"`
	CAPEM  string `json:"caPem,omitempty"`
	SHA256 string `json:"sha256,omitempty"`
}

type Request struct {
	Host     string      `json:"host"`
	Port     int         `json:"port"`
	Username string      `json:"username"`
	Password string      `json:"password"`
	TLS      TLSSettings `json:"tls"`
}

// Failure carries a stable code; Certificate is filled when the server's certificate was not trusted.
type Failure struct {
	Code        string           `json:"code"`
	Message     string           `json:"message"`
	Certificate *CertificateInfo `json:"certificate,omitempty"`
}

func (f *Failure) Error() string { return f.Code + ": " + f.Message }

type CertificateInfo struct {
	Subject  string   `json:"subject"`
	Issuer   string   `json:"issuer"`
	NotAfter string   `json:"notAfter"`
	SHA256   string   `json:"sha256"`
	DNSNames []string `json:"dnsNames"`
	IPs      []string `json:"ips"`
	PEM      string   `json:"pem"`
}

func fingerprint(der []byte) string {
	sum := sha256.Sum256(der)
	return hex.EncodeToString(sum[:])
}

func certInfo(c *x509.Certificate) *CertificateInfo {
	ips := make([]string, 0, len(c.IPAddresses))
	for _, ip := range c.IPAddresses {
		ips = append(ips, ip.String())
	}
	return &CertificateInfo{
		Subject: c.Subject.String(), Issuer: c.Issuer.String(), NotAfter: c.NotAfter.UTC().Format("2006-01-02T15:04:05Z"),
		SHA256: fingerprint(c.Raw), DNSNames: c.DNSNames, IPs: ips,
		PEM: string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: c.Raw})),
	}
}

func tlsConfig(s TLSSettings, serverName string) (*tls.Config, error) {
	cfg := &tls.Config{ServerName: serverName, MinVersion: tls.VersionTLS12}
	switch s.Mode {
	case "", "system":
	case "ca":
		pool, err := x509.SystemCertPool()
		if err != nil {
			pool = x509.NewCertPool()
		}
		if !pool.AppendCertsFromPEM([]byte(s.CAPEM)) {
			return nil, &Failure{Code: "INVALID_CA", Message: "custom CA is not valid PEM"}
		}
		cfg.RootCAs = pool
	case "pinned":
		pin := strings.ToLower(strings.ReplaceAll(s.SHA256, ":", ""))
		if len(pin) != 64 {
			return nil, &Failure{Code: "INVALID_PIN", Message: "pinned fingerprint must be a SHA-256 hex value"}
		}
		// Chain checks are replaced by an exact match on the leaf certificate, not skipped.
		cfg.InsecureSkipVerify = true
		cfg.VerifyPeerCertificate = func(raw [][]byte, _ [][]*x509.Certificate) error {
			if len(raw) == 0 || fingerprint(raw[0]) != pin {
				return errPinMismatch
			}
			return nil
		}
	default:
		return nil, &Failure{Code: "INVALID_TLS_MODE", Message: "tls.mode must be system, ca or pinned"}
	}
	return cfg, nil
}

// presentedCertificate reads the leaf certificate for display only; nothing is sent over this connection.
func presentedCertificate(ctx context.Context, g *netGuard, addr, serverName string) *CertificateInfo {
	raw, err := g.dialContext(ctx, "tcp", addr)
	if err != nil {
		return nil
	}
	conn := tls.Client(raw, &tls.Config{ServerName: serverName, InsecureSkipVerify: true}) // inspection only
	defer conn.Close()
	if conn.HandshakeContext(ctx) != nil || len(conn.ConnectionState().PeerCertificates) == 0 {
		return nil
	}
	return certInfo(conn.ConnectionState().PeerCertificates[0])
}

func classify(err error) *Failure {
	var f *Failure
	var unknown x509.UnknownAuthorityError
	var verify *tls.CertificateVerificationError
	var hostErr x509.HostnameError
	var dnsErr *net.DNSError
	var netErr net.Error
	switch {
	case errors.As(err, &f):
		return f
	case errors.Is(err, errBlocked):
		return &Failure{Code: "ENDPOINT_BLOCKED", Message: err.Error()}
	case errors.Is(err, errPinMismatch):
		return &Failure{Code: "TLS_PIN_MISMATCH", Message: err.Error()}
	case errors.As(err, &hostErr):
		return &Failure{Code: "TLS_HOSTNAME_MISMATCH", Message: hostErr.Error()}
	case errors.As(err, &unknown), errors.As(err, &verify):
		return &Failure{Code: "TLS_UNTRUSTED", Message: err.Error()}
	case errors.As(err, &dnsErr):
		return &Failure{Code: "DNS_FAILED", Message: dnsErr.Error()}
	case errors.Is(err, syscall.ECONNREFUSED):
		return &Failure{Code: "CONNECTION_REFUSED", Message: err.Error()}
	case errors.As(err, &netErr) && netErr.Timeout(), errors.Is(err, context.DeadlineExceeded):
		return &Failure{Code: "TIMEOUT", Message: "timed out"}
	case fault.Is(err, &types.InvalidLogin{}):
		return &Failure{Code: "INVALID_LOGIN", Message: "user name or password rejected"}
	case fault.Is(err, &types.NoPermission{}):
		return &Failure{Code: "PERMISSION_DENIED", Message: "the account lacks a required privilege"}
	}
	return &Failure{Code: "NOT_VSPHERE", Message: "no vSphere Web Services API answered at /sdk: " + err.Error()}
}

// Privileges checked on the root folder and the operations they unlock.
var privilegeChecks = []string{
	"System.View", "System.Read",
	"VirtualMachine.Inventory.Create", "VirtualMachine.Inventory.Delete",
	"VirtualMachine.Interact.PowerOn", "VirtualMachine.Interact.PowerOff", "VirtualMachine.Interact.Reset",
	"VirtualMachine.Interact.ConsoleInteract", "VirtualMachine.Config.CPUCount", "VirtualMachine.Config.Memory",
	"VirtualMachine.Config.AddNewDisk", "VirtualMachine.Provisioning.Clone", "VirtualMachine.State.CreateSnapshot",
	"Datastore.AllocateSpace", "Network.Assign", "Resource.AssignVMToPool",
}

type Product struct {
	Kind       string `json:"kind"` // "vcenter" or "esxi", from about.apiType
	Name       string `json:"name"`
	FullName   string `json:"fullName"`
	Version    string `json:"version"`
	Build      string `json:"build"`
	APIType    string `json:"apiType"`
	APIVersion string `json:"apiVersion"`
	InstanceID string `json:"instanceUuid"`
}

type License struct {
	Name       string `json:"name"`
	EditionKey string `json:"editionKey"`
	Total      int32  `json:"total"`
	Used       int32  `json:"used"`
}

type Host struct {
	MoRef            string `json:"moref"`
	Name             string `json:"name"`
	HardwareUUID     string `json:"hardwareUuid"`
	Vendor           string `json:"vendor"`
	Model            string `json:"model"`
	CPUMhz           int32  `json:"cpuMhz"`
	CPUCores         int16  `json:"cpuCores"`
	CPUThreads       int16  `json:"cpuThreads"`
	MemoryBytes      int64  `json:"memoryBytes"`
	ConnectionState  string `json:"connectionState"`
	PowerState       string `json:"powerState"`
	InMaintenance    bool   `json:"inMaintenance"`
	Version          string `json:"version"`
	ManagementServer string `json:"managementServer"`
	Parent           string `json:"parent"`
}

type Datastore struct {
	MoRef            string   `json:"moref"`
	Name             string   `json:"name"`
	Type             string   `json:"type"`
	CapacityBytes    int64    `json:"capacityBytes"`
	FreeBytes        int64    `json:"freeBytes"`
	UncommittedBytes int64    `json:"uncommittedBytes"`
	Accessible       bool     `json:"accessible"`
	MaintenanceMode  string   `json:"maintenanceMode"`
	Hosts            []string `json:"hosts"`
}

type Network struct {
	MoRef  string `json:"moref"`
	Name   string `json:"name"`
	Kind   string `json:"kind"` // "standard" or "distributed"
	VLAN   *int32 `json:"vlan"`
	Switch string `json:"switch"`
}

type ComputeResource struct {
	MoRef          string `json:"moref"`
	Name           string `json:"name"`
	Kind           string `json:"kind"` // "cluster" or "standalone"
	Hosts          int32  `json:"hosts"`
	EffectiveCPU   int32  `json:"effectiveCpuMhz"`
	EffectiveMemMB int64  `json:"effectiveMemoryMb"`
	ResourcePool   string `json:"resourcePool"`
}

type VM struct {
	MoRef            string `json:"moref"`
	Name             string `json:"name"`
	UUID             string `json:"uuid"`
	InstanceUUID     string `json:"instanceUuid"`
	PowerState       string `json:"powerState"`
	Host             string `json:"host"`
	CPU              int32  `json:"cpu"`
	MemoryMB         int32  `json:"memoryMb"`
	Template         bool   `json:"template"`
	Guest            string `json:"guest"`
	CommittedBytes   int64  `json:"committedBytes"`
	UncommittedBytes int64  `json:"uncommittedBytes"`
}

type Result struct {
	Product    Product           `json:"product"`
	Licenses   []License         `json:"licenses"`
	WriteAPI   string            `json:"writeApi"` // "available", "restricted" or "unknown"
	Privileges map[string]bool   `json:"privileges"`
	Operations map[string]bool   `json:"operations"`
	Warnings   []string          `json:"warnings"`
	Hosts      []Host            `json:"hosts"`
	Datastores []Datastore       `json:"datastores"`
	Networks   []Network         `json:"networks"`
	Compute    []ComputeResource `json:"compute"`
	VMs        []VM              `json:"vms"`
}

func connect(ctx context.Context, g *netGuard, r Request) (*vim25.Client, *session.Manager, error) {
	if r.Port == 0 {
		r.Port = 443
	}
	addr := net.JoinHostPort(r.Host, strconv.Itoa(r.Port))
	cfg, err := tlsConfig(r.TLS, r.Host)
	if err != nil {
		return nil, nil, err
	}
	sc := soap.NewClient(&url.URL{Scheme: "https", Host: addr, Path: "/sdk"}, false)
	tr := sc.DefaultTransport()
	tr.TLSClientConfig = cfg
	tr.Proxy = nil // the endpoint is on the management network; never route credentials through a proxy
	// govmomi installs its own DialTLSContext built on tls.Dial, which would bypass the address guard
	// and the request context. Replace it: guarded TCP dial, then a handshake with our TLS settings.
	tr.DialContext = g.dialContext
	tr.DialTLSContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		raw, err := g.dialContext(ctx, network, addr)
		if err != nil {
			return nil, err
		}
		conn := tls.Client(raw, cfg)
		if err := conn.HandshakeContext(ctx); err != nil {
			raw.Close()
			return nil, err
		}
		return conn, nil
	}
	c, err := vim25.NewClient(ctx, sc)
	if err != nil {
		f := classify(err)
		if f.Code == "TLS_UNTRUSTED" || f.Code == "TLS_HOSTNAME_MISMATCH" || f.Code == "TLS_PIN_MISMATCH" {
			f.Certificate = presentedCertificate(ctx, g, addr, r.Host)
		}
		return nil, nil, f
	}
	sm := session.NewManager(c)
	if err := sm.Login(ctx, url.UserPassword(r.Username, r.Password)); err != nil {
		return nil, nil, classify(err)
	}
	return c, sm, nil
}

func retrieve[T any](ctx context.Context, c *vim25.Client, kind string, props []string) ([]T, error) {
	v, err := view.NewManager(c).CreateContainerView(ctx, c.ServiceContent.RootFolder, []string{kind}, true)
	if err != nil {
		return nil, err
	}
	defer v.Destroy(ctx)
	var out []T
	return out, v.Retrieve(ctx, []string{kind}, props, &out)
}

func ref(r *types.ManagedObjectReference) string {
	if r == nil {
		return ""
	}
	return r.Value
}

// shortcut: whole inventory in one response without paging; add paging for very large vCenters.
func discover(ctx context.Context, g *netGuard, r Request) (*Result, error) {
	c, sm, err := connect(ctx, g, r)
	if err != nil {
		return nil, err
	}
	defer sm.Logout(context.WithoutCancel(ctx))

	about := c.ServiceContent.About
	res := &Result{
		Product: Product{Name: about.Name, FullName: about.FullName, Version: about.Version, Build: about.Build,
			APIType: about.ApiType, APIVersion: about.ApiVersion, InstanceID: about.InstanceUuid, Kind: "esxi"},
		Privileges: map[string]bool{}, Operations: map[string]bool{}, Warnings: []string{},
	}
	if about.ApiType == "VirtualCenter" {
		res.Product.Kind = "vcenter"
	}

	// License keys are never returned or stored; only edition and usage.
	res.WriteAPI = "unknown"
	if infos, err := license.NewManager(c).List(ctx); err == nil {
		res.WriteAPI = "available"
		for _, l := range infos {
			res.Licenses = append(res.Licenses, License{Name: l.Name, EditionKey: l.EditionKey, Total: l.Total, Used: l.Used})
			// The free vSphere Hypervisor license makes the API read-only. Detected from the edition;
			// confirmed only by a real write on real hardware.
			if l.EditionKey == "esxBasic" || strings.Contains(strings.ToLower(l.Name), "hypervisor") {
				res.WriteAPI = "restricted"
			}
		}
	} else {
		res.Warnings = append(res.Warnings, "LICENSE_UNREADABLE")
	}

	if us, err := sm.UserSession(ctx); err == nil && us != nil {
		authz := object.NewAuthorizationManager(c)
		if granted, err := authz.HasPrivilegeOnEntity(ctx, c.ServiceContent.RootFolder, us.Key, privilegeChecks); err == nil {
			for i, p := range privilegeChecks {
				res.Privileges[p] = granted[i]
			}
		} else {
			res.Warnings = append(res.Warnings, "PRIVILEGES_UNREADABLE")
		}
	}
	has := func(ps ...string) bool {
		for _, p := range ps {
			if !res.Privileges[p] {
				return false
			}
		}
		return true
	}
	write := res.WriteAPI == "available"
	res.Operations = map[string]bool{
		"inventory":      has("System.View", "System.Read"),
		"createVm":       write && has("VirtualMachine.Inventory.Create", "Datastore.AllocateSpace", "Network.Assign", "Resource.AssignVMToPool", "VirtualMachine.Config.AddNewDisk"),
		"cloneFromImage": write && res.Product.Kind == "vcenter" && has("VirtualMachine.Provisioning.Clone", "Datastore.AllocateSpace"),
		"power":          write && has("VirtualMachine.Interact.PowerOn", "VirtualMachine.Interact.PowerOff", "VirtualMachine.Interact.Reset"),
		"resize":         write && has("VirtualMachine.Config.CPUCount", "VirtualMachine.Config.Memory"),
		"deleteVm":       write && has("VirtualMachine.Inventory.Delete"),
		"snapshot":       write && has("VirtualMachine.State.CreateSnapshot"),
		"console":        has("VirtualMachine.Interact.ConsoleInteract"),
		// The vCenter Automation REST API (/api) exists only on vCenter, never on a standalone ESXi.
		"automationApi": res.Product.Kind == "vcenter",
	}

	hosts, err := retrieve[mo.HostSystem](ctx, c, "HostSystem", []string{"name", "summary", "parent", "config.network.portgroup"})
	if err != nil {
		return nil, classify(err)
	}
	vlanByPortgroup := map[string]int32{}
	switchByPortgroup := map[string]string{}
	for _, h := range hosts {
		hw := h.Summary.Hardware
		item := Host{MoRef: h.Self.Value, Name: h.Name, ConnectionState: string(h.Summary.Runtime.ConnectionState),
			PowerState: string(h.Summary.Runtime.PowerState), InMaintenance: h.Summary.Runtime.InMaintenanceMode,
			ManagementServer: h.Summary.ManagementServerIp, Parent: ref(h.Parent)}
		if hw != nil {
			item.HardwareUUID, item.Vendor, item.Model = hw.Uuid, hw.Vendor, hw.Model
			item.CPUMhz, item.CPUCores, item.CPUThreads, item.MemoryBytes = hw.CpuMhz, hw.NumCpuCores, hw.NumCpuThreads, hw.MemorySize
		}
		if h.Summary.Config.Product != nil {
			item.Version = h.Summary.Config.Product.Version
		}
		if res.Product.Kind == "esxi" && item.ManagementServer != "" {
			res.Warnings = append(res.Warnings, "HOST_MANAGED_BY_VCENTER")
		}
		res.Hosts = append(res.Hosts, item)
		if h.Config != nil && h.Config.Network != nil {
			for _, pg := range h.Config.Network.Portgroup {
				vlanByPortgroup[pg.Spec.Name] = pg.Spec.VlanId
				switchByPortgroup[pg.Spec.Name] = pg.Spec.VswitchName
			}
		}
	}

	stores, err := retrieve[mo.Datastore](ctx, c, "Datastore", []string{"summary", "host"})
	if err != nil {
		return nil, classify(err)
	}
	for _, d := range stores {
		s := d.Summary
		item := Datastore{MoRef: d.Self.Value, Name: s.Name, Type: s.Type, CapacityBytes: s.Capacity, FreeBytes: s.FreeSpace,
			UncommittedBytes: s.Uncommitted, Accessible: s.Accessible, MaintenanceMode: s.MaintenanceMode, Hosts: []string{}}
		for _, m := range d.Host {
			item.Hosts = append(item.Hosts, m.Key.Value)
		}
		res.Datastores = append(res.Datastores, item)
	}

	nets, err := retrieve[mo.Network](ctx, c, "Network", []string{"name"})
	if err != nil {
		return nil, classify(err)
	}
	dvpgs, err := retrieve[mo.DistributedVirtualPortgroup](ctx, c, "DistributedVirtualPortgroup", []string{"name", "config"})
	if err != nil {
		return nil, classify(err)
	}
	distributed := map[string]mo.DistributedVirtualPortgroup{}
	for _, p := range dvpgs {
		distributed[p.Self.Value] = p
	}
	for _, n := range nets {
		item := Network{MoRef: n.Self.Value, Name: n.Name, Kind: "standard"}
		if p, ok := distributed[n.Self.Value]; ok {
			item.Kind = "distributed"
			item.Switch = ref(p.Config.DistributedVirtualSwitch)
			if s, ok := p.Config.DefaultPortConfig.(*types.VMwareDVSPortSetting); ok && s.Vlan != nil {
				if id, ok := s.Vlan.(*types.VmwareDistributedVirtualSwitchVlanIdSpec); ok {
					v := id.VlanId
					item.VLAN = &v
				}
			}
		} else if v, ok := vlanByPortgroup[n.Name]; ok {
			item.VLAN = &v
			item.Switch = switchByPortgroup[n.Name]
		}
		res.Networks = append(res.Networks, item)
	}

	computes, err := retrieve[mo.ComputeResource](ctx, c, "ComputeResource", []string{"name", "summary", "resourcePool"})
	if err != nil {
		return nil, classify(err)
	}
	for _, cr := range computes {
		item := ComputeResource{MoRef: cr.Self.Value, Name: cr.Name, Kind: "standalone", ResourcePool: ref(cr.ResourcePool)}
		if cr.Self.Type == "ClusterComputeResource" {
			item.Kind = "cluster"
		}
		if cr.Summary != nil {
			s := cr.Summary.GetComputeResourceSummary()
			item.Hosts, item.EffectiveCPU, item.EffectiveMemMB = s.NumHosts, s.EffectiveCpu, s.EffectiveMemory
		}
		res.Compute = append(res.Compute, item)
	}

	vms, err := retrieve[mo.VirtualMachine](ctx, c, "VirtualMachine", []string{"summary"})
	if err != nil {
		return nil, classify(err)
	}
	for _, v := range vms {
		s := v.Summary
		item := VM{MoRef: v.Self.Value, Name: s.Config.Name, UUID: s.Config.Uuid, InstanceUUID: s.Config.InstanceUuid,
			PowerState: string(s.Runtime.PowerState), Host: ref(s.Runtime.Host), CPU: s.Config.NumCpu, MemoryMB: s.Config.MemorySizeMB,
			Template: s.Config.Template, Guest: s.Config.GuestFullName}
		if s.Storage != nil {
			item.CommittedBytes, item.UncommittedBytes = s.Storage.Committed, s.Storage.Uncommitted
		}
		res.VMs = append(res.VMs, item)
	}
	return res, nil
}
