<div class="card">
  <div class="card-body">
    <h3 class="card-title">{$product}</h3>
    {if $server.error}
      <div class="alert alert-warning">{$server.error|escape}</div>
    {else}
      <table class="table">
        <tr><th>{$LANG.serverhostname|default:'Server'}</th><td>{$server.name|escape}</td></tr>
        <tr><th>IP</th><td><code>{$server.address|escape}</code></td></tr>
        <tr><th>{$LANG.clientareastatus|default:'Status'}</th><td>{$server.state|escape} · {$server.powerState|escape}{if $server.suspended} · suspended{/if}</td></tr>
        <tr><th>vCPU / RAM / Disk</th><td>{$server.vcpu} vCPU · {math equation="m / 1024" m=$server.memoryMb} GB · {$server.diskGb} GB</td></tr>
      </table>
      <a class="btn btn-primary" href="{$panelUrl|escape}" target="_blank" rel="noopener">Open in the panel (console, snapshots, firewall)</a>
    {/if}
  </div>
</div>
