package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"time"

	"github.com/vmware/govmomi/fault"
	"github.com/vmware/govmomi/object"
	"github.com/vmware/govmomi/property"
	"github.com/vmware/govmomi/vim25"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/soap"
	"github.com/vmware/govmomi/vim25/types"
)

// ISO library: files streamed into a datastore folder, and a VM's CD-ROM pointed at one of them.

const isoFolder = "lightning-iso"

var isoName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._-]{0,150}\.iso$`)

type FileRequest struct {
	Request
	Datastore string `json:"datastore"` // datastore moref
	Name      string `json:"name"`      // file name inside the ISO folder
}

type CdromRequest struct {
	Request
	VM        string `json:"vm"`
	Datastore string `json:"datastore"` // empty: eject
	Name      string `json:"name"`
	Boot      bool   `json:"boot"` // boot from the CD first (install or rescue); ejecting restores the default order
}

func datastoreOf(ctx context.Context, c *vim25.Client, moref string) (*object.Datastore, *object.Datacenter, error) {
	ref := types.ManagedObjectReference{Type: "Datastore", Value: moref}
	var d mo.Datastore
	if err := property.DefaultCollector(c).RetrieveOne(ctx, ref, []string{"name", "parent"}, &d); err != nil {
		if fault.Is(err, &types.ManagedObjectNotFound{}) {
			return nil, nil, &Failure{Code: "DATASTORE_NOT_FOUND", Message: "datastore not found"}
		}
		return nil, nil, err
	}
	// The datastore's datacenter: up through its folders (file URLs and FileManager calls need it).
	parent := d.Parent
	for parent != nil && parent.Type != "Datacenter" {
		var e mo.ManagedEntity
		if err := property.DefaultCollector(c).RetrieveOne(ctx, *parent, []string{"parent"}, &e); err != nil {
			return nil, nil, err
		}
		parent = e.Parent
	}
	if parent == nil {
		return nil, nil, &Failure{Code: "DATASTORE_NOT_FOUND", Message: "datastore has no datacenter"}
	}
	var dcm mo.Datacenter
	if err := property.DefaultCollector(c).RetrieveOne(ctx, *parent, []string{"name"}, &dcm); err != nil {
		return nil, nil, err
	}
	ds := object.NewDatastore(c, ref)
	ds.InventoryPath = "/" + dcm.Name + "/datastore/" + d.Name
	ds.DatacenterPath = "/" + dcm.Name
	return ds, object.NewDatacenter(c, *parent), nil
}

// uploadISO streams the request body (exactly size bytes) to "[datastore] lightning-iso/<name>".
func uploadISO(ctx context.Context, c *vim25.Client, r FileRequest, body io.Reader, size int64) (any, error) {
	if !isoName.MatchString(r.Name) {
		return nil, &Failure{Code: "INVALID_REQUEST", Message: "file name must end in .iso and use letters, digits, '.', '_' or '-'"}
	}
	ds, dc, err := datastoreOf(ctx, c, r.Datastore)
	if err != nil {
		return nil, err
	}
	if err := object.NewFileManager(c).MakeDirectory(ctx, ds.Path(isoFolder), dc, true); err != nil && !fault.Is(err, &types.FileAlreadyExists{}) {
		return nil, err
	}
	// Through vCenter's own /folder URL (no host service ticket): the panel may only reach vCenter.
	param := soap.DefaultUpload // PUT; a zero Upload would send a GET
	param.ContentLength = size
	if err := c.Client.Upload(ctx, body, ds.NewURL(isoFolder+"/"+r.Name), &param); err != nil {
		return nil, err
	}
	return map[string]any{"path": ds.Path(isoFolder + "/" + r.Name)}, nil
}

func deleteISO(ctx context.Context, c *vim25.Client, r FileRequest) (any, error) {
	if !isoName.MatchString(r.Name) {
		return nil, &Failure{Code: "INVALID_REQUEST", Message: "invalid file name"}
	}
	ds, dc, err := datastoreOf(ctx, c, r.Datastore)
	if err != nil {
		return nil, err
	}
	task, err := object.NewFileManager(c).DeleteDatastoreFile(ctx, ds.Path(isoFolder+"/"+r.Name), dc)
	if err == nil {
		err = task.Wait(ctx)
	}
	if err != nil && !fault.Is(err, &types.FileNotFound{}) {
		return nil, err
	}
	return map[string]any{}, nil
}

// setCdrom inserts an ISO into the VM's CD-ROM (adding a drive on the IDE controller if it has none) or ejects it.
func setCdrom(ctx context.Context, c *vim25.Client, r CdromRequest) (any, error) {
	vm := object.NewVirtualMachine(c, types.ManagedObjectReference{Type: "VirtualMachine", Value: r.VM})
	var v mo.VirtualMachine
	if err := vm.Properties(ctx, vm.Reference(), []string{"name"}, &v); err != nil {
		if fault.Is(err, &types.ManagedObjectNotFound{}) {
			return nil, &Failure{Code: "VM_NOT_FOUND", Message: "VM not found"}
		}
		return nil, err
	}
	if len(v.Name) < len(managedPrefix) || v.Name[:len(managedPrefix)] != managedPrefix {
		return nil, &Failure{Code: "NOT_MANAGED", Message: "refusing to change a VM this platform did not create"}
	}
	devices, err := vm.Device(ctx)
	if err != nil {
		return nil, err
	}
	var file string
	if r.Datastore != "" {
		if !isoName.MatchString(r.Name) {
			return nil, &Failure{Code: "INVALID_REQUEST", Message: "invalid file name"}
		}
		ds, _, err := datastoreOf(ctx, c, r.Datastore)
		if err != nil {
			return nil, err
		}
		file = ds.Path(isoFolder + "/" + r.Name)
	}
	cdroms := devices.SelectByType((*types.VirtualCdrom)(nil))
	switch {
	case len(cdroms) == 0 && file == "":
	case len(cdroms) == 0:
		ide, err := devices.FindIDEController("")
		if err != nil {
			return nil, &Failure{Code: "NO_CDROM_CONTROLLER", Message: "the VM has no free IDE slot for a CD-ROM drive"}
		}
		cd, err := devices.CreateCdrom(ide)
		if err != nil {
			return nil, err
		}
		err = vm.AddDevice(ctx, devices.InsertIso(cd, file))
		if err != nil {
			return nil, err
		}
	case file == "":
		err = vm.EditDevice(ctx, devices.EjectIso(cdroms[0].(*types.VirtualCdrom)))
	default:
		err = vm.EditDevice(ctx, devices.InsertIso(cdroms[0].(*types.VirtualCdrom), file))
	}
	if err != nil {
		return nil, err
	}
	// Boot order: CD-ROM, then disk while booting from the ISO; empty (VMware's default) otherwise.
	order := []types.BaseVirtualMachineBootOptionsBootableDevice{}
	if file != "" && r.Boot {
		order = append(order, &types.VirtualMachineBootOptionsBootableCdromDevice{}, &types.VirtualMachineBootOptionsBootableDiskDevice{})
	}
	if err := vm.SetBootOptions(ctx, &types.VirtualMachineBootOptions{BootOrder: order}); err != nil {
		return nil, err
	}
	return map[string]any{}, nil
}

// The upload is not JSON: the connection and target arrive base64-encoded in X-Upload, the file as the body.
func uploadHandler(guard *netGuard) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var req FileRequest
		raw, err := base64.StdEncoding.DecodeString(r.Header.Get("X-Upload"))
		if err != nil || json.Unmarshal(raw, &req) != nil || r.ContentLength <= 0 {
			writeJSON(w, 400, Failure{Code: "INVALID_REQUEST", Message: "X-Upload header and Content-Length are required"})
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), 12*time.Hour)
		defer cancel()
		start := time.Now()
		out, err := withClient(ctx, guard, req.Request, func(c *vim25.Client) (any, error) { return uploadISO(ctx, c, req, r.Body, r.ContentLength) })
		if err != nil {
			f := classify(err)
			logger.Warn("iso_upload_failed", "code", f.Code)
			writeJSON(w, failureStatus(f.Code), f)
			return
		}
		logger.Info("iso_uploaded", "bytes", strconv.FormatInt(r.ContentLength, 10), "duration_ms", time.Since(start).Milliseconds())
		writeJSON(w, 200, out)
	}
}
