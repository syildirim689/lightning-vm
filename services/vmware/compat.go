package main

import (
	"strconv"
	"strings"
)

// What the panel can do with an endpoint of a given vSphere API version (Broadcom's API reference and
// KB 311864; govmomi supports 7.0+ officially, older works best effort).
type Compat struct {
	APIVersion    string `json:"apiVersion"`
	Customization string `json:"customization"` // "cloudinit" (native, vCenter 7.0U3+), "guestinfo" (cloud-init VMware datasource), "none"
	Clone         bool   `json:"clone"`         // template cloning needs vCenter
	ConsoleURL    bool   `json:"consoleUrl"`    // AcquireTicket returns a ready URL (API 7.0+); older ones are built by the adapter
	Support       string `json:"support"`       // "supported", "end-of-support" (6.7, 7.0) or "legacy" (below 7.0)
}

// apiAtLeast compares dotted versions numerically ("7.0.3.0" >= "7.0.3").
func apiAtLeast(v, min string) bool {
	a, b := strings.Split(v, "."), strings.Split(min, ".")
	for i := 0; i < len(b); i++ {
		x, y := 0, 0
		if i < len(a) {
			x, _ = strconv.Atoi(a[i])
		}
		y, _ = strconv.Atoi(b[i])
		if x != y {
			return x > y
		}
	}
	return true
}

func compatFor(kind, apiVersion, writeAPI string) Compat {
	c := Compat{APIVersion: apiVersion, Clone: kind == "vcenter", ConsoleURL: apiAtLeast(apiVersion, "7.0"), Support: "supported", Customization: "none"}
	switch {
	case !apiAtLeast(apiVersion, "7.0"):
		c.Support = "legacy"
	case !apiAtLeast(apiVersion, "8.0"):
		c.Support = "end-of-support"
	}
	if kind == "vcenter" && writeAPI != "restricted" {
		c.Customization = "guestinfo"
		if apiAtLeast(apiVersion, "7.0.3") {
			c.Customization = "cloudinit"
		}
	}
	return c
}

// Warnings the admin sees on the connection, from the version alone.
func compatWarnings(kind string, c Compat) []string {
	var w []string
	switch c.Support {
	case "legacy":
		w = append(w, "VERSION_LEGACY")
	case "end-of-support":
		w = append(w, "VERSION_END_OF_SUPPORT")
	}
	if kind == "vcenter" && !apiAtLeast(c.APIVersion, "7.0.3") {
		w = append(w, "CUSTOMIZATION_GUESTINFO")
	}
	if kind == "vcenter" && apiAtLeast(c.APIVersion, "9.0") {
		w = append(w, "FEDERATED_LOGIN_BLOCKED")
	}
	return w
}
