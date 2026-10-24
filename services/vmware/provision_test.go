package main

import (
	"context"
	"encoding/base64"
	"strings"
	"testing"
	"time"

	"github.com/vmware/govmomi/object"
	"github.com/vmware/govmomi/simulator"
	"github.com/vmware/govmomi/vim25"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

// Against govmomi's simulator (vCenter model): proves the provisioning logic, including
// cloud-init customization as the simulator implements it, not behaviour of real vCenter.

type simEnv struct {
	req                            Request
	c                              *vim25.Client
	template, pool, store, network string
}

func setupVPX(t *testing.T) simEnv {
	host, port, srv := startSim(t, simulator.VPX())
	req := Request{Host: host, Port: port, Username: "user", Password: "pass", TLS: TLSSettings{Mode: "pinned", SHA256: fingerprint(srv.Certificate().Raw)}}
	ctx := context.Background()
	c, sm, err := connect(ctx, testGuard(), req)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { sm.Logout(context.Background()) })
	vms, _ := retrieve[mo.VirtualMachine](ctx, c, "VirtualMachine", []string{"name", "resourcePool", "datastore", "network"})
	tpl := vms[0]
	vm := object.NewVirtualMachine(c, tpl.Self)
	if task, err := vm.PowerOff(ctx); err == nil {
		_ = task.Wait(ctx)
	}
	if err := vm.MarkAsTemplate(ctx); err != nil {
		t.Fatal(err)
	}
	return simEnv{req: req, c: c, template: tpl.Self.Value, pool: tpl.ResourcePool.Value, store: tpl.Datastore[0].Value, network: tpl.Network[0].Value}
}

func waitTask(t *testing.T, e simEnv, task string) *TaskState {
	for i := 0; i < 100; i++ {
		s, err := taskState(context.Background(), e.c, task)
		if err != nil {
			t.Fatal(err)
		}
		if s.State == "success" || s.State == "error" {
			return s
		}
		time.Sleep(50 * time.Millisecond)
	}
	t.Fatal("task did not finish")
	return nil
}

const metadata = `instance-id: s1
local-hostname: web1
network:
  version: 2
  ethernets:
    nic0:
      addresses: [10.20.0.10/24]
      nameservers:
        addresses: [10.20.0.53]
`

func TestCloneIsIdempotentAndCustomizesTheGuest(t *testing.T) {
	e := setupVPX(t)
	ctx := context.Background()
	r := CloneRequest{Request: e.req, Name: "lvm-s1", Template: e.template, Pool: e.pool, Datastore: e.store, Network: e.network,
		VCPU: 2, MemoryMB: 2048, DiskGB: 40, Metadata: metadata, Userdata: "#cloud-config\n", ServerID: "s1"}
	out, err := cloneVM(ctx, testGuard(), r)
	if err != nil {
		t.Fatal(err)
	}
	done := waitTask(t, e, out["task"].(string))
	if done.State != "success" || done.VM == "" {
		t.Fatalf("clone failed: %+v", done)
	}
	// A retry (for example after a network timeout) finds the VM instead of cloning again.
	again, err := cloneVM(ctx, testGuard(), r)
	if err != nil || again["existed"] != true || again["vm"] != done.VM {
		t.Fatalf("retry must return the existing VM: %+v %v", again, err)
	}
	all, _ := vmStates(ctx, e.c, func(n string) bool { return n == "lvm-s1" })
	if len(all) != 1 || all[0].ServerID != "s1" {
		t.Fatalf("want exactly one tagged VM, got %+v", all)
	}

	var cfg mo.VirtualMachine
	_ = object.NewVirtualMachine(e.c, types.ManagedObjectReference{Type: "VirtualMachine", Value: done.VM}).Properties(ctx,
		types.ManagedObjectReference{Type: "VirtualMachine", Value: done.VM}, []string{"config.hardware"}, &cfg)
	if cfg.Config.Hardware.NumCPU != 2 || cfg.Config.Hardware.MemoryMB != 2048 {
		t.Fatalf("shape not applied: %d vCPU %d MB", cfg.Config.Hardware.NumCPU, cfg.Config.Hardware.MemoryMB)
	}

	if _, err := powerAction(ctx, e.c, VMRequest{VM: done.VM, Action: "on"}); err != nil {
		t.Fatal(err)
	}
	var st *VMState
	for i := 0; i < 50; i++ {
		st, _ = findVM(ctx, e.c, "lvm-s1")
		if st != nil && st.PowerState == "poweredOn" && strings.Contains(strings.Join(st.IPs, ","), "10.20.0.10") {
			break
		}
		time.Sleep(100 * time.Millisecond)
	}
	if st == nil || st.PowerState != "poweredOn" || !strings.Contains(strings.Join(st.IPs, ","), "10.20.0.10") {
		t.Fatalf("guest did not report the cloud-init address: %+v", st)
	}
}

func TestDestroyOnlyTouchesManagedVMs(t *testing.T) {
	e := setupVPX(t)
	ctx := context.Background()
	vms, _ := vmStates(ctx, e.c, func(n string) bool { return !strings.HasPrefix(n, managedPrefix) })
	if _, err := destroyVM(ctx, e.c, VMRequest{VM: vms[0].MoRef}); classify(err).Code != "NOT_MANAGED" {
		t.Fatalf("an unmanaged VM must be refused, got %v", err)
	}
	out, err := cloneVM(ctx, testGuard(), CloneRequest{Request: e.req, Name: "lvm-s2", Template: e.template, Pool: e.pool, Datastore: e.store,
		Network: e.network, VCPU: 1, MemoryMB: 1024, DiskGB: 10, Metadata: metadata, ServerID: "s2"})
	if err != nil {
		t.Fatal(err)
	}
	vm := waitTask(t, e, out["task"].(string)).VM
	_, _ = powerAction(ctx, e.c, VMRequest{VM: vm, Action: "on"})
	d, err := destroyVM(ctx, e.c, VMRequest{VM: vm})
	if err != nil {
		t.Fatal(err)
	}
	if s := waitTask(t, e, d.(map[string]any)["task"].(string)); s.State != "success" {
		t.Fatalf("destroy failed: %+v", s)
	}
	if found, _ := findVM(ctx, e.c, "lvm-s2"); found != nil {
		t.Fatal("VM still exists")
	}
	if again, _ := destroyVM(ctx, e.c, VMRequest{VM: vm}); again.(map[string]any)["gone"] != true {
		t.Fatal("deleting an already deleted VM must report it as gone")
	}
}

func TestStandaloneESXiCannotClone(t *testing.T) {
	host, port, srv := startSim(t, simulator.ESX())
	_, err := cloneVM(context.Background(), testGuard(), CloneRequest{Request: Request{Host: host, Port: port, Username: "u", Password: "p",
		TLS: TLSSettings{Mode: "pinned", SHA256: fingerprint(srv.Certificate().Raw)}}, Name: "lvm-x", Template: "vm-1", Pool: "p", Datastore: "d", Network: "n"})
	if classify(err).Code != "PROVISIONING_NOT_SUPPORTED" {
		t.Fatalf("got %v", err)
	}
}

// Before vCenter 7.0U3 there is no native cloud-init customization: the same metadata and user data go
// into guestinfo.* extraConfig for cloud-init's VMware datasource, and no customization spec is sent.
func TestCloneWithGuestinfo(t *testing.T) {
	e := setupVPX(t)
	ctx := context.Background()
	out, err := cloneVM(ctx, testGuard(), CloneRequest{Request: e.req, Name: "lvm-s3", Template: e.template, Pool: e.pool, Datastore: e.store, Network: e.network,
		VCPU: 1, MemoryMB: 1024, DiskGB: 10, Metadata: metadata, Userdata: "#cloud-config\n", ServerID: "s3", Customization: "guestinfo"})
	if err != nil {
		t.Fatal(err)
	}
	done := waitTask(t, e, out["task"].(string))
	if done.State != "success" {
		t.Fatalf("clone failed: %+v", done)
	}
	var cfg mo.VirtualMachine
	ref := types.ManagedObjectReference{Type: "VirtualMachine", Value: done.VM}
	_ = object.NewVirtualMachine(e.c, ref).Properties(ctx, ref, []string{"config.extraConfig"}, &cfg)
	got := map[string]string{}
	for _, o := range cfg.Config.ExtraConfig {
		kv := o.GetOptionValue()
		got[kv.Key], _ = kv.Value.(string)
	}
	raw, _ := base64.StdEncoding.DecodeString(got["guestinfo.metadata"])
	if string(raw) != metadata || got["guestinfo.metadata.encoding"] != "base64" || got["guestinfo.userdata.encoding"] != "base64" || got["lightning.server-id"] != "s3" {
		t.Fatalf("guestinfo not set: %v", got)
	}
}

func TestCloneApplianceWithHardwareOptions(t *testing.T) {
	e := setupVPX(t)
	ctx := context.Background()
	// A nested-ESXi-like template: its settings are vApp (OVF) properties.
	tpl := object.NewVirtualMachine(e.c, types.ManagedObjectReference{Type: "VirtualMachine", Value: e.template})
	// Templates cannot be reconfigured: back to a VM, add the properties, template again.
	if err := tpl.MarkAsVirtualMachine(ctx, *object.NewResourcePool(e.c, types.ManagedObjectReference{Type: "ResourcePool", Value: e.pool}), nil); err != nil {
		t.Fatal(err)
	}
	task, err := tpl.Reconfigure(ctx, types.VirtualMachineConfigSpec{VAppConfig: &types.VmConfigSpec{Property: []types.VAppPropertySpec{
		{ArrayUpdateSpec: types.ArrayUpdateSpec{Operation: types.ArrayUpdateOperationAdd}, Info: &types.VAppPropertyInfo{Key: 1, Id: "guestinfo.hostname", Type: "string"}},
		{ArrayUpdateSpec: types.ArrayUpdateSpec{Operation: types.ArrayUpdateOperationAdd}, Info: &types.VAppPropertyInfo{Key: 2, Id: "guestinfo.password", Type: "password"}},
	}}})
	if err == nil {
		err = task.Wait(ctx)
	}
	if err == nil {
		err = tpl.MarkAsTemplate(ctx)
	}
	if err != nil {
		t.Fatal(err)
	}
	out, err := cloneVM(ctx, testGuard(), CloneRequest{Request: e.req, Name: "lvm-esx", Template: e.template, Pool: e.pool, Datastore: e.store, Network: e.network,
		VCPU: 2, MemoryMB: 8192, DiskGB: 10, ServerID: "esx", Customization: "appliance", CPUHotAdd: true, MemoryHotAdd: true, NestedHV: true,
		VAppProperties: map[string]string{"guestinfo.hostname": "esx1.lab", "guestinfo.password": "Secret-1", "not.a.property": "x"}})
	if err != nil {
		t.Fatal(err)
	}
	vm := waitTask(t, e, out["task"].(string)).VM
	var v mo.VirtualMachine
	if err := object.NewVirtualMachine(e.c, types.ManagedObjectReference{Type: "VirtualMachine", Value: vm}).Properties(ctx,
		types.ManagedObjectReference{Type: "VirtualMachine", Value: vm}, []string{"config"}, &v); err != nil {
		t.Fatal(err)
	}
	// The simulator does not apply the hardware flags on clone; the spec is checked directly.
	cfg, cust := cloneConfig(CloneRequest{CPUHotAdd: true, MemoryHotAdd: true, NestedHV: true, Customization: "appliance"}, nil)
	if !*cfg.NestedHVEnabled || !*cfg.CpuHotAddEnabled || !*cfg.MemoryHotAddEnabled || cust != nil {
		t.Fatalf("hardware options or customization wrong: %+v %+v", cfg, cust)
	}
	if cfg, cust := cloneConfig(CloneRequest{}, nil); *cfg.NestedHVEnabled || cust == nil {
		t.Fatal("defaults: no nested virtualization, vCenter cloud-init customization")
	}
	got := map[string]string{}
	for _, o := range v.Config.ExtraConfig {
		if ov := o.GetOptionValue(); strings.HasPrefix(ov.Key, "guestinfo.") {
			got[ov.Key] = ov.Value.(string)
		}
	}
	if got["guestinfo.hostname"] != "esx1.lab" || got["guestinfo.password"] != "Secret-1" || got["guestinfo.metadata"] != "" {
		t.Fatalf("appliance extraConfig: %v", got)
	}
	if v.Config.VAppConfig != nil {
		for _, p := range v.Config.VAppConfig.GetVmConfigInfo().Property {
			if p.Id == "guestinfo.hostname" && p.Value != "esx1.lab" {
				t.Fatalf("vApp property not set: %+v", p)
			}
		}
	}
}
