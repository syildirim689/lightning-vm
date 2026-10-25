package main

import (
	"context"
	"time"

	"github.com/vmware/govmomi/object"
	"github.com/vmware/govmomi/vim25"
	"github.com/vmware/govmomi/vim25/methods"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

// SnapshotRequest: list a VM's snapshots, or create (Name, Description), revert to or remove (Snapshot moref) one.
type SnapshotRequest struct {
	Request
	VM          string `json:"vm"`
	Snapshot    string `json:"snapshot"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Action      string `json:"action"`
}

type Snapshot struct {
	ID          string    `json:"id"`
	Name        string    `json:"name"`
	Description string    `json:"description"`
	Created     time.Time `json:"created"`
	PowerState  string    `json:"powerState"`
	Current     bool      `json:"current"`
	Parent      string    `json:"parent"`
}

// listSnapshots flattens the VM's snapshot tree, parents before children.
func listSnapshots(ctx context.Context, c *vim25.Client, vmRef string) ([]Snapshot, error) {
	ref := types.ManagedObjectReference{Type: "VirtualMachine", Value: vmRef}
	var v mo.VirtualMachine
	if err := object.NewVirtualMachine(c, ref).Properties(ctx, ref, []string{"snapshot"}, &v); err != nil {
		return nil, err
	}
	out := []Snapshot{}
	if v.Snapshot == nil {
		return out, nil
	}
	var walk func(list []types.VirtualMachineSnapshotTree, parent string)
	walk = func(list []types.VirtualMachineSnapshotTree, parent string) {
		for _, s := range list {
			out = append(out, Snapshot{ID: s.Snapshot.Value, Name: s.Name, Description: s.Description, Created: s.CreateTime, PowerState: string(s.State),
				Current: v.Snapshot.CurrentSnapshot != nil && v.Snapshot.CurrentSnapshot.Value == s.Snapshot.Value, Parent: parent})
			walk(s.ChildSnapshotList, s.Snapshot.Value)
		}
	}
	walk(v.Snapshot.RootSnapshotList, "")
	return out, nil
}

// snapshotAction starts the task and returns its id; revert and remove act only on a snapshot of this VM.
// Snapshots are taken without memory and without quiescing, so they work without VMware Tools.
func snapshotAction(ctx context.Context, c *vim25.Client, r SnapshotRequest) (any, error) {
	vm := object.NewVirtualMachine(c, types.ManagedObjectReference{Type: "VirtualMachine", Value: r.VM})
	if r.Action == "create" {
		if r.Name == "" || len(r.Name) > 80 || len(r.Description) > 500 {
			return nil, &Failure{Code: "INVALID_REQUEST", Message: "name 1-80, description up to 500 characters"}
		}
		task, err := vm.CreateSnapshot(ctx, r.Name, r.Description, false, false)
		if err != nil {
			return nil, err
		}
		return map[string]any{"task": task.Reference().Value}, nil
	}
	list, err := listSnapshots(ctx, c, r.VM)
	if err != nil {
		return nil, err
	}
	found := false
	for _, s := range list {
		found = found || s.ID == r.Snapshot
	}
	if !found {
		return nil, &Failure{Code: "SNAPSHOT_NOT_FOUND", Message: "no such snapshot on this VM"}
	}
	snap := types.ManagedObjectReference{Type: "VirtualMachineSnapshot", Value: r.Snapshot}
	var task types.ManagedObjectReference
	switch r.Action {
	case "revert":
		res, err := methods.RevertToSnapshot_Task(ctx, c, &types.RevertToSnapshot_Task{This: snap, SuppressPowerOn: types.NewBool(true)})
		if err != nil {
			return nil, err
		}
		task = res.Returnval
	case "remove":
		res, err := methods.RemoveSnapshot_Task(ctx, c, &types.RemoveSnapshot_Task{This: snap, RemoveChildren: false, Consolidate: types.NewBool(true)})
		if err != nil {
			return nil, err
		}
		task = res.Returnval
	default:
		return nil, &Failure{Code: "INVALID_REQUEST", Message: "action must be create, revert or remove"}
	}
	return map[string]any{"task": task.Value}, nil
}
