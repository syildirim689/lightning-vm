package main

import (
	"context"
	"time"

	"github.com/vmware/govmomi/object"
	"github.com/vmware/govmomi/performance"
	"github.com/vmware/govmomi/vim25"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/types"
)

// Live VM performance from PerformanceManager's realtime interval (20-second samples). Realtime stats are
// served by the host the VM runs on, so this works on standalone ESXi and through vCenter alike.

type Sample struct {
	T    time.Time `json:"t"`
	CPU  *float64  `json:"cpu"`  // percent of the VM's vCPUs
	Mem  *float64  `json:"mem"`  // percent of configured memory actively used
	Net  *float64  `json:"net"`  // KB/s, all NICs
	Disk *float64  `json:"disk"` // KB/s, all disks
}

type Metrics struct {
	Interval int32              `json:"interval"`
	Samples  []Sample           `json:"samples"`
	Quick    map[string]float64 `json:"quick"`
}

var counters = map[string]func(*Sample, float64){
	"cpu.usage.average":  func(s *Sample, v float64) { v /= 100; s.CPU = &v }, // hundredths of a percent
	"mem.usage.average":  func(s *Sample, v float64) { v /= 100; s.Mem = &v },
	"net.usage.average":  func(s *Sample, v float64) { s.Net = &v },
	"disk.usage.average": func(s *Sample, v float64) { s.Disk = &v },
}

func vmMetrics(ctx context.Context, c *vim25.Client, moref string, maxSamples int32) (*Metrics, error) {
	ref := types.ManagedObjectReference{Type: "VirtualMachine", Value: moref}
	var vm mo.VirtualMachine
	if err := object.NewVirtualMachine(c, ref).Properties(ctx, ref, []string{"summary.quickStats", "runtime.powerState"}, &vm); err != nil {
		return nil, err
	}
	q := vm.Summary.QuickStats
	out := &Metrics{Interval: 20, Samples: []Sample{}, Quick: map[string]float64{
		"cpuMhz": float64(q.OverallCpuUsage), "memoryActiveMb": float64(q.GuestMemoryUsage), "uptimeSeconds": float64(q.UptimeSeconds),
	}}
	if vm.Runtime.PowerState != types.VirtualMachinePowerStatePoweredOn {
		return out, nil // a powered-off VM has no realtime samples
	}
	pm := performance.NewManager(c)
	names := make([]string, 0, len(counters))
	for n := range counters {
		names = append(names, n)
	}
	spec := types.PerfQuerySpec{MaxSample: maxSamples, IntervalId: 20, MetricId: []types.PerfMetricId{{Instance: ""}}}
	series, err := pm.SampleByName(ctx, spec, names, []types.ManagedObjectReference{ref})
	if err != nil {
		return nil, err
	}
	results, err := pm.ToMetricSeries(ctx, series)
	if err != nil {
		return nil, err
	}
	for _, r := range results {
		out.Samples = make([]Sample, len(r.SampleInfo))
		for i, info := range r.SampleInfo {
			out.Samples[i].T = info.Timestamp
		}
		for _, v := range r.Value {
			set, ok := counters[v.Name]
			if !ok || v.Instance != "" { // the aggregate ("") instance only
				continue
			}
			for i, x := range v.Value {
				if i < len(out.Samples) && x >= 0 {
					set(&out.Samples[i], float64(x))
				}
			}
		}
	}
	return out, nil
}
