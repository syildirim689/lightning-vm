<?php
/**
 * Lightning VM provisioning module for WHMCS.
 *
 * Server (Setup → Products/Services → Servers): Hostname = the panel's address (panel.example.com),
 * Password = a full-access API token of a staff account (Account → API in the panel), Secure = on.
 * Product (Module Settings): the location (resource pool) id, the package id and the image id from the panel's
 * catalog. Each WHMCS service is one panel server; WHMCS bills it, the panel never does.
 */

if (!defined('WHMCS')) {
    die('This file cannot be accessed directly');
}

function lightningvm_MetaData()
{
    return [
        'DisplayName' => 'Lightning VM',
        'APIVersion' => '1.1',
        'RequiresServer' => true,
        'DefaultSSLPort' => '443',
        'ServiceSingleSignOnLabel' => 'Open the panel',
    ];
}

function lightningvm_ConfigOptions()
{
    return [
        'Location' => ['Type' => 'text', 'Size' => '40', 'Description' => 'Resource pool id (Catalog → Resource pools)', 'Loader' => 'lightningvm_LoadPools', 'SimpleMode' => true],
        'Package' => ['Type' => 'text', 'Size' => '40', 'Description' => 'Package id (Catalog → Packages)', 'Loader' => 'lightningvm_LoadPackages', 'SimpleMode' => true],
        'Image' => ['Type' => 'text', 'Size' => '40', 'Description' => 'Operating system image id; a configurable option named "Image" overrides it', 'Loader' => 'lightningvm_LoadImages', 'SimpleMode' => true],
    ];
}

/** One call to the panel's API; returns the decoded JSON or throws with the panel's error code. */
function lightningvm_api(array $params, $method, $path, $body = null, $idempotencyKey = null)
{
    $scheme = (!isset($params['serversecure']) || $params['serversecure']) ? 'https' : 'http';
    $host = $params['serverhostname'] ?: $params['serverip'];
    $url = $scheme . '://' . $host . '/api' . $path;
    $headers = ['Authorization: Bearer ' . $params['serverpassword'], 'Accept: application/json'];
    if ($body !== null) {
        $headers[] = 'Content-Type: application/json';
    }
    if ($idempotencyKey) {
        $headers[] = 'Idempotency-Key: ' . $idempotencyKey;
    }
    $ch = curl_init($url);
    curl_setopt_array($ch, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_HTTPHEADER => $headers,
        CURLOPT_TIMEOUT => 60,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_SSL_VERIFYPEER => true,
    ]);
    if ($body !== null) {
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
    }
    $raw = curl_exec($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    $error = curl_error($ch);
    curl_close($ch);
    $data = json_decode((string) $raw, true);
    logModuleCall('lightningvm', $method . ' ' . $path, $body, $raw, $data, [$params['serverpassword']]);
    if ($raw === false) {
        throw new Exception('Panel unreachable: ' . $error);
    }
    if ($status >= 400) {
        $code = is_array($data) && isset($data['code']) ? $data['code'] : 'HTTP_' . $status;
        $fields = is_array($data) && isset($data['fields']) ? ' ' . json_encode($data['fields']) : '';
        throw new Exception($code . (is_array($data) && isset($data['message']) ? ': ' . $data['message'] : '') . $fields);
    }
    return is_array($data) ? $data : [];
}

/** The service's reference in the panel: the WHMCS service id. */
function lightningvm_ref(array $params)
{
    return 'svc-' . (int) $params['serviceid'];
}

/** A host name for the server: the service's domain if it is one, else "whmcs-<service id>". */
function lightningvm_hostname(array $params)
{
    $name = strtolower(preg_replace('/[^a-z0-9-]+/i', '-', explode('.', (string) $params['domain'])[0]));
    $name = trim(substr($name, 0, 63), '-');
    return $name !== '' ? $name : 'whmcs-' . (int) $params['serviceid'];
}

function lightningvm_option(array $params, $name, $fallback)
{
    return isset($params['configoptions'][$name]) && $params['configoptions'][$name] !== '' ? $params['configoptions'][$name] : $fallback;
}

function lightningvm_TestConnection(array $params)
{
    try {
        $me = lightningvm_api($params, 'GET', '/auth/me');
        $perms = isset($me['permissions']) ? $me['permissions'] : [];
        if (!in_array('*', $perms, true) && !in_array('servers.manage_all', $perms, true)) {
            return ['success' => false, 'error' => 'The token belongs to an account without "manage all servers".'];
        }
        return ['success' => true, 'error' => ''];
    } catch (Exception $e) {
        return ['success' => false, 'error' => $e->getMessage()];
    }
}

function lightningvm_CreateAccount(array $params)
{
    try {
        $client = $params['clientsdetails'];
        $customer = lightningvm_api($params, 'POST', '/admin/external/whmcs/customers', [
            'email' => $client['email'],
            'name' => trim($client['firstname'] . ' ' . $client['lastname']),
            'locale' => (isset($client['language']) && stripos($client['language'], 'turkish') === 0) ? 'tr' : 'en',
        ]);
        $body = [
            'reference' => lightningvm_ref($params),
            'customerId' => $customer['id'],
            'type' => 'package',
            'poolId' => lightningvm_option($params, 'Location', $params['configoption1']),
            'packageId' => lightningvm_option($params, 'Package', $params['configoption2']),
            'imageId' => lightningvm_option($params, 'Image', $params['configoption3']),
            'name' => lightningvm_hostname($params),
        ];
        if (!empty($params['password'])) {
            $body['rootPassword'] = $params['password'];
        }
        $key = isset($params['customfields']['SSH Key']) ? trim($params['customfields']['SSH Key']) : '';
        if ($key !== '') {
            $body['sshKey'] = $key;
        }
        lightningvm_api($params, 'POST', '/admin/external/whmcs/servers', $body);
        return 'success';
    } catch (Exception $e) {
        return $e->getMessage();
    }
}

function lightningvm_action(array $params, $action, $body = null)
{
    try {
        lightningvm_api($params, 'POST', '/admin/external/whmcs/servers/' . lightningvm_ref($params) . '/' . $action, $body ?: new stdClass());
        return 'success';
    } catch (Exception $e) {
        return $e->getMessage();
    }
}

function lightningvm_SuspendAccount(array $params)
{
    return lightningvm_action($params, 'suspend');
}

function lightningvm_UnsuspendAccount(array $params)
{
    return lightningvm_action($params, 'unsuspend');
}

function lightningvm_TerminateAccount(array $params)
{
    try {
        lightningvm_api($params, 'DELETE', '/admin/external/whmcs/servers/' . lightningvm_ref($params));
        return 'success';
    } catch (Exception $e) {
        return strpos($e->getMessage(), 'NOT_FOUND') === 0 ? 'success' : $e->getMessage(); // already gone
    }
}

/** Upgrade or downgrade: the product's (new) package; the disk only grows. */
function lightningvm_ChangePackage(array $params)
{
    return lightningvm_action($params, 'resize', ['type' => 'package', 'packageId' => lightningvm_option($params, 'Package', $params['configoption2'])]);
}

function lightningvm_PowerOn(array $params)
{
    return lightningvm_action($params, 'power_on');
}

function lightningvm_Shutdown(array $params)
{
    return lightningvm_action($params, 'shutdown');
}

function lightningvm_Reset(array $params)
{
    return lightningvm_action($params, 'reset');
}

function lightningvm_AdminCustomButtonArray()
{
    return ['Power on' => 'PowerOn', 'Shut down' => 'Shutdown', 'Reset' => 'Reset'];
}

function lightningvm_ClientAreaCustomButtonArray()
{
    return ['Power on' => 'PowerOn', 'Shut down' => 'Shutdown', 'Reset' => 'Reset'];
}

function lightningvm_AdminServicesTabFields(array $params)
{
    try {
        $s = lightningvm_api($params, 'GET', '/admin/external/whmcs/servers/' . lightningvm_ref($params));
        return [
            'Panel server' => htmlspecialchars($s['name'] . ' (' . $s['serverId'] . ')'),
            'State' => htmlspecialchars($s['state'] . ' / ' . $s['powerState'] . ($s['suspended'] ? ' / suspended' : '')),
            'IP address' => htmlspecialchars((string) $s['address']),
            'Size' => (int) $s['vcpu'] . ' vCPU, ' . round($s['memoryMb'] / 1024, 1) . ' GB, ' . (int) $s['diskGb'] . ' GB',
        ];
    } catch (Exception $e) {
        return ['Panel server' => htmlspecialchars($e->getMessage())];
    }
}

function lightningvm_ClientArea(array $params)
{
    try {
        $s = lightningvm_api($params, 'GET', '/admin/external/whmcs/servers/' . lightningvm_ref($params));
    } catch (Exception $e) {
        $s = ['error' => $e->getMessage()];
    }
    $scheme = (!isset($params['serversecure']) || $params['serversecure']) ? 'https' : 'http';
    return [
        'tabOverviewReplacementTemplate' => 'templates/overview.tpl',
        'templateVariables' => [
            'server' => $s,
            'panelUrl' => $scheme . '://' . ($params['serverhostname'] ?: $params['serverip']) . (isset($s['serverId']) ? '/servers/' . $s['serverId'] : ''),
        ],
    ];
}

/** Single sign-on is the panel's own sign-in: the customer sets a password with "Forgot password" the first time. */
function lightningvm_ServiceSingleSignOn(array $params)
{
    $scheme = (!isset($params['serversecure']) || $params['serversecure']) ? 'https' : 'http';
    return ['success' => true, 'redirectTo' => $scheme . '://' . ($params['serverhostname'] ?: $params['serverip']) . '/login'];
}

/** Drop-downs in the product's module settings, read from the panel's catalog. */
function lightningvm_catalog(array $params, $key, callable $label)
{
    $catalog = lightningvm_api($params, 'GET', '/catalog');
    $out = [];
    foreach ($catalog[$key] as $item) {
        $out[$item['id']] = $label($item);
    }
    return $out;
}

function lightningvm_LoadPools(array $params)
{
    return lightningvm_catalog($params, 'pools', function ($p) { return $p['name'] . ($p['location'] ? ' · ' . $p['location'] : ''); });
}

function lightningvm_LoadPackages(array $params)
{
    return lightningvm_catalog($params, 'packages', function ($p) { return $p['name'] . ' (' . $p['vcpu'] . ' vCPU, ' . ($p['memoryMb'] / 1024) . ' GB, ' . $p['diskGb'] . ' GB)'; });
}

function lightningvm_LoadImages(array $params)
{
    return lightningvm_catalog($params, 'images', function ($i) { return $i['name']; });
}
