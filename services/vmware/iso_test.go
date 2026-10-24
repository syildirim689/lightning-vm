package main

import (
	"context"
	"strings"
	"testing"

	"github.com/vmware/govmomi/object"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

func TestISOUploadMountEjectDelete(t *testing.T) {
	e := setupVPX(t)
	ctx := context.Background()
	data := "fake iso content"
	if _, err := uploadISO(ctx, e.c, FileRequest{Datastore: e.store, Name: "../evil.iso"}, strings.NewReader(data), int64(len(data))); classify(err).Code != "INVALID_REQUEST" {
		t.Fatalf("a path in the name must be refused, got %v", err)
	}
	out, err := uploadISO(ctx, e.c, FileRequest{Datastore: e.store, Name: "ubuntu-24.04.iso"}, strings.NewReader(data), int64(len(data)))
	if err != nil {
		t.Fatal(err)
	}
	if p := out.(map[string]any)["path"].(string); !strings.HasSuffix(p, "] lightning-iso/ubuntu-24.04.iso") {
		t.Fatalf("unexpected path %q", p)
	}
	// Uploading the same name again replaces the file (the directory already exists).
	if _, err := uploadISO(ctx, e.c, FileRequest{Datastore: e.store, Name: "ubuntu-24.04.iso"}, strings.NewReader(data), int64(len(data))); err != nil {
		t.Fatal(err)
	}

	c, err := cloneVM(ctx, testGuard(), CloneRequest{Request: e.req, Name: "lvm-iso", Template: e.template, Pool: e.pool, Datastore: e.store,
		Network: e.network, VCPU: 1, MemoryMB: 1024, DiskGB: 10, Metadata: metadata, ServerID: "iso"})
	if err != nil {
		t.Fatal(err)
	}
	vm := waitTask(t, e, c["task"].(string)).VM
	backing := func() string {
		devices, err := object.NewVirtualMachine(e.c, types.ManagedObjectReference{Type: "VirtualMachine", Value: vm}).Device(ctx)
		if err != nil {
			t.Fatal(err)
		}
		cds := devices.SelectByType((*types.VirtualCdrom)(nil))
		if len(cds) == 0 {
			return "<none>"
		}
		if b, ok := cds[0].GetVirtualDevice().Backing.(*types.VirtualCdromIsoBackingInfo); ok {
			return b.FileName
		}
		return ""
	}
	bootOrder := func() int {
		var v mo.VirtualMachine
		if err := object.NewVirtualMachine(e.c, types.ManagedObjectReference{Type: "VirtualMachine", Value: vm}).Properties(ctx, types.ManagedObjectReference{Type: "VirtualMachine", Value: vm}, []string{"config.bootOptions"}, &v); err != nil {
			t.Fatal(err)
		}
		if v.Config.BootOptions == nil {
			return 0
		}
		return len(v.Config.BootOptions.BootOrder)
	}
	if _, err := setCdrom(ctx, e.c, CdromRequest{VM: vm, Datastore: e.store, Name: "ubuntu-24.04.iso", Boot: true}); err != nil {
		t.Fatal(err)
	}
	if b := backing(); !strings.HasSuffix(b, "lightning-iso/ubuntu-24.04.iso") {
		t.Fatalf("ISO not inserted: %q", b)
	}
	if n := bootOrder(); n != 2 {
		t.Fatalf("boot order should be CD-ROM then disk, got %d entries", n)
	}
	if _, err := setCdrom(ctx, e.c, CdromRequest{VM: vm}); err != nil {
		t.Fatal(err)
	}
	if b := backing(); strings.Contains(b, ".iso") {
		t.Fatalf("ISO not ejected: %q", b)
	}
	if n := bootOrder(); n != 0 {
		t.Fatalf("ejecting must restore the default boot order, got %d entries", n)
	}
	unmanaged, _ := vmStates(ctx, e.c, func(n string) bool { return !strings.HasPrefix(n, managedPrefix) })
	if _, err := setCdrom(ctx, e.c, CdromRequest{VM: unmanaged[0].MoRef}); classify(err).Code != "NOT_MANAGED" {
		t.Fatalf("an unmanaged VM must be refused, got %v", err)
	}
	if _, err := deleteISO(ctx, e.c, FileRequest{Datastore: e.store, Name: "ubuntu-24.04.iso"}); err != nil {
		t.Fatal(err)
	}
	if _, err := deleteISO(ctx, e.c, FileRequest{Datastore: e.store, Name: "ubuntu-24.04.iso"}); err != nil {
		t.Fatalf("deleting a missing file is not an error: %v", err)
	}
}
