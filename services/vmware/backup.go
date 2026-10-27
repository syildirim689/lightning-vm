package main

import (
	"context"
	"regexp"
	"strings"

	"github.com/vmware/govmomi/fault"
	"github.com/vmware/govmomi/object"
	"github.com/vmware/govmomi/vim25"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

// Backups without a backup product: the panel takes a snapshot (so the base disk stops changing), copies the base
// disk to a backup datastore with the VirtualDiskManager, then removes the snapshot. A restore copies a backup over the
// VM's disk while it is off and has no snapshots. Backups live under lightning-backups/<server id>/<backup id>.vmdk.

const backupFolder = "lightning-backups"

var backupName = regexp.MustCompile(`^[0-9a-f-]{36}/[0-9a-f-]{36}\.vmdk$`) // <server id>/<backup id>.vmdk

type DiskCopyRequest struct {
	Request
	VM        string `json:"vm"`
	Datastore string `json:"datastore"` // the backup datastore
	Name      string `json:"name"`      // <server id>/<backup id>.vmdk under the backup folder
	Direction string `json:"direction"` // "backup" (VM disk → backup) or "restore" (backup → VM disk)
}

// baseDisk is the file of the VM's first disk without its snapshot deltas, and the datacenter it is in.
func baseDisk(ctx context.Context, c *vim25.Client, vmRef string) (string, *types.VirtualDisk, mo.VirtualMachine, error) {
	ref := types.ManagedObjectReference{Type: "VirtualMachine", Value: vmRef}
	var v mo.VirtualMachine
	if err := object.NewVirtualMachine(c, ref).Properties(ctx, ref, []string{"name", "snapshot", "runtime.powerState", "config.hardware.device"}, &v); err != nil {
		return "", nil, v, err
	}
	if !strings.HasPrefix(v.Name, managedPrefix) {
		return "", nil, v, &Failure{Code: "NOT_MANAGED", Message: "refusing to touch a VM this platform did not create"}
	}
	disks := object.VirtualDeviceList(v.Config.Hardware.Device).SelectByType((*types.VirtualDisk)(nil))
	if len(disks) == 0 {
		return "", nil, v, &Failure{Code: "VM_HAS_NO_DISK", Message: "the VM has no disk"}
	}
	d := disks[0].(*types.VirtualDisk)
	b, ok := d.Backing.(*types.VirtualDiskFlatVer2BackingInfo)
	if !ok {
		return "", nil, v, &Failure{Code: "DISK_NOT_SUPPORTED", Message: "only flat virtual disks can be backed up"}
	}
	for b.Parent != nil { // a snapshot's delta points back to the base
		b = b.Parent
	}
	return b.FileName, d, v, nil
}

func copyDisk(ctx context.Context, c *vim25.Client, r DiskCopyRequest) (any, error) {
	if !backupName.MatchString(r.Name) || (r.Direction != "backup" && r.Direction != "restore") {
		return nil, &Failure{Code: "INVALID_REQUEST", Message: "name and direction are required"}
	}
	ds, dc, err := datastoreOf(ctx, c, r.Datastore)
	if err != nil {
		return nil, err
	}
	disk, _, v, err := baseDisk(ctx, c, r.VM)
	if err != nil {
		return nil, err
	}
	backup := ds.Path(backupFolder + "/" + r.Name)
	vdm := object.NewVirtualDiskManager(c)
	var task *object.Task
	if r.Direction == "backup" {
		if v.Snapshot == nil || len(v.Snapshot.RootSnapshotList) == 0 {
			return nil, &Failure{Code: "INVALID_STATE", Message: "take the backup snapshot first, so the disk does not change while it is copied"}
		}
		folder := ds.Path(backupFolder + "/" + strings.Split(r.Name, "/")[0])
		if err := object.NewFileManager(c).MakeDirectory(ctx, folder, dc, true); err != nil && !fault.Is(err, &types.FileAlreadyExists{}) {
			return nil, err
		}
		task, err = vdm.CopyVirtualDisk(ctx, disk, dc, backup, dc, &types.VirtualDiskSpec{DiskType: string(types.VirtualDiskTypeThin), AdapterType: string(types.VirtualDiskAdapterTypeLsiLogic)}, true)
	} else {
		if v.Runtime.PowerState != types.VirtualMachinePowerStatePoweredOff {
			return nil, &Failure{Code: "INVALID_STATE", Message: "the VM must be off to restore its disk"}
		}
		if v.Snapshot != nil && len(v.Snapshot.RootSnapshotList) > 0 {
			return nil, &Failure{Code: "DISK_HAS_SNAPSHOTS", Message: "remove the snapshots before restoring a backup"}
		}
		task, err = vdm.CopyVirtualDisk(ctx, backup, dc, disk, dc, nil, true)
	}
	if err != nil {
		return nil, err
	}
	return map[string]any{"task": task.Reference().Value}, nil
}

// deleteBackup removes one backup disk (the descriptor and its data file); one already gone is fine.
func deleteBackup(ctx context.Context, c *vim25.Client, r DiskCopyRequest) (any, error) {
	if !backupName.MatchString(r.Name) {
		return nil, &Failure{Code: "INVALID_REQUEST", Message: "invalid backup name"}
	}
	ds, dc, err := datastoreOf(ctx, c, r.Datastore)
	if err != nil {
		return nil, err
	}
	task, err := object.NewVirtualDiskManager(c).DeleteVirtualDisk(ctx, ds.Path(backupFolder+"/"+r.Name), dc)
	if err == nil {
		err = task.Wait(ctx)
	}
	if err != nil && !fault.Is(err, &types.FileNotFound{}) {
		return nil, err
	}
	return map[string]any{}, nil
}
