package main

import (
	"context"
	"time"

	"github.com/vmware/govmomi/performance"
	"github.com/vmware/govmomi/vim25"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

// Host power for the energy report: the latest realtime power.power.average (watts) where the host reports
// it (power management / IPMI), CPU use for an estimate where it does not, and each managed VM's CPU so the
// panel can share a host's watts among its servers.

type PowerHost struct {
	MoRef       string   `json:"moref"`
	Name        string   `json:"name"`
	Watts       *float64 `json:"watts"` // nil: the host does not report power
	CPUUsedMhz  int64    `json:"cpuUsedMhz"`
	CPUTotalMhz int64    `json:"cpuTotalMhz"`
	CoreMhz     int64    `json:"coreMhz"` // one core, for a VM's CPU percentage
	Connected   bool     `json:"connected"`
}

type PowerVM struct {
	Name       string `json:"name"`
	Host       string `json:"host"`
	CPUUsedMhz int32  `json:"cpuUsedMhz"`
}

type PowerReport struct {
	Time  time.Time   `json:"time"`
	Hosts []PowerHost `json:"hosts"`
	VMs   []PowerVM   `json:"vms"`
}

func powerReport(ctx context.Context, c *vim25.Client) (*PowerReport, error) {
	out := &PowerReport{Time: time.Now().UTC(), Hosts: []PowerHost{}, VMs: []PowerVM{}}
	hosts, err := retrieve[mo.HostSystem](ctx, c, "HostSystem", []string{"name", "summary.quickStats", "summary.hardware", "runtime.connectionState"})
	if err != nil {
		return nil, err
	}
	index := map[string]int{}
	var refs []types.ManagedObjectReference
	for _, h := range hosts {
		p := PowerHost{MoRef: h.Self.Value, Name: h.Name, CPUUsedMhz: int64(h.Summary.QuickStats.OverallCpuUsage),
			Connected: h.Runtime.ConnectionState == types.HostSystemConnectionStateConnected}
		if hw := h.Summary.Hardware; hw != nil {
			p.CPUTotalMhz = int64(hw.CpuMhz) * int64(hw.NumCpuCores)
			p.CoreMhz = int64(hw.CpuMhz)
		}
		index[h.Self.Value] = len(out.Hosts)
		out.Hosts = append(out.Hosts, p)
		if p.Connected {
			refs = append(refs, h.Self)
		}
	}
	vms, err := retrieve[mo.VirtualMachine](ctx, c, "VirtualMachine", []string{"name", "runtime.host", "runtime.powerState", "summary.quickStats"})
	if err != nil {
		return nil, err
	}
	for _, v := range vms {
		if len(v.Name) > len(managedPrefix) && v.Name[:len(managedPrefix)] == managedPrefix && v.Runtime.PowerState == types.VirtualMachinePowerStatePoweredOn {
			out.VMs = append(out.VMs, PowerVM{Name: v.Name, Host: ref(v.Runtime.Host), CPUUsedMhz: v.Summary.QuickStats.OverallCpuUsage})
		}
	}
	if len(refs) == 0 {
		return out, nil
	}
	// A missing counter (no power management) leaves the watts empty; the panel then estimates.
	pm := performance.NewManager(c)
	series, err := pm.SampleByName(ctx, types.PerfQuerySpec{MaxSample: 1, IntervalId: 20}, []string{"power.power.average"}, refs)
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
			if v.Name == "power.power.average" && v.Instance == "" && len(v.Value) > 0 && v.Value[len(v.Value)-1] >= 0 {
				w := float64(v.Value[len(v.Value)-1])
				out.Hosts[i].Watts = &w
			}
		}
	}
	return out, nil
}
