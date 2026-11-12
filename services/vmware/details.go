package main

import (
	"context"
	"reflect"
	"sort"
	"strings"
	"time"

	"github.com/vmware/govmomi/property"
	"github.com/vmware/govmomi/vim25"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

// Everything vCenter/ESXi knows about one VM, read in one pass: identity, CPU and memory with their
// allocation, every NIC (MAC, adapter, network, distributed port, VLAN, guest addresses), every disk
// (size, datastore, provisioning, controller slot), CD drives, VMware Tools, the guest's own view
// (host name, addresses, gateway, DNS) and where the VM runs. Read only; nothing is changed.

type DetailCPU struct {
	Count          int32 `json:"count"`
	CoresPerSocket int32 `json:"coresPerSocket"`
	HotAdd         bool  `json:"hotAdd"`
	ReservationMhz int64 `json:"reservationMhz"`
	LimitMhz       int64 `json:"limitMhz"` // -1: none
	Shares         int32 `json:"shares"`
	UsageMhz       int32 `json:"usageMhz"`
}

type DetailMemory struct {
	SizeMB        int32 `json:"sizeMb"`
	HotAdd        bool  `json:"hotAdd"`
	ReservationMB int64 `json:"reservationMb"`
	LimitMB       int64 `json:"limitMb"` // -1: none
	Shares        int32 `json:"shares"`
	GuestUsageMB  int32 `json:"guestUsageMb"`
	HostUsageMB   int32 `json:"hostUsageMb"`
	BalloonedMB   int32 `json:"balloonedMb"`
	SwappedMB     int32 `json:"swappedMb"`
}

type DetailNIC struct {
	Label          string   `json:"label"`
	Adapter        string   `json:"adapter"` // vmxnet3, e1000e, e1000…
	MAC            string   `json:"mac"`
	MACType        string   `json:"macType"` // assigned, manual, generated
	Connected      bool     `json:"connected"`
	StartConnected bool     `json:"startConnected"`
	Network        string   `json:"network"`        // port group name
	Kind           string   `json:"kind"`           // standard or distributed
	PortKey        string   `json:"portKey"`        // distributed port the NIC holds
	PortgroupKey   string   `json:"portgroupKey"`   // distributed port group key
	Switch         string   `json:"switch"`         // vSwitch name or distributed switch UUID
	VLAN           *int32   `json:"vlan"`           // nil when unknown or trunk
	IPs            []string `json:"ips"`            // addresses the guest reports on this MAC, with prefix
	GuestConnected *bool    `json:"guestConnected"` // the guest's own link state
}

type DetailDisk struct {
	Label        string  `json:"label"`
	CapacityGB   float64 `json:"capacityGb"`
	Datastore    string  `json:"datastore"`
	File         string  `json:"file"`
	Provisioning string  `json:"provisioning"` // thin, thick-lazy, thick-eager
	Mode         string  `json:"mode"`         // persistent, independent_persistent…
	Controller   string  `json:"controller"`   // e.g. "SCSI 0:1"
	Bus          string  `json:"bus"`          // pvscsi, lsilogic, lsilogic-sas, buslogic, sata, nvme, ide
}

type DetailCdrom struct {
	Label     string `json:"label"`
	ISO       string `json:"iso"`
	Connected bool   `json:"connected"`
}

type DetailTools struct {
	Status        string `json:"status"`        // toolsOk, toolsOld, toolsNotRunning, toolsNotInstalled
	RunningStatus string `json:"runningStatus"` // guestToolsRunning…
	Version       string `json:"version"`
	VersionStatus string `json:"versionStatus"` // guestToolsCurrent, guestToolsNeedUpgrade…
}

type DetailGuest struct {
	HostName  string   `json:"hostName"`
	OS        string   `json:"os"`
	Family    string   `json:"family"`
	IPs       []string `json:"ips"`
	Gateways  []string `json:"gateways"`
	DNS       []string `json:"dns"`
	Domain    string   `json:"domain"`
	State     string   `json:"state"`
	Heartbeat string   `json:"heartbeat"` // green, yellow, red, gray
}

type DetailPlacement struct {
	Host         string   `json:"host"`
	Cluster      string   `json:"cluster"`
	ResourcePool string   `json:"resourcePool"`
	Folder       string   `json:"folder"`
	Datastores   []string `json:"datastores"`
	VMXPath      string   `json:"vmxPath"`
}

type VMDetails struct {
	MoRef               string          `json:"moref"`
	Name                string          `json:"name"`
	InstanceUUID        string          `json:"instanceUuid"`
	BiosUUID            string          `json:"biosUuid"`
	GuestID             string          `json:"guestId"`
	ConfiguredOS        string          `json:"configuredOs"`
	HardwareVersion     string          `json:"hardwareVersion"`
	Firmware            string          `json:"firmware"` // bios or efi
	SecureBoot          bool            `json:"secureBoot"`
	Annotation          string          `json:"annotation"`
	PowerState          string          `json:"powerState"`
	ConnectionState     string          `json:"connectionState"`
	BootTime            *time.Time      `json:"bootTime"`
	UptimeSeconds       int32           `json:"uptimeSeconds"`
	OverallStatus       string          `json:"overallStatus"`
	ConsolidationNeeded bool            `json:"consolidationNeeded"`
	Snapshots           int             `json:"snapshots"`
	CommittedGB         float64         `json:"committedGb"`
	UncommittedGB       float64         `json:"uncommittedGb"`
	CPU                 DetailCPU       `json:"cpu"`
	Memory              DetailMemory    `json:"memory"`
	NICs                []DetailNIC     `json:"nics"`
	Disks               []DetailDisk    `json:"disks"`
	Cdroms              []DetailCdrom   `json:"cdroms"`
	Tools               DetailTools     `json:"tools"`
	Guest               DetailGuest     `json:"guest"`
	Placement           DetailPlacement `json:"placement"`
}

const gib = 1024 * 1024 * 1024

func vmDetails(ctx context.Context, c *vim25.Client, moref string) (*VMDetails, error) {
	if moref == "" {
		return nil, &Failure{Code: "INVALID_REQUEST", Message: "vm is required"}
	}
	pc := property.DefaultCollector(c)
	self := types.ManagedObjectReference{Type: "VirtualMachine", Value: moref}
	var vm mo.VirtualMachine
	if err := pc.RetrieveOne(ctx, self, []string{"name", "config", "runtime", "guest", "summary", "snapshot", "resourcePool", "parent", "datastore", "guestHeartbeatStatus"}, &vm); err != nil {
		if strings.Contains(err.Error(), "ManagedObjectNotFound") || strings.Contains(err.Error(), "has already been deleted") {
			return nil, &Failure{Code: "VM_NOT_FOUND", Message: "the VM no longer exists"}
		}
		return nil, err
	}
	nameOf := func(r *types.ManagedObjectReference) string {
		if r == nil {
			return ""
		}
		var e mo.ManagedEntity
		if err := pc.RetrieveOne(ctx, *r, []string{"name"}, &e); err != nil {
			return ""
		}
		return e.Name
	}

	d := &VMDetails{MoRef: moref, Name: vm.Name, NICs: []DetailNIC{}, Disks: []DetailDisk{}, Cdroms: []DetailCdrom{},
		Guest: DetailGuest{IPs: []string{}, Gateways: []string{}, DNS: []string{}}, Placement: DetailPlacement{Datastores: []string{}}}

	// Runtime and summary.
	d.PowerState = string(vm.Runtime.PowerState)
	d.ConnectionState = string(vm.Runtime.ConnectionState)
	d.BootTime = vm.Runtime.BootTime
	d.ConsolidationNeeded = vm.Runtime.ConsolidationNeeded
	d.OverallStatus = string(vm.Summary.OverallStatus)
	qs := vm.Summary.QuickStats
	d.UptimeSeconds = qs.UptimeSeconds
	d.CPU.UsageMhz = qs.OverallCpuUsage
	d.Memory.GuestUsageMB = qs.GuestMemoryUsage
	d.Memory.HostUsageMB = qs.HostMemoryUsage
	d.Memory.BalloonedMB = qs.BalloonedMemory
	d.Memory.SwappedMB = qs.SwappedMemory
	if st := vm.Summary.Storage; st != nil {
		d.CommittedGB = round2(float64(st.Committed) / gib)
		d.UncommittedGB = round2(float64(st.Uncommitted) / gib)
	}
	if vm.Snapshot != nil {
		d.Snapshots = countSnapshots(vm.Snapshot.RootSnapshotList)
	}

	// Configuration: identity, CPU, memory, devices.
	vlanOf := map[string]int32{}
	switchOf := map[string]string{}
	if cfg := vm.Config; cfg != nil {
		d.InstanceUUID = cfg.InstanceUuid
		d.BiosUUID = cfg.Uuid
		d.GuestID = cfg.GuestId
		d.ConfiguredOS = cfg.GuestFullName
		d.HardwareVersion = cfg.Version
		d.Firmware = cfg.Firmware
		d.Annotation = cfg.Annotation
		if cfg.BootOptions != nil && cfg.BootOptions.EfiSecureBootEnabled != nil {
			d.SecureBoot = *cfg.BootOptions.EfiSecureBootEnabled
		}
		d.CPU.Count = cfg.Hardware.NumCPU
		if cfg.Hardware.NumCoresPerSocket != nil {
			d.CPU.CoresPerSocket = *cfg.Hardware.NumCoresPerSocket
		}
		d.CPU.HotAdd = cfg.CpuHotAddEnabled != nil && *cfg.CpuHotAddEnabled
		d.Memory.SizeMB = cfg.Hardware.MemoryMB
		d.Memory.HotAdd = cfg.MemoryHotAddEnabled != nil && *cfg.MemoryHotAddEnabled
		if a := cfg.CpuAllocation; a != nil {
			d.CPU.ReservationMhz, d.CPU.LimitMhz, d.CPU.Shares = val64(a.Reservation, 0), val64(a.Limit, -1), shares(a.Shares)
		}
		if a := cfg.MemoryAllocation; a != nil {
			d.Memory.ReservationMB, d.Memory.LimitMB, d.Memory.Shares = val64(a.Reservation, 0), val64(a.Limit, -1), shares(a.Shares)
		}
		d.Placement.VMXPath = cfg.Files.VmPathName

		// Port groups of a standard vSwitch carry their VLAN on the host the VM runs on.
		if vm.Runtime.Host != nil {
			var h mo.HostSystem
			if err := pc.RetrieveOne(ctx, *vm.Runtime.Host, []string{"config.network.portgroup"}, &h); err == nil && h.Config != nil && h.Config.Network != nil {
				for _, pg := range h.Config.Network.Portgroup {
					vlanOf[pg.Spec.Name] = pg.Spec.VlanId
					switchOf[pg.Spec.Name] = pg.Spec.VswitchName
				}
			}
		}
		dvpg := map[string]mo.DistributedVirtualPortgroup{}
		if pgs, err := retrieve[mo.DistributedVirtualPortgroup](ctx, c, "DistributedVirtualPortgroup", []string{"name", "key", "config.defaultPortConfig"}); err == nil {
			for _, p := range pgs {
				dvpg[p.Key] = p
			}
		}

		controllers := map[int32]types.BaseVirtualDevice{}
		for _, dev := range cfg.Hardware.Device {
			if _, ok := dev.(types.BaseVirtualController); ok {
				controllers[dev.GetVirtualDevice().Key] = dev
			}
		}
		for _, dev := range cfg.Hardware.Device {
			vd := dev.GetVirtualDevice()
			label := ""
			if vd.DeviceInfo != nil {
				label = vd.DeviceInfo.GetDescription().Label
			}
			switch x := dev.(type) {
			case types.BaseVirtualEthernetCard:
				card := x.GetVirtualEthernetCard()
				n := DetailNIC{Label: label, Adapter: nicAdapter(dev), MAC: card.MacAddress, MACType: card.AddressType, IPs: []string{}}
				if vd.Connectable != nil {
					n.Connected, n.StartConnected = vd.Connectable.Connected, vd.Connectable.StartConnected
				}
				switch b := vd.Backing.(type) {
				case *types.VirtualEthernetCardNetworkBackingInfo:
					n.Kind, n.Network = "standard", b.DeviceName
					if v, ok := vlanOf[b.DeviceName]; ok {
						v := v
						n.VLAN = &v
					}
					n.Switch = switchOf[b.DeviceName]
				case *types.VirtualEthernetCardDistributedVirtualPortBackingInfo:
					n.Kind, n.PortKey, n.PortgroupKey, n.Switch = "distributed", b.Port.PortKey, b.Port.PortgroupKey, b.Port.SwitchUuid
					if p, ok := dvpg[b.Port.PortgroupKey]; ok {
						n.Network = p.Name
						if p.Config.DefaultPortConfig != nil {
							if s, ok := p.Config.DefaultPortConfig.(*types.VMwareDVSPortSetting); ok && s.Vlan != nil {
								if id, ok := s.Vlan.(*types.VmwareDistributedVirtualSwitchVlanIdSpec); ok {
									v := id.VlanId
									n.VLAN = &v
								}
							}
						}
					}
				case *types.VirtualEthernetCardOpaqueNetworkBackingInfo:
					n.Kind, n.Network = "opaque", b.OpaqueNetworkId
				}
				d.NICs = append(d.NICs, n)
			case *types.VirtualDisk:
				disk := DetailDisk{Label: label, CapacityGB: round2(float64(x.CapacityInBytes) / gib)}
				if fb, ok := x.Backing.(types.BaseVirtualDeviceFileBackingInfo); ok {
					disk.File = fb.GetVirtualDeviceFileBackingInfo().FileName
					disk.Datastore = datastoreName(disk.File)
				}
				if b, ok := x.Backing.(*types.VirtualDiskFlatVer2BackingInfo); ok {
					disk.Mode = b.DiskMode
					disk.Provisioning = "thick-lazy"
					if b.ThinProvisioned != nil && *b.ThinProvisioned {
						disk.Provisioning = "thin"
					} else if b.EagerlyScrub != nil && *b.EagerlyScrub {
						disk.Provisioning = "thick-eager"
					}
				}
				if ctl, ok := controllers[vd.ControllerKey]; ok {
					bus, prefix := controllerBus(ctl)
					disk.Bus = bus
					unit := int32(0)
					if vd.UnitNumber != nil {
						unit = *vd.UnitNumber
					}
					busNumber := int32(0)
					if bc, ok := ctl.(types.BaseVirtualController); ok {
						busNumber = bc.GetVirtualController().BusNumber
					}
					disk.Controller = prefix + " " + itoa(busNumber) + ":" + itoa(unit)
				}
				d.Disks = append(d.Disks, disk)
			case *types.VirtualCdrom:
				cd := DetailCdrom{Label: label}
				if b, ok := x.Backing.(*types.VirtualCdromIsoBackingInfo); ok {
					cd.ISO = b.FileName
				}
				if vd.Connectable != nil {
					cd.Connected = vd.Connectable.Connected
				}
				d.Cdroms = append(d.Cdroms, cd)
			}
		}
	}

	// The guest's own view, from VMware Tools.
	if g := vm.Guest; g != nil {
		d.Tools = DetailTools{Status: string(g.ToolsStatus), RunningStatus: g.ToolsRunningStatus, Version: g.ToolsVersion, VersionStatus: g.ToolsVersionStatus2}
		d.Guest.HostName, d.Guest.OS, d.Guest.Family, d.Guest.State = g.HostName, g.GuestFullName, g.GuestFamily, g.GuestState
		seen := map[string]bool{}
		for _, gn := range g.Net {
			var ips []string
			if gn.IpConfig != nil {
				for _, a := range gn.IpConfig.IpAddress {
					ips = append(ips, a.IpAddress+"/"+itoa(a.PrefixLength))
				}
			} else {
				ips = append(ips, gn.IpAddress...)
			}
			for _, ip := range ips {
				bare := strings.SplitN(ip, "/", 2)[0]
				if !seen[bare] {
					seen[bare] = true
					d.Guest.IPs = append(d.Guest.IPs, bare)
				}
			}
			for i := range d.NICs {
				if strings.EqualFold(d.NICs[i].MAC, gn.MacAddress) {
					d.NICs[i].IPs = append(d.NICs[i].IPs, ips...)
					on := gn.Connected
					d.NICs[i].GuestConnected = &on
				}
			}
		}
		for _, st := range g.IpStack {
			if st.DnsConfig != nil {
				d.Guest.DNS = appendNew(d.Guest.DNS, st.DnsConfig.IpAddress...)
				if d.Guest.Domain == "" {
					d.Guest.Domain = st.DnsConfig.DomainName
				}
			}
			if st.IpRouteConfig != nil {
				for _, r := range st.IpRouteConfig.IpRoute {
					if r.PrefixLength == 0 && r.Gateway.IpAddress != "" {
						d.Guest.Gateways = appendNew(d.Guest.Gateways, r.Gateway.IpAddress)
					}
				}
			}
		}
	}
	d.Guest.Heartbeat = string(vm.GuestHeartbeatStatus)

	// Where it runs.
	if vm.Runtime.Host != nil {
		var h mo.HostSystem
		if err := pc.RetrieveOne(ctx, *vm.Runtime.Host, []string{"name", "parent"}, &h); err == nil {
			d.Placement.Host = h.Name
			if h.Parent != nil && h.Parent.Type == "ClusterComputeResource" {
				d.Placement.Cluster = nameOf(h.Parent)
			}
		}
	}
	d.Placement.ResourcePool = nameOf(vm.ResourcePool)
	d.Placement.Folder = nameOf(vm.Parent)
	for i := range vm.Datastore {
		if n := nameOf(&vm.Datastore[i]); n != "" {
			d.Placement.Datastores = append(d.Placement.Datastores, n)
		}
	}
	sort.Strings(d.Placement.Datastores)
	return d, nil
}

func countSnapshots(list []types.VirtualMachineSnapshotTree) int {
	n := 0
	for _, s := range list {
		n += 1 + countSnapshots(s.ChildSnapshotList)
	}
	return n
}

func val64(p *int64, def int64) int64 {
	if p == nil {
		return def
	}
	return *p
}

func shares(s *types.SharesInfo) int32 {
	if s == nil {
		return 0
	}
	return s.Shares
}

func round2(f float64) float64 { return float64(int64(f*100+0.5)) / 100 }

func itoa[T int32 | int](n T) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	if neg {
		b = append([]byte{'-'}, b...)
	}
	return string(b)
}

func appendNew(list []string, add ...string) []string {
	for _, a := range add {
		dup := false
		for _, x := range list {
			if x == a {
				dup = true
				break
			}
		}
		if !dup && a != "" {
			list = append(list, a)
		}
	}
	return list
}

// "[datastore1] web/web.vmdk" → "datastore1".
func datastoreName(file string) string {
	if strings.HasPrefix(file, "[") {
		if i := strings.Index(file, "]"); i > 0 {
			return file[1:i]
		}
	}
	return ""
}

func nicAdapter(dev types.BaseVirtualDevice) string {
	switch dev.(type) {
	case *types.VirtualVmxnet3:
		return "vmxnet3"
	case *types.VirtualVmxnet3Vrdma:
		return "vmxnet3-vrdma"
	case *types.VirtualVmxnet2:
		return "vmxnet2"
	case *types.VirtualVmxnet:
		return "vmxnet"
	case *types.VirtualE1000e:
		return "e1000e"
	case *types.VirtualE1000:
		return "e1000"
	case *types.VirtualPCNet32:
		return "pcnet32"
	case *types.VirtualSriovEthernetCard:
		return "sriov"
	}
	return strings.ToLower(strings.TrimPrefix(reflect.TypeOf(dev).Elem().Name(), "Virtual"))
}

func controllerBus(dev types.BaseVirtualDevice) (bus, prefix string) {
	switch dev.(type) {
	case *types.ParaVirtualSCSIController:
		return "pvscsi", "SCSI"
	case *types.VirtualLsiLogicController:
		return "lsilogic", "SCSI"
	case *types.VirtualLsiLogicSASController:
		return "lsilogic-sas", "SCSI"
	case *types.VirtualBusLogicController:
		return "buslogic", "SCSI"
	case *types.VirtualAHCIController:
		return "sata", "SATA"
	case *types.VirtualNVMEController:
		return "nvme", "NVMe"
	case *types.VirtualIDEController:
		return "ide", "IDE"
	}
	return strings.ToLower(reflect.TypeOf(dev).Elem().Name()), "BUS"
}
