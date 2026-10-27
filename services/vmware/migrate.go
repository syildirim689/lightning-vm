package main

import (
	"context"
	"strings"

	"github.com/vmware/govmomi/object"
	"github.com/vmware/govmomi/vim25"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

// MigrateRequest: move a running or stopped VM to another host (vMotion) and/or datastore (Storage vMotion).
// At least one target is needed; the VM keeps its resource pool.
type MigrateRequest struct {
	Request
	VM        string `json:"vm"`
	Host      string `json:"host"`
	Datastore string `json:"datastore"`
}

func migrateVM(ctx context.Context, c *vim25.Client, r MigrateRequest) (any, error) {
	if r.Host == "" && r.Datastore == "" {
		return nil, &Failure{Code: "INVALID_REQUEST", Message: "a host or a datastore is required"}
	}
	ref := types.ManagedObjectReference{Type: "VirtualMachine", Value: r.VM}
	vm := object.NewVirtualMachine(c, ref)
	var v mo.VirtualMachine
	if err := vm.Properties(ctx, ref, []string{"name", "resourcePool", "runtime.host"}, &v); err != nil {
		return nil, err
	}
	if !strings.HasPrefix(v.Name, managedPrefix) {
		return nil, &Failure{Code: "NOT_MANAGED", Message: "refusing to move a VM this platform did not create"}
	}
	spec := types.VirtualMachineRelocateSpec{Pool: v.ResourcePool}
	if r.Host != "" {
		if v.Runtime.Host != nil && v.Runtime.Host.Value == r.Host && r.Datastore == "" {
			return map[string]any{"task": "", "already": true}, nil
		}
		h := types.ManagedObjectReference{Type: "HostSystem", Value: r.Host}
		spec.Host = &h
	}
	if r.Datastore != "" {
		d := types.ManagedObjectReference{Type: "Datastore", Value: r.Datastore}
		spec.Datastore = &d
	}
	task, err := vm.Relocate(ctx, spec, types.VirtualMachineMovePriorityDefaultPriority)
	if err != nil {
		return nil, err
	}
	return map[string]any{"task": task.Reference().Value}, nil
}
