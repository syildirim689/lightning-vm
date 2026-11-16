// The shell the adapter runs on a KVM host (bash, with virsh, qemu-img, virt-clone and virt-xml: the libvirt
// client tools and virtinst). Each script gets its parameters as shell variables (P_name ...), prints records as
// tab-separated lines ("V<TAB>uuid<TAB>name...") and ends with the line "LVMOK". A failure the contract has a code
// for is the line "LVMERR <CODE> <text>" and exit status 1 (ssh.mjs turns it into that code).
// Written without ${...} so the JavaScript around it leaves the shell alone; shell variables are $name or "$name".
const PRELUDE = String.raw`set -u
export LC_ALL=C
V="virsh -c qemu:///system"
ROOT=/var/lib/lightning-vm
# Tests point the adapter's own folder somewhere else.
[ -n "$(printenv LVM_ROOT)" ] && ROOT=$(printenv LVM_ROOT)
exec 3>&1 # failures go to the real output even from inside $(...)
fail() { printf 'LVMERR %s %s\n' "$1" "$2" >&3; exit 1; }
need() { command -v "$1" >/dev/null 2>&1 || fail NOT_LIBVIRT "$1 is not installed on this host"; }
need virsh
$V uri >/dev/null 2>&1 || fail PERMISSION_DENIED "this account cannot reach libvirt (qemu:///system)"
# The domain a uuid names, or VM_NOT_FOUND.
dom() { echo "$1" | grep -Eq '^[0-9a-f-]{36}$' || fail INVALID_REQUEST "vm is required"; $V domname "$1" 2>/dev/null | head -n 1 | grep . || fail VM_NOT_FOUND "the VM no longer exists"; }
managed() { case "$1" in lvm-*) ;; *) fail NOT_MANAGED "this VM was not created by the panel" ;; esac; }
power() { case "$($V domstate "$1" 2>/dev/null | head -n 1)" in running|"in shutdown"|blocked) echo poweredOn ;; paused|pmsuspended) echo suspended ;; *) echo poweredOff ;; esac; }
is_template() { case "$1" in template-*|tpl-*|template_*|tpl_*) return 0 ;; esac; $V desc "$1" 2>/dev/null | grep -q lvm-template; }
# Hard disks of a domain: target, source file and size in bytes, in device order.
disks() { $V domblklist "$1" --details 2>/dev/null | awk '$2 == "disk" && $4 != "-" { print $3 "\t" $4 }' | while IFS="$(printf '\t')" read -r t src; do
  size=$($V domblkinfo "$1" "$t" --bytes 2>/dev/null | awk '/^Capacity:/ { print $2 }'); printf '%s\t%s\t%s\n' "$t" "$src" "$size"; done; }
# One "S" record: uuid, name, power, guest agent answers (1/0), addresses (comma separated), the server id.
state() {
  n=$1; guest=$2; u=$($V domuuid "$n" | head -n 1); p=$(power "$n"); tools=0; ips=""
  desc=$($V desc "$n" 2>/dev/null)
  sid=$(printf '%s' "$desc" | sed -n 's/.*Managed by Lightning VM (server \([0-9a-f-]\{36\}\)).*/\1/p' | head -n 1)
  if [ "$guest" = 1 ] && [ "$p" = poweredOn ]; then
    ips=$($V domifaddr "$n" --source agent 2>/dev/null | awk 'NR > 2 && NF >= 4 && $1 != "lo" && $4 !~ /^fe80:/ && $4 !~ /^127\./ && $4 !~ /^::1/ { sub(/\/.*/, "", $4); print $4 }' | paste -sd, -)
    if [ -n "$ips" ]; then tools=1
    else
      # No guest agent: a server that has been running for four minutes counts as ready with the addresses it was given.
      pid=/run/libvirt/qemu/$n.pid
      if [ -f "$pid" ] && [ $(( $(date +%s) - $(stat -c %Y "$pid") )) -gt 240 ]; then tools=1; ips=$(printf '%s' "$desc" | sed -n 's/.*lvm-ips=\([0-9a-fA-F.:,]*\).*/\1/p' | head -n 1); fi
    fi
  fi
  printf 'S\t%s\t%s\t%s\t%s\t%s\t%s\n' "$u" "$n" "$p" "$tools" "$ips" "$sid"
}
`;

const BODIES = {
  discover: String.raw`
need qemu-img
printf 'H\tname\t%s\n' "$(hostname)"
printf 'H\tuuid\t%s\n' "$(cat /etc/machine-id 2>/dev/null)"
printf 'H\tversion\t%s\n' "$($V version 2>/dev/null | awk -F': *' '/Running hypervisor/ { print $2 }' | head -n 1)"
printf 'H\tos\t%s\n' "$( (. /etc/os-release 2>/dev/null && printf '%s' "$PRETTY_NAME") )"
$V nodeinfo | awk -F': *' 'NF >= 2 { gsub(/ /, "_", $1); gsub(/^ +/, "", $2); print "H\t" $1 "\t" $2 }'
printf 'H\tfree\t%s\n' "$(awk '/^MemAvailable:/ { print $2 * 1024 }' /proc/meminfo)"
virt=1; command -v virt-clone >/dev/null 2>&1 && command -v virt-xml >/dev/null 2>&1 || virt=0
printf 'H\tvirtinst\t%s\n' "$virt"
$V pool-list --name 2>/dev/null | grep . | while read -r pool; do
  $V pool-info "$pool" --bytes 2>/dev/null | awk -F': *' -v p="$pool" '{ gsub(/^ +/, "", $2); a[$1] = $2 } END { print "D\t" p "\t" a["Capacity"] "\t" a["Available"] "\t" a["State"] }'
done
$V net-list --name 2>/dev/null | grep . | while read -r net; do printf 'N\t%s\t%s\n' "$net" "$($V net-info "$net" 2>/dev/null | awk '/^Bridge:/ { print $2 }')"; done
$V list --all --name | grep . | while read -r n; do
  t=0; is_template "$n" && t=1
  $V dominfo "$n" | awk -F': *' -v n="$n" -v t="$t" -v p="$(power "$n")" '{ gsub(/^ +/, "", $2); a[$1] = $2 } END { split(a["Max memory"], m, " "); print "V\t" a["UUID"] "\t" n "\t" p "\t" a["CPU(s)"] "\t" m[1] "\t" t "\t" a["OS Type"] }'
done
echo LVMOK`,

  find: String.raw`
if $V domuuid "$P_name" >/dev/null 2>&1; then state "$P_name" 1; fi
echo LVMOK`,

  managed: String.raw`
$V list --all --name | grep '^lvm-' | while read -r n; do state "$n" 0; done
echo LVMOK`,

  // Starts the copy in the background and answers at once; the job writes how it went to a status file.
  clone: String.raw`
need virt-clone; need virt-xml; need qemu-img
if $V domuuid "$P_name" >/dev/null 2>&1; then printf 'R\texisted\t%s\n' "$($V domuuid "$P_name" | head -n 1)"; echo LVMOK; exit 0; fi
t=$($V domname "$P_template" 2>/dev/null | head -n 1); [ -n "$t" ] || fail TEMPLATE_NOT_FOUND "the template no longer exists"
# These names go into the job script below: only plain ones are let through.
plain() { printf '%s' "$1" | grep -Eq '^[A-Za-z0-9._+/ -]+$' && ! printf '%s' "$1" | grep -q '\.\.'; }
plain "$t" || fail TEMPLATE_NOT_FOUND "the name of the template has characters the panel does not accept"
plain "$P_network" || fail NETWORK_NOT_FOUND "the name of the network has characters the panel does not accept"
echo "$P_name" | grep -Eq '^lvm-[A-Za-z0-9_-]+$' || fail INVALID_REQUEST "the name may hold letters, digits, - and _ only"
[ "$(power "$t")" = poweredOff ] || fail INVALID_STATE "the template must be shut down"
src=$(disks "$t" | head -n 1); [ -n "$src" ] || fail VM_HAS_NO_DISK "the template has no disk"
size=$(printf '%s' "$src" | cut -f3)
$V domiflist "$t" | awk 'NR > 2 && NF' | grep -q . || fail TEMPLATE_HAS_NO_NIC "the template has no network interface"
[ "$P_diskGb" -gt 0 ] && [ $(( P_diskGb * 1073741824 )) -lt "$size" ] && fail DISK_SMALLER_THAN_TEMPLATE "the disk is smaller than the template"
dir=$($V pool-dumpxml "$P_datastore" 2>/dev/null | sed -n 's:.*<path>\(.*\)</path>.*:\1:p' | head -n 1); [ -n "$dir" ] && [ -d "$dir" ] && plain "$dir" || fail DATASTORE_NOT_FOUND "the storage pool no longer exists (or is not a plain directory)"
$V net-info "$P_network" >/dev/null 2>&1 || fail NETWORK_NOT_FOUND "the network no longer exists"
mkdir -p "$ROOT/tasks"; find "$ROOT/tasks" -type f -mtime +2 -delete 2>/dev/null
id=$(cat /proc/sys/kernel/random/uuid)
printf '%s' "$P_iso" | base64 -d > "$dir/$P_name-cidata.iso" || fail LIBVIRT_ERROR "could not write the config drive"
echo running > "$ROOT/tasks/$id.status"
cat > "$ROOT/tasks/$id.sh" <<LVMJOB
#!/bin/bash
export LC_ALL=C
V="virsh -c qemu:///system"; st="$ROOT/tasks/$id.status"
bad() { printf 'error\t%s\t%s\n' "\$1" "\$2" > "\$st"; exit 1; }
out=\$(virt-clone --connect qemu:///system --original "$t" --name "$P_name" --file "$dir/$P_name.qcow2" 2>&1) || { case "\$out" in *"No space"*|*"not enough"*) bad INSUFFICIENT_RESOURCES "\$out" ;; *"already"*) bad DUPLICATE_NAME "\$out" ;; *) bad TASK_FAILED "\$out" ;; esac; }
\$V setmaxmem "$P_name" "$P_memoryMb"M --config && \$V setmem "$P_name" "$P_memoryMb"M --config || bad TASK_FAILED "could not set the memory"
\$V setvcpus "$P_name" "$P_vcpu" --maximum --config && \$V setvcpus "$P_name" "$P_vcpu" --config || bad TASK_FAILED "could not set the processors"
virt-xml --connect qemu:///system "$P_name" --edit 1 --network network="$P_network" >/dev/null 2>&1 || bad TASK_FAILED "could not set the network"
[ "$P_diskGb" -gt 0 ] && [ \$(( $P_diskGb * 1073741824 )) -gt "$size" ] && { qemu-img resize "$dir/$P_name.qcow2" "$P_diskGb"G >/dev/null 2>&1 || bad TASK_FAILED "could not grow the disk"; }
\$V attach-disk "$P_name" "$dir/$P_name-cidata.iso" sdz --type cdrom --mode readonly --config >/dev/null 2>&1 || bad TASK_FAILED "could not attach the config drive"
\$V desc "$P_name" --config --new-desc "$P_notes" >/dev/null 2>&1
\$V autostart "$P_name" >/dev/null 2>&1
printf 'success\t%s\n' "\$(\$V domuuid "$P_name" | head -n 1)" > "\$st"
LVMJOB
chmod 700 "$ROOT/tasks/$id.sh"
nohup setsid bash "$ROOT/tasks/$id.sh" >/dev/null 2>&1 < /dev/null &
printf 'R\ttask\t%s\n' "$id"
echo LVMOK`,

  task: String.raw`
echo "$P_task" | grep -Eq '^[0-9a-f-]{36}$' || fail INVALID_REQUEST "task is required"
f="$ROOT/tasks/$P_task.status"
if [ ! -f "$f" ]; then printf 'R\tunknown\n'; echo LVMOK; exit 0; fi
st=$(head -n 1 "$f")
# A job that says "running" but has no process any more (the host restarted) will never finish.
if [ "$st" = running ] && ! pgrep -f "$ROOT/tasks/$P_task.sh" >/dev/null 2>&1 && [ $(( $(date +%s) - $(stat -c %Y "$f") )) -gt 60 ]; then printf 'R\terror\tTASK_FAILED\tthe background job stopped without a result\n'
else printf 'R\t%s\n' "$st"; fi
echo LVMOK`,

  power: String.raw`
n=$(dom "$P_vm") || exit 1
p=$(power "$n")
case "$P_action" in
  on) [ "$p" = poweredOn ] || $V start "$n" >/dev/null 2>&1 || fail LIBVIRT_ERROR "$($V start "$n" 2>&1 | head -n 1)" ;;
  off) [ "$p" = poweredOff ] || $V destroy "$n" >/dev/null 2>&1 || fail LIBVIRT_ERROR "could not power off" ;;
  reset) if [ "$p" = poweredOn ]; then $V reset "$n" >/dev/null 2>&1 || fail LIBVIRT_ERROR "could not reset"; else $V start "$n" >/dev/null 2>&1 || fail LIBVIRT_ERROR "could not start"; fi ;;
  shutdown) [ "$p" = poweredOff ] || $V shutdown "$n" >/dev/null 2>&1 || fail TOOLS_NOT_RUNNING "the guest could not be asked to shut down" ;;
  *) fail INVALID_REQUEST "unknown power action" ;;
esac
echo LVMOK`,

  destroy: String.raw`
n=$($V domname "$P_vm" 2>/dev/null | head -n 1)
if [ -z "$n" ]; then printf 'R\tgone\n'; echo LVMOK; exit 0; fi
managed "$n"
[ "$(power "$n")" = poweredOff ] || $V destroy "$n" >/dev/null 2>&1
iso=$($V domblklist "$n" --details 2>/dev/null | awk '$2 == "cdrom" && $4 ~ /-cidata\.iso$/ { print $4 }' | head -n 1)
$V undefine "$n" --remove-all-storage --snapshots-metadata --nvram >/dev/null 2>&1 || $V undefine "$n" --remove-all-storage --snapshots-metadata >/dev/null 2>&1 || fail LIBVIRT_ERROR "could not remove the VM"
# The config drive is the panel's own file: removed only when it carries this server's name.
case "$iso" in */"$n"-cidata.iso) rm -f "$iso" ;; esac
echo LVMOK`,

  resize: String.raw`
need qemu-img
n=$(dom "$P_vm") || exit 1; managed "$n"
d=$(disks "$n" | head -n 1); [ -n "$d" ] || fail VM_HAS_NO_DISK "the VM has no disk"
path=$(printf '%s' "$d" | cut -f2); size=$(printf '%s' "$d" | cut -f3)
now=$(( (size + 1073741823) / 1073741824 ))
[ "$P_diskGb" -lt "$now" ] && fail DISK_SHRINK_NOT_SUPPORTED "a disk cannot be made smaller"
[ "$P_diskGb" -gt "$now" ] && [ -n "$($V snapshot-list "$n" --name 2>/dev/null | grep .)" ] && fail DISK_HAS_SNAPSHOTS "remove the snapshots before growing the disk"
[ "$(power "$n")" = poweredOff ] || fail INVALID_STATE "the server must be shut down to change its size"
$V setmaxmem "$n" "$P_memoryMb"M --config >/dev/null && $V setmem "$n" "$P_memoryMb"M --config >/dev/null || fail LIBVIRT_ERROR "could not set the memory"
$V setvcpus "$n" "$P_vcpu" --maximum --config >/dev/null && $V setvcpus "$n" "$P_vcpu" --config >/dev/null || fail LIBVIRT_ERROR "could not set the processors"
if [ "$P_diskGb" -gt "$now" ]; then qemu-img resize "$path" "$P_diskGb"G >/dev/null 2>&1 || fail LIBVIRT_ERROR "could not grow the disk"; fi
echo LVMOK`,

  rename: String.raw`
n=$(dom "$P_vm") || exit 1
size=$(disks "$n" | head -n 1 | cut -f3); [ -n "$size" ] || size=0; gb=$(( (size + 1073741823) / 1073741824 ))
if [ "$n" != "$P_name" ]; then
  case "$n" in lvm-*) fail NOT_IMPORTABLE "already managed" ;; esac
  is_template "$n" && fail NOT_IMPORTABLE "a template"
  [ "$(power "$n")" = poweredOff ] || fail INVALID_STATE "shut the VM down first: libvirt renames only a stopped VM"
  $V domrename "$n" "$P_name" >/dev/null 2>&1 || fail LIBVIRT_ERROR "could not rename the VM"
fi
printf 'R\tdiskGb\t%s\n' "$gb"
echo LVMOK`,

  disks: String.raw`
n=$(dom "$P_vm") || exit 1; managed "$n"
disks "$n" | awk '{ print "K\t" $0 }'
echo LVMOK`,

  diskAdd: String.raw`
need qemu-img
n=$(dom "$P_vm") || exit 1; managed "$n"
first=$(disks "$n" | head -n 1); [ -n "$first" ] || fail VM_HAS_NO_DISK "the VM has no disk"
dir=$(dirname "$(printf '%s' "$first" | cut -f2)")
used=$($V domblklist "$n" | awk 'NR > 2 { print $1 }')
t=""; for l in b c d e f g h i j k l m n o p; do echo "$used" | grep -qx "vd$l" || { t="vd$l"; break; }; done
[ -n "$t" ] || fail NO_DISK_CONTROLLER "no free disk slot"
path="$dir/$n-$t.qcow2"
qemu-img create -f qcow2 "$path" "$P_sizeGb"G >/dev/null 2>&1 || fail INSUFFICIENT_RESOURCES "could not create the disk"
flags="--config"; [ "$(power "$n")" = poweredOn ] && flags="--persistent"
$V attach-disk "$n" "$path" "$t" --driver qemu --subdriver qcow2 --targetbus virtio $flags >/dev/null 2>&1 || { rm -f "$path"; fail LIBVIRT_ERROR "could not attach the disk"; }
echo LVMOK`,

  diskRemove: String.raw`
n=$(dom "$P_vm") || exit 1; managed "$n"
all=$(disks "$n"); d=$(printf '%s\n' "$all" | awk -F'\t' -v t="$P_target" '$1 == t')
if [ -z "$d" ]; then printf 'R\tgone\n'; echo LVMOK; exit 0; fi
[ "$(printf '%s\n' "$all" | head -n 1 | cut -f1)" = "$P_target" ] && fail SYSTEM_DISK "the system disk cannot be removed"
flags="--config"; [ "$(power "$n")" = poweredOn ] && flags="--persistent"
$V detach-disk "$n" "$P_target" $flags >/dev/null 2>&1 || fail INVALID_STATE "the disk is in use in the server"
path=$(printf '%s' "$d" | cut -f2)
case "$path" in */"$n"-vd?.qcow2) rm -f "$path" ;; esac
echo LVMOK`,

  snapshots: String.raw`
n=$(dom "$P_vm") || exit 1
cur=$($V snapshot-current "$n" --name 2>/dev/null | head -n 1)
$V snapshot-list "$n" --name 2>/dev/null | grep . | while read -r s; do
  xml=$($V snapshot-dumpxml "$n" "$s" 2>/dev/null)
  when=$(printf '%s' "$xml" | sed -n 's:.*<creationTime>\([0-9]*\)</creationTime>.*:\1:p' | head -n 1)
  desc=$(printf '%s' "$xml" | tr '\n' ' ' | sed -n 's:.*<description>\(.*\)</description>.*:\1:p' | head -n 1)
  parent=$(printf '%s' "$xml" | tr '\n' ' ' | sed -n 's:.*<parent> *<name>\([^<]*\)</name>.*:\1:p' | head -n 1)
  c=0; [ "$s" = "$cur" ] && c=1
  printf 'P\t%s\t%s\t%s\t%s\t%s\n' "$s" "$when" "$c" "$parent" "$desc"
done
echo LVMOK`,

  snapshot: String.raw`
n=$(dom "$P_vm") || exit 1
case "$P_action" in
  create) out=$($V snapshot-create-as "$n" "$P_snapname" "$P_description" --atomic 2>&1) || fail LIBVIRT_ERROR "$(printf '%s' "$out" | head -n 1)" ;;
  revert) $V snapshot-list "$n" --name 2>/dev/null | grep -qx "$P_snapname" || fail SNAPSHOT_NOT_FOUND "the snapshot is not in this VM"
    out=$($V snapshot-revert "$n" "$P_snapname" 2>&1) || fail LIBVIRT_ERROR "$(printf '%s' "$out" | head -n 1)" ;;
  remove) $V snapshot-list "$n" --name 2>/dev/null | grep -qx "$P_snapname" || fail SNAPSHOT_NOT_FOUND "the snapshot is not in this VM"
    out=$($V snapshot-delete "$n" "$P_snapname" 2>&1) || fail LIBVIRT_ERROR "$(printf '%s' "$out" | head -n 1)" ;;
  *) fail INVALID_REQUEST "unknown snapshot action" ;;
esac
echo LVMOK`,

  details: String.raw`
n=$(dom "$P_vm") || exit 1
state "$n" 1
$V dominfo "$n" | awk -F': *' 'NF >= 2 { gsub(/ /, "_", $1); gsub(/^ +/, "", $2); print "I\t" $1 "\t" $2 }'
printf 'I\tdesc\t%s\n' "$($V desc "$n" 2>/dev/null | tr '\n' '|')"
xml=$($V dumpxml "$n" 2>/dev/null)
printf 'I\tfirmware\t%s\n' "$(printf '%s' "$xml" | grep -qE "<loader|firmware='efi'" && echo efi || echo bios)"
printf 'I\tmachine\t%s\n' "$(printf '%s' "$xml" | sed -n "s/.*machine='\([^']*\)'.*/\1/p" | head -n 1)"
printf 'I\tsnapshots\t%s\n' "$($V snapshot-list "$n" --name 2>/dev/null | grep -c .)"
printf 'I\thost\t%s\n' "$(hostname)"
pid=/run/libvirt/qemu/$n.pid; [ -f "$pid" ] && printf 'I\tstarted\t%s\n' "$(stat -c %Y "$pid")"
disks "$n" | awk '{ print "K\t" $0 }'
$V domblklist "$n" --details 2>/dev/null | awk '$2 == "cdrom" { print "C\t" $4 }'
$V domiflist "$n" 2>/dev/null | awk 'NR > 2 && NF { print "F\t" $1 "\t" $2 "\t" $3 "\t" $4 "\t" $5 }'
$V domifaddr "$n" --source agent 2>/dev/null | awk 'NR > 2 && NF >= 4 && $1 != "lo" { print "A\t" $2 "\t" $4 }'
echo LVMOK`,
};

export const names = Object.keys(BODIES);
// One shell word, whatever is in it.
export const quote = (v) => `'${String(v ?? '').replace(/'/g, `'\\''`)}'`;
// The script for one operation: its parameters as P_<name> variables, then the shared part, then its own.
export function script(name, params = {}) {
  if (!BODIES[name]) throw new Error(`no such script: ${name}`);
  for (const k of Object.keys(params)) if (!/^[A-Za-z]\w*$/.test(k)) throw new Error(`bad parameter name: ${k}`);
  return `${Object.entries(params).map(([k, v]) => `P_${k}=${quote(v)}`).join('\n')}\n${PRELUDE}${BODIES[name]}\n`;
}
