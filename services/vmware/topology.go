package main

import (
	"context"
	"strings"
	"time"

	"github.com/vmware/govmomi/performance"
	"github.com/vmware/govmomi/vim25"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

// A live picture of one endpoint for the topology screens: compute, hosts with their load, datastores, and
// this platform's VMs with CPU, memory and network rates. One property-collector pass per kind and one
// PerformanceManager query (the latest realtime sample) for all powered-on managed VMs.

type TopoCompute struct {
	MoRef string `json:"moref"`
	Name  string `json:"name"`
	Kind  string `json:"kind"` // cluster | host
}

type TopoHost struct {
	MoRef       string `json:"moref"`
	Name        string `json:"name"`
	Compute     string `json:"compute"`
	State       string `json:"state"` // connected, disconnected, notResponding
	Power       string `json:"power"`
	CPUUsedMhz  int64  `json:"cpuUsedMhz"`
	CPUTotalMhz int64  `json:"cpuTotalMhz"`
	MemUsedMb   int64  `json:"memUsedMb"`
	MemTotalMb  int64  `json:"memTotalMb"`
}

type TopoDatastore struct {
	MoRef      string   `json:"moref"`
	Name       string   `json:"name"`
	CapacityGb float64  `json:"capacityGb"`
	FreeGb     float64  `json:"freeGb"`
	Hosts      []string `json:"hosts"`
}

type TopoVM struct {
	MoRef      string   `json:"moref"`
	Name       string   `json:"name"`
	Host       string   `json:"host"`
	Power      string   `json:"power"`
	CPUUsedMhz int32    `json:"cpuUsedMhz"`
	MemUsedMb  int32    `json:"memUsedMb"`
	RxKBps     *float64 `json:"rxKBps"`
	TxKBps     *float64 `json:"txKBps"`
}

type Topology struct {
	Time       time.Time       `json:"time"`
	Compute    []TopoCompute   `json:"compute"`
	Hosts      []TopoHost      `json:"hosts"`
	Datastores []TopoDatastore `json:"datastores"`
	VMs        []TopoVM        `json:"vms"`
	OtherVMs   int             `json:"otherVms"` // VMs this platform did not create
}

func topology(ctx context.Context, c *vim25.Client) (*Topology, error) {
	out := &Topology{Time: time.Now().UTC(), Compute: []TopoCompute{}, Hosts: []TopoHost{}, Datastores: []TopoDatastore{}, VMs: []TopoVM{}}
	computes, err := retrieve[mo.ComputeResource](ctx, c, "ComputeResource", []string{"name"})
	if err != nil {
		return nil, err
	}
	for _, cr := range computes {
		kind := "host"
		if cr.Self.Type == "ClusterComputeResource" {
			kind = "cluster"
		}
		out.Compute = append(out.Compute, TopoCompute{MoRef: cr.Self.Value, Name: cr.Name, Kind: kind})
	}
	hosts, err := retrieve[mo.HostSystem](ctx, c, "HostSystem", []string{"name", "parent", "summary.quickStats", "summary.hardware", "runtime.connectionState", "runtime.powerState"})
	if err != nil {
		return nil, err
	}
	for _, h := range hosts {
		t := TopoHost{MoRef: h.Self.Value, Name: h.Name, Compute: ref(h.Parent), State: string(h.Runtime.ConnectionState), Power: string(h.Runtime.PowerState),
			CPUUsedMhz: int64(h.Summary.QuickStats.OverallCpuUsage), MemUsedMb: int64(h.Summary.QuickStats.OverallMemoryUsage)}
		if hw := h.Summary.Hardware; hw != nil {
			t.CPUTotalMhz = int64(hw.CpuMhz) * int64(hw.NumCpuCores)
			t.MemTotalMb = hw.MemorySize / (1024 * 1024)
		}
		out.Hosts = append(out.Hosts, t)
	}
	stores, err := retrieve[mo.Datastore](ctx, c, "Datastore", []string{"name", "summary", "host"})
	if err != nil {
		return nil, err
	}
	for _, d := range stores {
		t := TopoDatastore{MoRef: d.Self.Value, Name: d.Name, CapacityGb: float64(d.Summary.Capacity) / (1 << 30), FreeGb: float64(d.Summary.FreeSpace) / (1 << 30), Hosts: []string{}}
		for _, m := range d.Host {
			t.Hosts = append(t.Hosts, m.Key.Value)
		}
		out.Datastores = append(out.Datastores, t)
	}
	vms, err := retrieve[mo.VirtualMachine](ctx, c, "VirtualMachine", []string{"name", "runtime.host", "runtime.powerState", "summary.quickStats", "config.template"})
	if err != nil {
		return nil, err
	}
	index := map[string]int{}
	var running []types.ManagedObjectReference
	for _, v := range vms {
		if !strings.HasPrefix(v.Name, managedPrefix) {
			if v.Config == nil || !v.Config.Template {
				out.OtherVMs++
			}
			continue
		}
		index[v.Self.Value] = len(out.VMs)
		out.VMs = append(out.VMs, TopoVM{MoRef: v.Self.Value, Name: v.Name, Host: ref(v.Runtime.Host), Power: string(v.Runtime.PowerState),
			CPUUsedMhz: v.Summary.QuickStats.OverallCpuUsage, MemUsedMb: v.Summary.QuickStats.GuestMemoryUsage})
		if v.Runtime.PowerState == types.VirtualMachinePowerStatePoweredOn {
			running = append(running, v.Self)
		}
	}
	if len(running) == 0 {
		return out, nil
	}
	// Network rates (KB/s, latest 20-second sample); missing counters leave the rates empty, not an error.
	pm := performance.NewManager(c)
	series, err := pm.SampleByName(ctx, types.PerfQuerySpec{MaxSample: 1, IntervalId: 20}, []string{"net.received.average", "net.transmitted.average"}, running)
	if err != nil {
		return out, nil
	}
	results, err := pm.ToMetricSeries(ctx, series)
	if err != nil {
		return out, nil
	}
	for _, r := range results {
		i, ok := index[r.Entity.Value]
		if !ok {
			continue
		}
		for _, v := range r.Value {
			if v.Instance != "" || len(v.Value) == 0 || v.Value[len(v.Value)-1] < 0 {
				continue
			}
			x := float64(v.Value[len(v.Value)-1])
			switch v.Name {
			case "net.received.average":
				out.VMs[i].RxKBps = &x
			case "net.transmitted.average":
				out.VMs[i].TxKBps = &x
			}
		}
	}
	return out, nil
}
