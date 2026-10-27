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
	// The last 15 minutes of realtime network samples (20 s each, KB/s over all NICs), for the traffic counter:
	// the panel counts each sample once, by its time.
	Traffic []TrafficSample `json:"traffic"`
}

type TrafficSample struct {
	T  time.Time `json:"t"`
	Rx float64   `json:"rx"` // net.received.average
	Tx float64   `json:"tx"` // net.transmitted.average
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
	pm := performance.NewManager(c)
	vmIndex := map[string]int{}
	var vmRefs []types.ManagedObjectReference
	for _, v := range vms {
		if len(v.Name) > len(managedPrefix) && v.Name[:len(managedPrefix)] == managedPrefix && v.Runtime.PowerState == types.VirtualMachinePowerStatePoweredOn {
			vmIndex[v.Self.Value] = len(out.VMs)
			vmRefs = append(vmRefs, v.Self)
			out.VMs = append(out.VMs, PowerVM{Name: v.Name, Host: ref(v.Runtime.Host), CPUUsedMhz: v.Summary.QuickStats.OverallCpuUsage, Traffic: []TrafficSample{}})
		}
	}
	vmTraffic(ctx, pm, vmRefs, vmIndex, out)
	if len(refs) == 0 {
		return out, nil
	}
	// A missing counter (no power management) leaves the watts empty; the panel then estimates.
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

// vmTraffic fills each VM's recent network samples; without the counters the traffic stays empty (not an error).
func vmTraffic(ctx context.Context, pm *performance.Manager, refs []types.ManagedObjectReference, index map[string]int, out *PowerReport) {
	if len(refs) == 0 {
		return
	}
	series, err := pm.SampleByName(ctx, types.PerfQuerySpec{MaxSample: 45, IntervalId: 20}, []string{"net.received.average", "net.transmitted.average"}, refs)
	if err != nil {
		return
	}
	results, err := pm.ToMetricSeries(ctx, series)
	if err != nil {
		return
	}
	for _, r := range results {
		i, ok := index[r.Entity.Value]
		if !ok {
			continue
		}
		samples := make([]TrafficSample, len(r.SampleInfo))
		for j, info := range r.SampleInfo {
			samples[j].T = info.Timestamp
		}
		for _, v := range r.Value {
			if v.Instance != "" { // the aggregate over all NICs
				continue
			}
			for j, x := range v.Value {
				if j >= len(samples) || x < 0 {
					continue
				}
				if v.Name == "net.received.average" {
					samples[j].Rx = float64(x)
				} else if v.Name == "net.transmitted.average" {
					samples[j].Tx = float64(x)
				}
			}
		}
		out.VMs[i].Traffic = samples
	}
}
