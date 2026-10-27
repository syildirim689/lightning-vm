package main

import (
	"context"
	"testing"

	"github.com/vmware/govmomi/vim25/mo"
)

func TestPrivateNetwork(t *testing.T) {
	e := setupVPX(t)
	ctx := context.Background()
	pgs, _ := retrieve[mo.DistributedVirtualPortgroup](ctx, e.c, "DistributedVirtualPortgroup", []string{"name", "config.uplink"})
	var ref string
	for _, p := range pgs {
		if p.Config.Uplink == nil || !*p.Config.Uplink {
			ref = p.Self.Value
		}
	}
	if ref == "" {
		t.Fatal("no distributed port group in the simulator")
	}
	if _, err := createPortgroup(ctx, e.c, PortgroupRequest{Reference: ref, Name: "net-x", VLAN: 100}); err == nil {
		t.Fatal("an unmanaged name was accepted")
	}
	r, err := createPortgroup(ctx, e.c, PortgroupRequest{Reference: ref, Name: "lvm-net-1", VLAN: 101})
	if err != nil {
		t.Fatal(err)
	}
	pg := r.(map[string]any)["portgroup"].(string)
	if pg == "" {
		t.Fatal("no port group returned")
	}
	again, _ := createPortgroup(ctx, e.c, PortgroupRequest{Reference: ref, Name: "lvm-net-1", VLAN: 101})
	if again.(map[string]any)["portgroup"] != pg {
		t.Fatal("a retry made a second port group")
	}
	out, err := cloneVM(ctx, testGuard(), CloneRequest{Request: e.req, Name: "lvm-pn", Template: e.template, Pool: e.pool, Datastore: e.store,
		Network: e.network, VCPU: 1, MemoryMB: 1024, DiskGB: 10, Metadata: metadata, ServerID: "pn"})
	if err != nil {
		t.Fatal(err)
	}
	vm := waitTask(t, e, out["task"].(string)).VM
	a, err := addNic(ctx, e.c, PortgroupRequest{VM: vm, Portgroup: pg})
	if err != nil {
		t.Fatal(err)
	}
	if s := waitTask(t, e, a.(map[string]any)["task"].(string)); s.State != "success" {
		t.Fatalf("nic add: %+v", s)
	}
	if m, _ := nicMac(ctx, e.c, PortgroupRequest{VM: vm, Portgroup: pg}); m.(map[string]any)["mac"] == "" {
		t.Fatal("the new NIC has no MAC")
	}
	if twice, _ := addNic(ctx, e.c, PortgroupRequest{VM: vm, Portgroup: pg}); twice.(map[string]any)["task"] != "" {
		t.Fatal("a second NIC on the same network")
	}
	rm, err := removeNic(ctx, e.c, PortgroupRequest{VM: vm, Portgroup: pg})
	if err != nil {
		t.Fatal(err)
	}
	waitTask(t, e, rm.(map[string]any)["task"].(string))
	if m, _ := nicMac(ctx, e.c, PortgroupRequest{VM: vm, Portgroup: pg}); m.(map[string]any)["mac"] != "" {
		t.Fatal("the NIC is still there")
	}
	if _, err := deletePortgroup(ctx, e.c, PortgroupRequest{Portgroup: pg}); err != nil {
		t.Fatal(err)
	}
	if moref, _ := portgroupNamed(ctx, e.c, "lvm-net-1"); moref != "" {
		t.Fatal("the port group is still there")
	}
}
