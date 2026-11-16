// The PowerShell the adapter runs on a Hyper-V host (Windows PowerShell 5.1 with the Hyper-V module). Each script
// gets its parameters as one JSON object ($p) and ends by writing its result as one line: "LVMOK <json>". A failure
// the contract has a code for is thrown as "LVM:<CODE>:<text>" (winrm.mjs turns it into that code).
// Written without ${...} so the JavaScript around it leaves the PowerShell alone.
const PRELUDE = String.raw`
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('__PARAMS__')) | ConvertFrom-Json
$root = Join-Path $env:ProgramData 'LightningVM'
function Done($o) { [Console]::Out.WriteLine('LVMOK ' + (ConvertTo-Json -InputObject $o -Depth 8 -Compress)) }
function Fail($code, $text) { throw ('LVM:' + $code + ':' + $text) }
function VmById($id) {
  $g = [guid]::Empty
  if (-not [guid]::TryParse([string]$id, [ref]$g)) { Fail 'INVALID_REQUEST' 'vm is required' }
  $v = Get-VM -Id $g -ErrorAction SilentlyContinue
  if (-not $v) { Fail 'VM_NOT_FOUND' 'the VM no longer exists' }
  $v
}
function Managed($v) { if (-not $v.Name.StartsWith('lvm-')) { Fail 'NOT_MANAGED' 'this VM was not created by the panel' } }
function IsTemplate($v) { ($v.Notes -match 'lvm-template') -or ($v.Name -match '^(template|tpl)[-_ ]') }
function PowerOf($v) { if ($v.State -eq 'Running') { 'poweredOn' } elseif ($v.State -eq 'Paused' -or $v.State -eq 'Saved') { 'suspended' } else { 'poweredOff' } }
function ServerIdOf($v) { if ($v.Notes -match 'Managed by Lightning VM \(server ([0-9a-f-]{36})\)') { $Matches[1] } else { '' } }
function GivenIps($v) { if ($v.Notes -match 'lvm-ips=([0-9a-fA-F.:,]*)') { @($Matches[1].Split(',') | Where-Object { $_ }) } else { @() } }
# The clone task writes the note last, so a VM in the panel's own folder without it is a copy that stopped half-way:
# not a server yet (find), and not one to adopt (clone).
function HalfMade($v) { ([string]$v.Notes -notmatch 'Managed by Lightning VM') -and ([string]$v.Path -like ('?:\LightningVM\' + $v.Name + '*')) }
# The clone task still running for a name: its id (tasks\<name>.task holds it), or nothing. A task that has said
# "running" for six hours has no process any more.
function Pending($name) {
  if ([string]$name -notmatch '^lvm-[\w-]+$') { return }
  $f = Join-Path (Join-Path $root 'tasks') ($name + '.task')
  if (-not (Test-Path -LiteralPath $f)) { return }
  $id = ([string](Get-Content -LiteralPath $f -Raw)).Trim()
  $st = Join-Path (Join-Path $root 'tasks') ($id + '.json')
  if ($id -notmatch '^[0-9a-f-]{36}$' -or -not (Test-Path -LiteralPath $st)) { return }
  if ((Get-Content -LiteralPath $st -Raw | ConvertFrom-Json).state -eq 'running' -and ((Get-Date) - (Get-Item -LiteralPath $st).LastWriteTime).TotalHours -le 6) { $id }
}
# Only administrators, the system and the account these scripts run as (and $more) may read a folder: job files and
# the config drive hold a password hash, first-boot scripts and a token. Files made in it afterwards inherit this.
function Guard($dir, $more) {
  $acl = New-Object Security.AccessControl.DirectorySecurity
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($sid in @('S-1-5-32-544', 'S-1-5-18', [Security.Principal.WindowsIdentity]::GetCurrent().User.Value) + @($more | Where-Object { $_ })) {
    $acl.AddAccessRule((New-Object Security.AccessControl.FileSystemAccessRule((New-Object Security.Principal.SecurityIdentifier($sid)), 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')))
  }
  [IO.Directory]::SetAccessControl($dir, $acl)
}
# Removes one of the panel's folders. Hyper-V lets go of a removed VM's files a little later (it merges checkpoints
# first), so it is tried for a while; $true when the folder is gone.
function Unfolder($dir, $tries) {
  for ($i = 0; $i -lt $tries; $i++) {
    if ($i) { Start-Sleep -Seconds 3 }
    if (Test-Path -LiteralPath $dir) { Remove-Item -LiteralPath $dir -Recurse -Force -ErrorAction SilentlyContinue }
    if (-not (Test-Path -LiteralPath $dir)) { return $true }
  }
  $false
}
function DisksOf($v) {
  @(Get-VMHardDiskDrive -VM $v | Sort-Object ControllerType, ControllerNumber, ControllerLocation | ForEach-Object {
    $size = 0; try { $size = (Get-VHD -Path $_.Path).Size } catch { }
    $base = 0; if ($_.ControllerType -eq 'IDE') { $base = 1000 }
    [ordered]@{ key = $base + $_.ControllerNumber * 100 + $_.ControllerLocation; path = $_.Path; size = $size; controller = ([string]$_.ControllerType + ' ' + $_.ControllerNumber + ':' + $_.ControllerLocation); bus = ([string]$_.ControllerType).ToLower() }
  })
}
function StateOf($v, $guest) {
  $s = [ordered]@{ moref = [string]$v.Id; name = $v.Name; powerState = (PowerOf $v); toolsRunning = $false; ips = @(); serverId = (ServerIdOf $v) }
  if ($guest -and $v.State -eq 'Running') {
    $beat = Get-VMIntegrationService -VM $v | Where-Object { $_.Name -eq 'Heartbeat' -or $_.Id -like '*84EAAE65-2F2E-45F5-9BB5-0E857DC8EB47*' } | Select-Object -First 1
    $ips = @(Get-VMNetworkAdapter -VM $v | ForEach-Object { $_.IPAddresses } | Where-Object { $_ -and $_ -notlike 'fe80:*' })
    # A guest that reports no addresses (a Linux one without hv_kvp_daemon, whose heartbeat is still OK) counts as
    # ready after four minutes with the addresses it was given; before that the heartbeat says only that it runs.
    if ($ips.Count) { $s.toolsRunning = $true; $s.ips = $ips }
    elseif ($v.Uptime.TotalSeconds -gt 240) { $s.toolsRunning = $true; $s.ips = @(GivenIps $v) }
    elseif ($beat -and $beat.PrimaryStatusDescription -eq 'OK') { $s.toolsRunning = $true }
  }
  $s
}
# A process that outlives this WinRM shell (anything started inside it is ended when the shell closes).
function Detach($file) {
  $line = 'powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "' + $file + '"'
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $line }
  if ($r.ReturnValue -ne 0) { Fail 'HYPERV_ERROR' ('could not start the background task (' + $r.ReturnValue + ')') }
}
try {
__BODY__
} catch { [Console]::Out.WriteLine($_.Exception.Message); exit 1 }
`;

const BODIES = {
  discover: String.raw`
  $h = Get-VMHost
  $cpu = @(Get-CimInstance Win32_Processor)
  $cs = Get-CimInstance Win32_ComputerSystem; $os = Get-CimInstance Win32_OperatingSystem
  $volumes = @(Get-Volume | Where-Object { $_.DriveLetter -and $_.DriveType -eq 'Fixed' -and $_.Size -gt 0 } | ForEach-Object { [ordered]@{ letter = [string]$_.DriveLetter; label = $_.FileSystemLabel; size = $_.Size; free = $_.SizeRemaining } })
  $switches = @(Get-VMSwitch | ForEach-Object { [ordered]@{ id = [string]$_.Id; name = $_.Name; type = [string]$_.SwitchType } })
  $vms = @(Get-VM | ForEach-Object { [ordered]@{ id = [string]$_.Id; name = $_.Name; power = (PowerOf $_); cpu = $_.ProcessorCount; memory = $_.MemoryStartup; template = [bool](IsTemplate $_); generation = $_.Generation;
    cpuUsage = $_.CPUUsage; memoryAssigned = $_.MemoryAssigned; uptime = [int]$_.Uptime.TotalSeconds } })
  Done ([ordered]@{ name = $h.Name; uuid = (Get-CimInstance Win32_ComputerSystemProduct).UUID; vendor = $cs.Manufacturer; model = $cs.Model; cpuName = $cpu[0].Name; mhz = $cpu[0].MaxClockSpeed;
    cores = ($cpu | Measure-Object NumberOfCores -Sum).Sum; threads = $h.LogicalProcessorCount; memory = $h.MemoryCapacity; freeMemory = $os.FreePhysicalMemory * 1024; os = $os.Caption; version = $os.Version; build = $os.BuildNumber;
    defaultDisk = $h.VirtualHardDiskPath; volumes = $volumes; switches = $switches; vms = $vms })`,

  find: String.raw`
  $v = Get-VM -Name $p.name -ErrorAction SilentlyContinue | Select-Object -First 1
  # A copy still being made, or one that failed half-way, is not there yet: the worker would start it as it is.
  if ($v -and (HalfMade $v)) { $v = $null }
  if ($v) { Done ([ordered]@{ vm = (StateOf $v $true) }) } else { Done ([ordered]@{ vm = $null }) }`,

  managed: String.raw`
  Done ([ordered]@{ vms = @(Get-VM | Where-Object { $_.Name.StartsWith('lvm-') } | ForEach-Object { StateOf $_ $false }) })`,

  // Starts the copy as a background task and answers at once; the task writes how it went to a file.
  clone: String.raw`
  # Asked again while the copy runs (the first answer was lost): the same task, not a second copy.
  $running = Pending $p.name
  if ($running) { Done ([ordered]@{ task = [string]$running; existed = $false }); return }
  $earlier = Get-VM -Name $p.name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($earlier -and -not (HalfMade $earlier)) { Done ([ordered]@{ vm = [string]$earlier.Id; existed = $true }); return }
  if ($p.mac -and $p.mac -notmatch '^[0-9A-F]{12}$') { Fail 'INVALID_REQUEST' 'mac is twelve hex digits' }
  $g = [guid]::Empty
  if (-not [guid]::TryParse([string]$p.template, [ref]$g)) { Fail 'TEMPLATE_NOT_FOUND' 'the template no longer exists' }
  $t = Get-VM -Id $g -ErrorAction SilentlyContinue
  if (-not $t) { Fail 'TEMPLATE_NOT_FOUND' 'the template no longer exists' }
  if ($t.State -ne 'Off') { Fail 'INVALID_STATE' 'the template must be shut down' }
  $src = @(Get-VMHardDiskDrive -VM $t | Sort-Object ControllerType, ControllerNumber, ControllerLocation)[0]
  if (-not $src) { Fail 'VM_HAS_NO_DISK' 'the template has no disk' }
  if (-not @(Get-VMNetworkAdapter -VM $t).Count) { Fail 'TEMPLATE_HAS_NO_NIC' 'the template has no network interface' }
  if (@(Get-VMSnapshot -VM $t).Count) { Fail 'INVALID_STATE' 'the template has checkpoints; remove them so its disk is one file' }
  if ($p.diskGb -gt 0 -and ([int64]$p.diskGb * 1GB) -lt (Get-VHD -Path $src.Path).Size) { Fail 'DISK_SMALLER_THAN_TEMPLATE' 'the disk is smaller than the template' }
  $sw = Get-VMSwitch | Where-Object { [string]$_.Id -eq $p.network } | Select-Object -First 1
  if (-not $sw) { Fail 'NETWORK_NOT_FOUND' 'the virtual switch no longer exists' }
  if ($p.datastore -notmatch '^[A-Za-z]$' -or -not (Test-Path ($p.datastore + ':\'))) { Fail 'DATASTORE_NOT_FOUND' 'the drive no longer exists' }
  if ($earlier) {
    # What an earlier copy left when it stopped half-way (its task could not clean up: the host restarted) goes first.
    $old = [regex]::Match([string]$earlier.Path, '^[A-Za-z]:\\LightningVM\\' + [regex]::Escape($earlier.Name)).Value
    if ($earlier.State -ne 'Off') { Stop-VM -VM $earlier -TurnOff -Force }
    Remove-VM -VM $earlier -Force
    if (-not (Unfolder $old 10)) { Fail 'HYPERV_ERROR' ('files of an earlier, failed copy are still in use in ' + $old) }
  }
  $tasks = Join-Path $root 'tasks'; New-Item -ItemType Directory -Force -Path $tasks | Out-Null; Guard $tasks
  Get-ChildItem $tasks -File | Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-2) } | Remove-Item -Force -ErrorAction SilentlyContinue
  $id = [guid]::NewGuid().ToString()
  $dir = Join-Path ($p.datastore + ':\LightningVM') $p.name
  # The VM's folder is closed before anything is put in it. Hyper-V's own group (NT VIRTUAL MACHINE\Virtual Machines)
  # stays in: the VM's worker process reads its files as a member of it.
  New-Item -ItemType Directory -Force -Path $dir | Out-Null; Guard $dir 'S-1-5-83-0'
  $job = [ordered]@{ id = $id; name = $p.name; template = [string]$t.Id; source = $src.Path; dir = $dir; switch = $sw.Name; vcpu = $p.vcpu; memoryMb = $p.memoryMb; diskGb = $p.diskGb; nestedHv = [bool]$p.nestedHv; notes = $p.notes; iso = $p.iso; mac = [string]$p.mac }
  [IO.File]::WriteAllText((Join-Path $tasks ($id + '.job.json')), (ConvertTo-Json -InputObject $job -Depth 4 -Compress), [Text.Encoding]::UTF8)
  [IO.File]::WriteAllText((Join-Path $tasks ($id + '.json')), '{"state":"running"}', [Text.Encoding]::ASCII)
  [IO.File]::WriteAllText((Join-Path $tasks ($p.name + '.task')), $id, [Text.Encoding]::ASCII)
  [IO.File]::WriteAllText((Join-Path $tasks ($id + '.ps1')), [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($p.worker)).Replace('__ID__', $id), [Text.Encoding]::UTF8)
  Detach (Join-Path $tasks ($id + '.ps1'))
  Done ([ordered]@{ task = $id; existed = $false })`,

  task: String.raw`
  if ($p.task -notmatch '^[0-9a-f-]{36}$') { Fail 'INVALID_REQUEST' 'task is required' }
  $f = Join-Path (Join-Path $root 'tasks') ($p.task + '.json')
  if (-not (Test-Path $f)) { Done ([ordered]@{ state = 'unknown'; code = 'TASK_NOT_FOUND' }); return }
  $s = Get-Content $f -Raw | ConvertFrom-Json
  # A task that says "running" but whose process is gone (the host restarted) will never finish.
  if ($s.state -eq 'running' -and ((Get-Date) - (Get-Item $f).LastWriteTime).TotalHours -gt 6) { Done ([ordered]@{ state = 'error'; code = 'TASK_FAILED'; error = 'the background task stopped without a result' }); return }
  Done $s`,

  power: String.raw`
  $v = VmById $p.vm
  $on = $v.State -eq 'Running'
  if (($p.action -eq 'on' -and $on) -or (($p.action -eq 'off' -or $p.action -eq 'shutdown') -and $v.State -eq 'Off')) { Done ([ordered]@{ task = '' }); return }
  if ($p.action -eq 'on' -or ($p.action -eq 'reset' -and -not $on)) { Start-VM -VM $v }
  elseif ($p.action -eq 'off') { Stop-VM -VM $v -TurnOff -Force }
  elseif ($p.action -eq 'reset') { Restart-VM -VM $v -Force }
  else {
    # A clean shutdown needs the guest to answer; it can take minutes, so it runs on its own.
    $beat = Get-VMIntegrationService -VM $v | Where-Object { $_.Name -eq 'Shutdown' -or $_.Id -like '*9F8233AC-BE49-4C79-8EE3-E7E1985B2077*' } | Select-Object -First 1
    if (-not $beat -or -not $beat.Enabled) { Fail 'TOOLS_NOT_RUNNING' 'the guest cannot be asked to shut down (integration services)' }
    $tasks = Join-Path $root 'tasks'; New-Item -ItemType Directory -Force -Path $tasks | Out-Null
    $file = Join-Path $tasks ('shutdown-' + [string]$v.Id + '.ps1')
    # Stop-VM takes a name or a VM object, not an id: the VM is looked up by id and handed over.
    [IO.File]::WriteAllText($file, ("Get-VM -Id '" + [string]$v.Id + "' | Stop-VM -Force -ErrorAction SilentlyContinue"), [Text.Encoding]::ASCII)
    Detach $file
  }
  Done ([ordered]@{ task = '' })`,

  destroy: String.raw`
  $g = [guid]::Empty
  $v = $null; if ([guid]::TryParse([string]$p.vm, [ref]$g)) { $v = Get-VM -Id $g -ErrorAction SilentlyContinue }
  $tasks = Join-Path $root 'tasks'; $left = Join-Path $tasks ('destroy-' + [string]$g + '.txt')
  # A folder that would not go is a failure (its files would break a later reinstall under the same name). The VM is
  # gone by then, so which folders were its own is written down first, and a repeated call finishes the job from that.
  $clear = {
    foreach ($dir in @(Get-Content -LiteralPath $left -ErrorAction SilentlyContinue | Where-Object { $_ -match '^[A-Za-z]:\\LightningVM\\lvm-[\w-]+$' })) {
      if (-not (Unfolder $dir 15)) { Fail 'HYPERV_ERROR' ('the VM is removed, but files in ' + $dir + ' are still in use; they are removed when this is asked again') }
    }
    Remove-Item -LiteralPath $left -Force -ErrorAction SilentlyContinue
  }
  if (-not $v) { if (Test-Path -LiteralPath $left) { & $clear }; Done ([ordered]@{ task = ''; gone = $true }); return }
  Managed $v
  if ($v.State -ne 'Off') { Stop-VM -VM $v -TurnOff -Force }
  $paths = @(Get-VMHardDiskDrive -VM $v | ForEach-Object { $_.Path }) + @(Get-VMDvdDrive -VM $v | ForEach-Object { $_.Path } | Where-Object { $_ })
  $name = $v.Name
  # Only the panel's own folder for this server is removed, never a path that merely looks like it.
  $dirs = @($paths | ForEach-Object { Split-Path $_ -Parent } | Where-Object { (Split-Path $_ -Leaf) -eq $name -and (Split-Path (Split-Path $_ -Parent) -Leaf) -eq 'LightningVM' } | Select-Object -Unique)
  if ($dirs.Count) { New-Item -ItemType Directory -Force -Path $tasks | Out-Null; [IO.File]::WriteAllLines($left, [string[]]$dirs) }
  # Removing the VM removes its checkpoints with it; merging them first would only fill files that are deleted next.
  Remove-VM -VM $v -Force
  & $clear
  Done ([ordered]@{ task = '' })`,

  resize: String.raw`
  $v = VmById $p.vm; Managed $v
  $d = @(DisksOf $v)[0]
  if (-not $d) { Fail 'VM_HAS_NO_DISK' 'the VM has no disk' }
  $now = [math]::Ceiling($d.size / 1GB)
  if ($p.diskGb -lt $now) { Fail 'DISK_SHRINK_NOT_SUPPORTED' 'a disk cannot be made smaller' }
  if ($p.diskGb -gt $now -and @(Get-VMSnapshot -VM $v).Count) { Fail 'DISK_HAS_SNAPSHOTS' 'remove the checkpoints before growing the disk' }
  if ($v.State -ne 'Off') { Fail 'INVALID_STATE' 'the server must be shut down to change its size' }
  Set-VM -VM $v -ProcessorCount ([int]$p.vcpu) -StaticMemory -MemoryStartupBytes ([int64]$p.memoryMb * 1MB)
  if ($p.diskGb -gt $now) { Resize-VHD -Path $d.path -SizeBytes ([int64]$p.diskGb * 1GB) }
  Done ([ordered]@{ task = '' })`,

  rename: String.raw`
  $v = VmById $p.vm
  $d = @(DisksOf $v)[0]; $gb = 0; if ($d) { $gb = [int][math]::Ceiling($d.size / 1GB) }
  if ($v.Name -eq $p.name) { Done ([ordered]@{ name = $p.name; diskGb = $gb }); return }
  if ($v.Name.StartsWith('lvm-') -or (IsTemplate $v)) { Fail 'NOT_IMPORTABLE' 'already managed, or a template' }
  Rename-VM -VM $v -NewName $p.name
  Done ([ordered]@{ name = $p.name; diskGb = $gb })`,

  disks: String.raw`
  $v = VmById $p.vm; Managed $v
  Done ([ordered]@{ disks = @(DisksOf $v) })`,

  diskAdd: String.raw`
  $v = VmById $p.vm; Managed $v
  $all = @(DisksOf $v)
  if (-not $all.Count) { Fail 'VM_HAS_NO_DISK' 'the VM has no disk' }
  $dir = Split-Path $all[0].path -Parent
  $n = 1; while (Test-Path (Join-Path $dir ('disk' + $n + '.vhdx'))) { $n++ }
  $path = Join-Path $dir ('disk' + $n + '.vhdx')
  New-VHD -Path $path -SizeBytes ([int64]$p.sizeGb * 1GB) -Dynamic | Out-Null
  try { Add-VMHardDiskDrive -VM $v -ControllerType SCSI -Path $path }
  catch { Remove-Item -LiteralPath $path -Force -ErrorAction SilentlyContinue; Fail 'NO_DISK_CONTROLLER' ('no SCSI controller with a free place: ' + $_.Exception.Message) }
  Done ([ordered]@{ task = '' })`,

  diskRemove: String.raw`
  $v = VmById $p.vm; Managed $v
  $all = @(DisksOf $v)
  $d = $all | Where-Object { $_.key -eq [int]$p.key } | Select-Object -First 1
  if (-not $d) { Done ([ordered]@{ task = ''; gone = $true }); return }
  if ($d.key -eq $all[0].key) { Fail 'SYSTEM_DISK' 'the system disk cannot be removed' }
  Get-VMHardDiskDrive -VM $v | Where-Object { $_.Path -eq $d.path } | Remove-VMHardDiskDrive
  Remove-Item -LiteralPath $d.path -Force -ErrorAction SilentlyContinue
  Done ([ordered]@{ task = '' })`,

  snapshots: String.raw`
  $v = VmById $p.vm
  Done ([ordered]@{ snapshots = @(Get-VMSnapshot -VM $v | Sort-Object CreationTime | ForEach-Object { [ordered]@{ id = [string]$_.Id; name = $_.Name; notes = [string]$_.Notes; created = $_.CreationTime.ToUniversalTime().ToString('o');
    parent = [string]$_.ParentSnapshotId; current = ([string]$v.ParentSnapshotId -eq [string]$_.Id) } }) })`,

  snapshot: String.raw`
  $v = VmById $p.vm
  if ($p.action -eq 'create') { Checkpoint-VM -VM $v -SnapshotName $p.name; Done ([ordered]@{ task = '' }); return }
  $s = Get-VMSnapshot -VM $v | Where-Object { [string]$_.Id -eq $p.snapshot } | Select-Object -First 1
  if (-not $s) { Fail 'SNAPSHOT_NOT_FOUND' 'the checkpoint is not in this VM' }
  if ($p.action -eq 'revert') { Restore-VMSnapshot -VMSnapshot $s -Confirm:$false } else { Remove-VMSnapshot -VMSnapshot $s -Confirm:$false }
  Done ([ordered]@{ task = '' })`,

  details: String.raw`
  $v = VmById $p.vm
  $fw = $null; if ($v.Generation -eq 2) { try { $fw = Get-VMFirmware -VM $v } catch { } }
  $nics = @(Get-VMNetworkAdapter -VM $v | ForEach-Object { [ordered]@{ name = $_.Name; mac = $_.MacAddress; dynamic = [bool]$_.DynamicMacAddressEnabled; switch = $_.SwitchName; connected = [bool]$_.Connected;
    vlan = (Get-VMNetworkAdapterVlan -VMNetworkAdapter $_).AccessVlanId; ips = @($_.IPAddresses | Where-Object { $_ }) } })
  $dvds = @(Get-VMDvdDrive -VM $v | ForEach-Object { [ordered]@{ path = [string]$_.Path } })
  $osName = ''; try { $osName = (Get-CimInstance -Namespace root\virtualization\v2 -ClassName Msvm_SummaryInformation -Filter ("Name='" + [string]$v.Id + "'")).GuestOperatingSystem } catch { }
  Done ([ordered]@{ state = (StateOf $v $true); notes = [string]$v.Notes; generation = $v.Generation; version = [string]$v.Version; secureBoot = ($fw -and [string]$fw.SecureBoot -eq 'On'); uptime = [int]$v.Uptime.TotalSeconds;
    cpu = $v.ProcessorCount; cpuUsage = $v.CPUUsage; memoryStartup = $v.MemoryStartup; memoryAssigned = $v.MemoryAssigned; memoryDemand = $v.MemoryDemand; dynamicMemory = [bool]$v.DynamicMemoryEnabled;
    snapshots = @(Get-VMSnapshot -VM $v).Count; nics = $nics; disks = @(DisksOf $v); dvds = $dvds; guestOs = [string]$osName; host = $env:COMPUTERNAME; path = $v.Path })`,
};

// What runs on its own after "clone" answered: the copy, the VM, its size and its config drive. It records the
// outcome in <id>.json next to itself, which the task route reads.
export const CLONE_WORKER = String.raw`
$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'
$tasks = Join-Path (Join-Path $env:ProgramData 'LightningVM') 'tasks'
$status = Join-Path $tasks '__ID__.json'
function Say($o) { [IO.File]::WriteAllText($status, (ConvertTo-Json -InputObject $o -Compress), [Text.Encoding]::ASCII) }
try {
  $j = Get-Content (Join-Path $tasks '__ID__.job.json') -Raw | ConvertFrom-Json
  $earlier = Get-VM -Name $j.name -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($earlier) { Say ([ordered]@{ state = 'success'; vm = [string]$earlier.Id }); return }
  $mine = $true # from here on, a VM of this name and the folder are this task's own work
  New-Item -ItemType Directory -Force -Path $j.dir | Out-Null
  # The copy keeps the kind of file the template has (a .vhd stays a .vhd).
  $ext = [IO.Path]::GetExtension([string]$j.source).ToLower(); if ($ext -ne '.vhd') { $ext = '.vhdx' }
  $disk = Join-Path $j.dir ('disk0' + $ext)
  Copy-Item -LiteralPath $j.source -Destination $disk -Force
  $t = Get-VM -Id ([guid]$j.template)
  $vm = New-VM -Name $j.name -Generation $t.Generation -MemoryStartupBytes ([int64]$j.memoryMb * 1MB) -VHDPath $disk -SwitchName $j.switch -Path $j.dir
  $set = @{ VM = $vm; ProcessorCount = [int]$j.vcpu; StaticMemory = $true; AutomaticStartAction = 'StartIfRunning'; AutomaticStopAction = 'ShutDown' }
  # Automatic checkpoints are newer than some hosts' Hyper-V module: where Set-VM does not know them, there are none to turn off.
  if ((Get-Command Set-VM).Parameters.ContainsKey('AutomaticCheckpointsEnabled')) { $set.AutomaticCheckpointsEnabled = $false }
  Set-VM @set
  # The address the config drive names the interface by (the guest matches on it, whatever it calls the interface).
  if ($j.mac) { Get-VMNetworkAdapter -VM $vm | Select-Object -First 1 | Set-VMNetworkAdapter -StaticMacAddress $j.mac }
  if ($t.Generation -eq 2) {
    # The same secure boot setting as the template (a Linux template uses the Microsoft UEFI certificate authority).
    $fw = Get-VMFirmware -VM $t
    if ([string]$fw.SecureBoot -eq 'On') { Set-VMFirmware -VM $vm -EnableSecureBoot On -SecureBootTemplate $fw.SecureBootTemplate } else { Set-VMFirmware -VM $vm -EnableSecureBoot Off }
    Set-VMFirmware -VM $vm -FirstBootDevice (Get-VMHardDiskDrive -VM $vm | Select-Object -First 1)
  }
  if ($j.nestedHv) { Set-VMProcessor -VM $vm -ExposeVirtualizationExtensions $true }
  if ($j.diskGb -gt 0 -and ([int64]$j.diskGb * 1GB) -gt (Get-VHD -Path $disk).Size) { Resize-VHD -Path $disk -SizeBytes ([int64]$j.diskGb * 1GB) }
  if ($j.iso) {
    # The cloud-init settings of the server, as a small read-only disc it reads at its first start.
    $iso = Join-Path $j.dir 'cidata.iso'
    [IO.File]::WriteAllBytes($iso, [Convert]::FromBase64String($j.iso))
    Add-VMDvdDrive -VM $vm -Path $iso
  }
  # The note comes last: a VM that carries it is complete (clone and find go by that).
  Set-VM -VM $vm -Notes $j.notes
  Say ([ordered]@{ state = 'success'; vm = [string]$vm.Id })
  Remove-Item -LiteralPath (Join-Path $tasks ($j.name + '.task')) -Force -ErrorAction SilentlyContinue
} catch {
  $text = $_.Exception.Message
  # Nothing half-made stays behind for a retry to find.
  if ($mine) {
    try { Get-VM -Name $j.name -ErrorAction SilentlyContinue | ForEach-Object { if ($_.State -ne 'Off') { Stop-VM -VM $_ -TurnOff -Force }; Remove-VM -VM $_ -Force } } catch { }
    Remove-Item -LiteralPath $j.dir -Recurse -Force -ErrorAction SilentlyContinue
  }
  $code = 'TASK_FAILED'
  if ($text -match 'not enough|insufficient|disk space') { $code = 'INSUFFICIENT_RESOURCES' } elseif ($text -match 'already exists') { $code = 'DUPLICATE_NAME' } elseif ($text -match 'denied') { $code = 'PERMISSION_DENIED' }
  Say ([ordered]@{ state = 'error'; code = $code; error = $text })
} finally { Remove-Item (Join-Path $tasks '__ID__.job.json'), (Join-Path $tasks '__ID__.ps1') -Force -ErrorAction SilentlyContinue } # the job file holds the config drive
`;

export const names = Object.keys(BODIES);
// The script for one operation, with its parameters inside.
export function script(name, params = {}) {
  if (!BODIES[name]) throw new Error(`no such script: ${name}`);
  return PRELUDE.replace('__PARAMS__', Buffer.from(JSON.stringify(params), 'utf8').toString('base64')).replace('__BODY__', () => BODIES[name]);
}
