package main

import (
	"context"
	"testing"

	"github.com/vmware/govmomi/object"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

func TestResize(t *testing.T) {
	e := setupVPX(t)
	ctx := context.Background()
	out, err := cloneVM(ctx, testGuard(), CloneRequest{Request: e.req, Name: "lvm-resize", Template: e.template, Pool: e.pool, Datastore: e.store,
		Network: e.network, VCPU: 1, MemoryMB: 1024, DiskGB: 10, Metadata: metadata, ServerID: "resize"})
	if err != nil {
		t.Fatal(err)
	}
	vm := waitTask(t, e, out["task"].(string)).VM
	if _, err := resizeVM(ctx, e.c, ResizeRequest{VM: vm, VCPU: 2, MemoryMB: 2048, DiskGB: 5}); err == nil || err.(*Failure).Code != "DISK_SHRINK_NOT_SUPPORTED" {
		t.Fatalf("shrink: %v", err)
	}
	r, err := resizeVM(ctx, e.c, ResizeRequest{VM: vm, VCPU: 2, MemoryMB: 2048, DiskGB: 20})
	if err != nil {
		t.Fatal(err)
	}
	if s := waitTask(t, e, r.(map[string]any)["task"].(string)); s.State != "success" {
		t.Fatalf("resize: %+v", s)
	}
	ref := types.ManagedObjectReference{Type: "VirtualMachine", Value: vm}
	var v mo.VirtualMachine
	if err := object.NewVirtualMachine(e.c, ref).Properties(ctx, ref, []string{"config"}, &v); err != nil {
		t.Fatal(err)
	}
	disk := object.VirtualDeviceList(v.Config.Hardware.Device).SelectByType((*types.VirtualDisk)(nil))[0].(*types.VirtualDisk)
	if v.Config.Hardware.NumCPU != 2 || v.Config.Hardware.MemoryMB != 2048 || disk.CapacityInBytes != 20<<30 {
		t.Fatalf("after resize: cpu %d mem %d disk %d", v.Config.Hardware.NumCPU, v.Config.Hardware.MemoryMB, disk.CapacityInBytes)
	}
	s, err := snapshotAction(ctx, e.c, SnapshotRequest{VM: vm, Action: "create", Name: "keep"})
	if err != nil {
		t.Fatal(err)
	}
	waitTask(t, e, s.(map[string]any)["task"].(string))
	if _, err := resizeVM(ctx, e.c, ResizeRequest{VM: vm, VCPU: 2, MemoryMB: 2048, DiskGB: 30}); err == nil || err.(*Failure).Code != "DISK_HAS_SNAPSHOTS" {
		t.Fatalf("grow with snapshots: %v", err)
	}
}

func TestRenameForImport(t *testing.T) {
	e := setupVPX(t)
	ctx := context.Background()
	out, err := cloneVM(ctx, testGuard(), CloneRequest{Request: e.req, Name: "lvm-tmp-import", Template: e.template, Pool: e.pool, Datastore: e.store,
		Network: e.network, VCPU: 1, MemoryMB: 1024, DiskGB: 12, Metadata: metadata, ServerID: "imp"})
	if err != nil {
		t.Fatal(err)
	}
	vm := waitTask(t, e, out["task"].(string)).VM
	if _, err := renameVM(ctx, e.c, RenameRequest{VM: vm, Name: "lvm-x"}); err == nil || err.(*Failure).Code != "NOT_IMPORTABLE" {
		t.Fatalf("a managed VM was taken over: %v", err)
	}
	// As if it had been made outside the panel.
	task, err := object.NewVirtualMachine(e.c, types.ManagedObjectReference{Type: "VirtualMachine", Value: vm}).Rename(ctx, "customer-web")
	if err != nil || task.Wait(ctx) != nil {
		t.Fatal(err)
	}
	if _, err := renameVM(ctx, e.c, RenameRequest{VM: vm, Name: "web"}); err == nil {
		t.Fatal("an unmanaged name was accepted")
	}
	r, err := renameVM(ctx, e.c, RenameRequest{VM: vm, Name: "lvm-imported"})
	if err != nil {
		t.Fatal(err)
	}
	if got := r.(map[string]any); got["diskGb"].(int64) != 12 {
		t.Fatalf("disk: %+v", got)
	}
	if st, _ := findVM(ctx, e.c, "lvm-imported"); st == nil {
		t.Fatal("not found under the managed name")
	}
	if _, err := renameVM(ctx, e.c, RenameRequest{VM: vm, Name: "lvm-imported"}); err != nil {
		t.Fatalf("a retry failed: %v", err)
	}
}

func TestCloneFromServer(t *testing.T) {
	e := setupVPX(t)
	ctx := context.Background()
	out, err := cloneVM(ctx, testGuard(), CloneRequest{Request: e.req, Name: "lvm-orig", Template: e.template, Pool: e.pool, Datastore: e.store,
		Network: e.network, VCPU: 1, MemoryMB: 1024, DiskGB: 20, Metadata: metadata, ServerID: "orig"})
	if err != nil {
		t.Fatal(err)
	}
	vm := waitTask(t, e, out["task"].(string)).VM
	if _, err := powerAction(ctx, e.c, VMRequest{VM: vm, Action: "on"}); err != nil {
		t.Fatal(err)
	}
	copyOut, err := cloneVM(ctx, testGuard(), CloneRequest{Request: e.req, Name: "lvm-copy", Template: vm, Pool: e.pool, Datastore: e.store,
		Network: e.network, VCPU: 1, MemoryMB: 1024, DiskGB: 20, Metadata: metadata, ServerID: "copy"})
	if err != nil {
		t.Fatal(err)
	}
	if s := waitTask(t, e, copyOut["task"].(string)); s.State != "success" || s.VM == "" {
		t.Fatalf("clone of a running server: %+v", s)
	}
}
