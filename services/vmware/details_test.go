package main

import (
	"context"
	"testing"

	"github.com/vmware/govmomi/simulator"
	"github.com/vmware/govmomi/vim25/mo"
)

// Against the vCenter simulator: a VM's details carry its hardware, at least one NIC with a MAC on a
// named network, at least one disk with its datastore and controller slot, and where it runs.
func TestVMDetails(t *testing.T) {
	host, port, srv := startSim(t, simulator.VPX())
	req := Request{Host: host, Port: port, Username: "user", Password: "pass", TLS: TLSSettings{Mode: "pinned", SHA256: fingerprint(srv.Certificate().Raw)}}
	ctx := context.Background()
	c, sm, err := connect(ctx, testGuard(), req)
	if err != nil {
		t.Fatal(err)
	}
	defer sm.Logout(ctx)
	vms, _ := retrieve[mo.VirtualMachine](ctx, c, "VirtualMachine", []string{"name"})
	if len(vms) == 0 {
		t.Fatal("simulator has no VM")
	}
	d, err := vmDetails(ctx, c, vms[0].Self.Value)
	if err != nil {
		t.Fatal(err)
	}
	if d.Name == "" || d.CPU.Count < 1 || d.Memory.SizeMB < 1 || d.InstanceUUID == "" {
		t.Fatalf("identity/hardware missing: %+v", d)
	}
	if len(d.NICs) == 0 || d.NICs[0].MAC == "" || d.NICs[0].Network == "" || d.NICs[0].Adapter == "" {
		t.Fatalf("NIC missing: %+v", d.NICs)
	}
	if len(d.Disks) == 0 || d.Disks[0].CapacityGB <= 0 || d.Disks[0].Datastore == "" || d.Disks[0].Controller == "" {
		t.Fatalf("disk missing: %+v", d.Disks)
	}
	if d.Placement.Host == "" || len(d.Placement.Datastores) == 0 {
		t.Fatalf("placement missing: %+v", d.Placement)
	}

	if _, err := vmDetails(ctx, c, ""); err == nil {
		t.Fatal("an empty moref must be refused")
	}
	if _, err := vmDetails(ctx, c, "vm-does-not-exist"); err == nil {
		t.Fatal("an unknown VM must fail")
	}
}

func TestDetailHelpers(t *testing.T) {
	if datastoreName("[datastore1] web/web.vmdk") != "datastore1" || datastoreName("web.vmdk") != "" {
		t.Fatal("datastoreName")
	}
	if itoa(int32(0)) != "0" || itoa(int32(42)) != "42" || itoa(-7) != "-7" {
		t.Fatal("itoa")
	}
	if got := appendNew([]string{"a"}, "a", "b", ""); len(got) != 2 {
		t.Fatalf("appendNew: %v", got)
	}
}
