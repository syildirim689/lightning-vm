package main

import "testing"

func TestCompat(t *testing.T) {
	cases := []struct {
		kind, api, write, custom, support string
		clone, url                        bool
	}{
		{"vcenter", "6.5", "available", "guestinfo", "legacy", true, false},
		{"vcenter", "6.7.3", "available", "guestinfo", "legacy", true, false},
		{"vcenter", "7.0.2.0", "available", "guestinfo", "end-of-support", true, true},
		{"vcenter", "7.0.3.0", "available", "cloudinit", "end-of-support", true, true},
		{"vcenter", "8.0.3.0", "available", "cloudinit", "supported", true, true},
		{"vcenter", "9.0.0.0", "available", "cloudinit", "supported", true, true},
		{"esxi", "8.0.3.0", "available", "none", "supported", false, true},
		{"vcenter", "8.0.2.0", "restricted", "none", "supported", true, true},
	}
	for _, c := range cases {
		got := compatFor(c.kind, c.api, c.write)
		if got.Customization != c.custom || got.Support != c.support || got.Clone != c.clone || got.ConsoleURL != c.url {
			t.Errorf("%s %s %s: got %+v", c.kind, c.api, c.write, got)
		}
	}
	if !apiAtLeast("7.0.3.0", "7.0.3") || apiAtLeast("7.0.2.0", "7.0.3") || !apiAtLeast("10.0", "9.0") {
		t.Error("version comparison")
	}
	if w := compatWarnings("vcenter", compatFor("vcenter", "9.0.0.0", "available")); len(w) != 1 || w[0] != "FEDERATED_LOGIN_BLOCKED" {
		t.Errorf("9.0 warnings: %v", w)
	}
}
