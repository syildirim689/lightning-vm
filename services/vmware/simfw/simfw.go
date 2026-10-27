// Package simfw is TEST ONLY: it adds distributed-port traffic filters to govmomi's simulator, which
// does not implement ReconfigureDVPort_Task and leaves port keys empty. Used by the adapter's tests and
// the simulator binary; it is not part of the adapter image.
package simfw

import (
	"strconv"
	"sync"
	"sync/atomic"

	"github.com/vmware/govmomi/simulator"
	"github.com/vmware/govmomi/vim25/methods"
	"github.com/vmware/govmomi/vim25/mo"
	"github.com/vmware/govmomi/vim25/soap"
	"github.com/vmware/govmomi/vim25/types"
)

type DVS struct {
	*simulator.DistributedVirtualSwitch
	mu    sync.Mutex
	ports map[string]*types.DistributedVirtualPort
}

func (s *DVS) port(key string) *types.DistributedVirtualPort {
	p := s.ports[key]
	if p == nil {
		p = &types.DistributedVirtualPort{DvsUuid: s.Uuid, Key: key, Config: types.DVPortConfigInfo{ConfigVersion: "0", Setting: &types.VMwareDVSPortSetting{}}}
		s.ports[key] = p
	}
	return p
}

func (s *DVS) FetchDVPorts(_ *simulator.Context, req *types.FetchDVPorts) soap.HasFault {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []types.DistributedVirtualPort
	if req.Criteria != nil {
		for _, k := range req.Criteria.PortKey {
			out = append(out, *s.port(k))
		}
	}
	return &methods.FetchDVPortsBody{Res: &types.FetchDVPortsResponse{Returnval: out}}
}

func (s *DVS) ReconfigureDVPortTask(ctx *simulator.Context, req *types.ReconfigureDVPort_Task) soap.HasFault {
	task := simulator.CreateTask(s, "reconfigureDVPort", func(*simulator.Task) (types.AnyType, types.BaseMethodFault) {
		s.mu.Lock()
		defer s.mu.Unlock()
		for _, spec := range req.Port {
			p := s.port(spec.Key)
			if spec.ConfigVersion != p.Config.ConfigVersion {
				return nil, &types.ConcurrentAccess{}
			}
			cur := p.Config.Setting.GetDVPortSetting()
			if cur.FilterPolicy == nil {
				cur.FilterPolicy = &types.DvsFilterPolicy{}
			}
			if spec.Setting != nil && spec.Setting.GetDVPortSetting().InShapingPolicy != nil {
				cur.InShapingPolicy = spec.Setting.GetDVPortSetting().InShapingPolicy
				cur.OutShapingPolicy = spec.Setting.GetDVPortSetting().OutShapingPolicy
			}
			if spec.Setting != nil && spec.Setting.GetDVPortSetting().FilterPolicy != nil {
				for _, f := range spec.Setting.GetDVPortSetting().FilterPolicy.FilterConfig {
					fs, ok := f.(*types.DvsTrafficFilterConfigSpec)
					if !ok {
						return nil, &types.InvalidArgument{InvalidProperty: "filterConfig"}
					}
					cfg := fs.DvsTrafficFilterConfig
					kept := cur.FilterPolicy.FilterConfig[:0]
					for _, old := range cur.FilterPolicy.FilterConfig {
						if old.GetDvsFilterConfig().Key != cfg.Key {
							kept = append(kept, old)
						}
					}
					cur.FilterPolicy.FilterConfig = kept
					switch fs.Operation {
					case "add":
						cfg.Key = "filter-" + spec.Key
						fallthrough
					case "edit":
						cur.FilterPolicy.FilterConfig = append(cur.FilterPolicy.FilterConfig, &cfg)
					}
				}
			}
			v, _ := strconv.Atoi(p.Config.ConfigVersion)
			p.Config.ConfigVersion = strconv.Itoa(v + 1)
		}
		return nil, nil
	})
	return &methods.ReconfigureDVPort_TaskBody{Res: &types.ReconfigureDVPort_TaskResponse{Returnval: task.Run(ctx)}}
}

// Store holds the wrapped switches; the simulator's own objects stay in its registry untouched.
type Store struct {
	mu  sync.Mutex
	dvs map[string]*DVS
}

// Shaping returns the inbound speed limit stored on a port (nil if none), for tests.
func (st *Store) Shaping(key string) *types.DVSTrafficShapingPolicy {
	st.mu.Lock()
	defer st.mu.Unlock()
	for _, s := range st.dvs {
		s.mu.Lock()
		p := s.ports[key]
		s.mu.Unlock()
		if p != nil {
			return p.Config.Setting.GetDVPortSetting().InShapingPolicy
		}
	}
	return nil
}

// Filter returns the traffic ruleset stored on a port of any switch (nil if none), for tests.
func (st *Store) Filter(key string) *types.DvsTrafficRuleset {
	st.mu.Lock()
	defer st.mu.Unlock()
	for _, s := range st.dvs {
		s.mu.Lock()
		p := s.ports[key]
		s.mu.Unlock()
		if p == nil {
			continue
		}
		if fp := p.Config.Setting.GetDVPortSetting().FilterPolicy; fp != nil {
			for _, f := range fp.FilterConfig {
				if tf, ok := f.(*types.DvsTrafficFilterConfig); ok {
					return tf.TrafficRuleset
				}
			}
		}
	}
	return nil
}

// Enable routes FetchDVPorts and ReconfigureDVPort_Task on any distributed switch to a wrapper. The global
// switch object is not replaced: the simulator type-asserts it in many places.
func Enable(model *simulator.Model) *Store {
	st := &Store{dvs: map[string]*DVS{}}
	model.Map().Handler = func(ctx *simulator.Context, m *simulator.Method) (mo.Reference, types.BaseMethodFault) {
		if m.Name == "ReconfigureDVPortgroup_Task" {
			if pg, ok := ctx.Map.Get(m.This).(*simulator.DistributedVirtualPortgroup); ok && ctx.Session != nil {
				w := &Portgroup{DistributedVirtualPortgroup: pg}
				ctx.Session.Registry.Put(w)
				return w, nil
			}
			return nil, nil
		}
		if m.Name != "FetchDVPorts" && m.Name != "ReconfigureDVPort_Task" {
			return nil, nil
		}
		sw, ok := ctx.Map.Get(m.This).(*simulator.DistributedVirtualSwitch)
		if !ok {
			return nil, nil
		}
		st.mu.Lock()
		defer st.mu.Unlock()
		d := st.dvs[m.This.Value]
		if d == nil {
			d = &DVS{DistributedVirtualSwitch: sw, ports: map[string]*types.DistributedVirtualPort{}}
			st.dvs[m.This.Value] = d
		}
		// The dispatcher prefers the session registry over the Handler result; put the wrapper there.
		if ctx.Session != nil && ctx.Session.Registry.Get(m.This) != d {
			ctx.Session.Registry.Put(d)
		}
		return d, nil
	}
	return st
}

// Portgroup reconfigures like vCenter: fields left unset in the spec keep their value (the simulator
// itself overwrites the whole config, which would blank the name). Only what the adapter sends is merged.
type Portgroup struct {
	*simulator.DistributedVirtualPortgroup
}

func (p *Portgroup) ReconfigureDVPortgroupTask(ctx *simulator.Context, req *types.ReconfigureDVPortgroup_Task) soap.HasFault {
	task := simulator.CreateTask(p, "reconfigureDvPortgroup", func(*simulator.Task) (types.AnyType, types.BaseMethodFault) {
		if req.Spec.ConfigVersion != "" && req.Spec.ConfigVersion != p.Config.ConfigVersion {
			return nil, &types.ConcurrentAccess{}
		}
		if req.Spec.Policy != nil {
			p.Config.Policy = req.Spec.Policy
		}
		if req.Spec.Name != "" {
			p.Config.Name = req.Spec.Name
		}
		return nil, nil
	})
	return &methods.ReconfigureDVPortgroup_TaskBody{Res: &types.ReconfigureDVPortgroup_TaskResponse{Returnval: task.Run(ctx)}}
}

var next atomic.Int64

// AssignPorts gives distributed NICs without a port a key, as vCenter does with static port binding.
// Call it with the VM locked (simulator.Context.WithLock).
func AssignPorts(vm *simulator.VirtualMachine) {
	if vm.Config == nil {
		return
	}
	for _, d := range vm.Config.Hardware.Device {
		if c, ok := d.(types.BaseVirtualEthernetCard); ok {
			if b, ok := c.GetVirtualEthernetCard().Backing.(*types.VirtualEthernetCardDistributedVirtualPortBackingInfo); ok && b.Port.PortKey == "" {
				b.Port.PortKey = strconv.FormatInt(100+next.Add(1), 10)
			}
		}
	}
}
