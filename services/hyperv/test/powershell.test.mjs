// The PowerShell itself, as far as it goes without a Hyper-V host (Windows only: it needs Windows PowerShell).
// Every script is put through the real parser, and every Hyper-V cmdlet call in it is held against the parameter
// sets Microsoft documents (learn.microsoft.com/powershell/module/hyper-v): a parameter a cmdlet does not have, or
// two that are not in one set, fails here instead of on a customer's host. The parts that need no Hyper-V (the
// folder's access list, removing a folder, finding a running task) are run for real in a temporary folder.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CLONE_WORKER, names, script } from '../scripts.mjs';

const exe = 'powershell.exe';
const skip = (process.platform !== 'win32' || spawnSync(exe, ['-NoProfile', '-Command', 'exit 0']).status !== 0) && 'needs Windows PowerShell';
const ps = (file, env = {}) => spawnSync(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', file], { encoding: 'utf8', env: { ...process.env, ...env } });

// The parameter sets of the cmdlets the scripts use, as documented (only the parameters of interest here). A call
// must fit into one set; the object a pipeline hands over counts as that set's first parameter.
const SETS = {
  'Get-VM': [['Name'], ['Id']], 'Get-VMHost': [[]], 'Get-VMSwitch': [[]], 'Get-VHD': [['Path']],
  'Start-VM': [['Name'], ['VM']], 'Stop-VM': [['Name', 'Save', 'TurnOff', 'Force'], ['VM', 'Save', 'TurnOff', 'Force']], 'Restart-VM': [['Name', 'Force'], ['VM', 'Force']],
  'Remove-VM': [['Name', 'Force'], ['VM', 'Force']], 'Rename-VM': [['VM', 'NewName'], ['Name', 'NewName']],
  'New-VM': [['Name', 'MemoryStartupBytes', 'Generation', 'VHDPath', 'SwitchName', 'Path']], 'New-VHD': [['Path', 'SizeBytes', 'Dynamic']], 'Resize-VHD': [['Path', 'SizeBytes']],
  'Set-VM': [['VM', 'ProcessorCount', 'StaticMemory', 'MemoryStartupBytes', 'Notes', 'AutomaticStartAction', 'AutomaticStopAction', 'AutomaticCheckpointsEnabled']],
  'Set-VMProcessor': [['VM', 'ExposeVirtualizationExtensions']], 'Get-VMFirmware': [['VM']], 'Set-VMFirmware': [['VM', 'EnableSecureBoot', 'SecureBootTemplate', 'FirstBootDevice']],
  'Get-VMHardDiskDrive': [['VM']], 'Add-VMHardDiskDrive': [['VM', 'ControllerType', 'Path']], 'Remove-VMHardDiskDrive': [['VMHardDiskDrive']],
  'Get-VMDvdDrive': [['VM']], 'Add-VMDvdDrive': [['VM', 'Path']], 'Get-VMIntegrationService': [['VM']],
  'Get-VMNetworkAdapter': [['VM']], 'Set-VMNetworkAdapter': [['VMNetworkAdapter', 'StaticMacAddress']], 'Get-VMNetworkAdapterVlan': [['VMNetworkAdapter']],
  'Get-VMSnapshot': [['VM']], 'Checkpoint-VM': [['VM', 'SnapshotName']], 'Restore-VMSnapshot': [['VMSnapshot']], 'Remove-VMSnapshot': [['VMSnapshot', 'IncludeAllChildSnapshots']],
};
const COMMON = ['ErrorAction', 'Confirm', 'WhatIf'];
const LIST = String.raw`
param($dir)
$A = [System.Management.Automation.Language.CommandAst]; $P = [System.Management.Automation.Language.CommandParameterAst]
$out = foreach ($f in Get-ChildItem $dir -Filter *.ps1) {
  $tokens = $null; $errors = $null
  $ast = [System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors)
  foreach ($e in $errors) { [pscustomobject]@{ file = $f.Name; error = $e.Message; line = $e.Extent.StartLineNumber } }
  foreach ($c in $ast.FindAll({ $args[0] -is $A }, $true)) {
    [pscustomobject]@{ file = $f.Name; cmd = [string]$c.GetCommandName(); line = $c.Extent.StartLineNumber; text = $c.Extent.Text
      params = @($c.CommandElements | Where-Object { $_ -is $P } | ForEach-Object { $_.ParameterName }) }
  }
}
ConvertTo-Json -InputObject @($out) -Depth 4 -Compress
`;

test('every script parses, and every Hyper-V cmdlet is called with parameters of one documented set', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'lvm-ps-'));
  try {
    for (const n of names) writeFileSync(join(dir, `${n}.ps1`), script(n, { vm: '00000000-0000-4000-8000-000000000001', name: 'lvm-x' }));
    writeFileSync(join(dir, 'worker.ps1'), CLONE_WORKER);
    // The line the power script writes into a file of its own, to run after the shell has closed.
    const line = /WriteAllText\(\$file, \("([^"]+)" \+ \[string\]\$v\.Id \+ "([^"]+)"\)/.exec(script('power'));
    writeFileSync(join(dir, 'shutdown.ps1'), `${line[1]}00000000-0000-4000-8000-000000000001${line[2]}`);
    mkdirSync(join(dir, 'tool')); writeFileSync(join(dir, 'tool', 'list.ps1'), LIST);
    const r = spawnSync(exe, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'tool', 'list.ps1'), dir], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const found = JSON.parse(r.stdout);
    assert.deepEqual(found.filter((x) => x.error), [], 'no parse errors');
    const calls = found.filter((x) => /-V(M|HD)/i.test(x.cmd));
    assert.ok(calls.length > 60 && found.some((x) => x.file === 'shutdown.ps1' && x.cmd === 'Stop-VM'));
    for (const c of calls) {
      const sets = SETS[c.cmd];
      assert.ok(sets, `${c.file}:${c.line} ${c.cmd} is not in the table of documented cmdlets`);
      const used = c.params.filter((p) => !COMMON.includes(p));
      assert.ok(sets.some((s) => used.every((p) => s.includes(p))), `${c.file}:${c.line} "${c.text}": ${used.join(', ')} are not in one parameter set of ${c.cmd}`);
    }
    // The table does its job: the call this file was written for is refused.
    assert.ok(!SETS['Stop-VM'].some((s) => ['Id', 'Force'].every((p) => s.includes(p))));
    // What is splatted into Set-VM (the parser sees no parameter names there).
    const splat = /\$set = @\{([^}]*)\}/.exec(CLONE_WORKER)[1].split(';').map((kv) => kv.split('=')[0].trim());
    for (const k of [...splat, 'AutomaticCheckpointsEnabled']) assert.ok(SETS['Set-VM'][0].includes(k), k);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the helpers that need no Hyper-V do what they say: closed folders, a folder removed, a running task found', { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'lvm-ps-'));
  try {
    const whole = script('task', { task: '00000000-0000-4000-8000-000000000009' });
    const body = String.raw`
  $tasks = Join-Path $root 'tasks'; New-Item -ItemType Directory -Force -Path $tasks | Out-Null
  $open = @((Get-Acl $tasks).Access | Where-Object { $_.IsInherited }).Count
  Guard $tasks; Guard (New-Item -ItemType Directory -Force -Path (Join-Path $root 'vm')).FullName 'S-1-5-83-0'
  $sids = { param($d) @((Get-Acl $d).Access | ForEach-Object { $_.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value } | Sort-Object) }
  [IO.File]::WriteAllText((Join-Path $tasks 'x.job.json'), '{}')
  $id = '00000000-0000-4000-8000-000000000009'
  $none = [string](Pending 'lvm-a')
  [IO.File]::WriteAllText((Join-Path $tasks 'lvm-a.task'), $id); [IO.File]::WriteAllText((Join-Path $tasks ($id + '.json')), '{"state":"running"}')
  $running = [string](Pending 'lvm-a')
  [IO.File]::WriteAllText((Join-Path $tasks ($id + '.json')), '{"state":"error"}')
  $v = [pscustomobject]@{ Name = 'lvm-a'; Notes = ''; Path = 'D:\LightningVM\lvm-a\lvm-a' }
  $half = [bool](HalfMade $v); $v.Notes = "Managed by Lightning VM (server x)"; $whole = [bool](HalfMade $v)
  $v.Notes = ''; $v.Path = 'D:\Hyper-V\lvm-a'; $foreign = [bool](HalfMade $v)
  $sub = Join-Path $root 'gone\deep'; New-Item -ItemType Directory -Force -Path $sub | Out-Null; [IO.File]::WriteAllText((Join-Path $sub 'f'), 'x')
  Done ([ordered]@{ me = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value; inheritedBefore = $open; tasks = (& $sids $tasks); vm = (& $sids (Join-Path $root 'vm')); protected = (Get-Acl $tasks).AreAccessRulesProtected
    fileInherits = @((Get-Acl (Join-Path $tasks 'x.job.json')).Access | Where-Object { -not $_.IsInherited }).Count; none = $none; running = $running; failed = [string](Pending 'lvm-a'); odd = [string](Pending '..\x')
    half = $half; whole = $whole; foreign = $foreign; removed = (Unfolder (Join-Path $root 'gone') 1); again = (Unfolder (Join-Path $root 'gone') 1) })`;
    const at = whole.indexOf('try {\n'), end = whole.lastIndexOf('} catch {');
    writeFileSync(join(dir, 'helpers.ps1'), `${whole.slice(0, at)}try {${body}\n${whole.slice(end)}`);
    const r = ps(join(dir, 'helpers.ps1'), { ProgramData: dir });
    const out = JSON.parse(/^LVMOK (.*)$/m.exec(r.stdout)?.[1] ?? `"${r.stdout} ${r.stderr}"`);
    const mine = ['S-1-5-18', 'S-1-5-32-544', out.me].sort();
    assert.deepEqual([out.tasks, out.protected, out.fileInherits], [[...new Set(mine)], true, 0], 'administrators, the system and the account itself, nothing inherited from above; files take it over');
    assert.deepEqual(out.vm, [...new Set([...mine, 'S-1-5-83-0'])].sort(), 'the VM folder also lets Hyper-V\'s own group in');
    assert.deepEqual([out.none, out.running, out.failed, out.odd], [null, '00000000-0000-4000-8000-000000000009', null, null]);
    assert.deepEqual([out.half, out.whole, out.foreign], [true, false, false], 'half-made: in the panel\'s folder and without the note');
    assert.deepEqual([out.removed, out.again, existsSync(join(dir, 'LightningVM', 'gone'))], [true, true, false]);
    // The task script itself, as the adapter sends it, reads the state written above.
    writeFileSync(join(dir, 'task.ps1'), whole);
    assert.match(ps(join(dir, 'task.ps1'), { ProgramData: dir }).stdout, /^LVMOK \{"state":"error"\}/m);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
