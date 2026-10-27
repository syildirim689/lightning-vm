<?php
/**
 * Lightning VM product module for WISECP.
 *
 * NOT TESTED against a WISECP installation: written from WISECP's product-module structure (a class named like the
 * folder extending ProductModule, with create/suspend/unsuspend/terminate/apply_updowngrade). Check it on a test
 * WISECP before selling with it. The calls to the panel are the same as the tested WHMCS module's (external.ts).
 *
 * Server settings: Host name = the panel's address, Password = a full-access API token of a staff account.
 * Product settings: location (resource pool) id, package id and image id from the panel's catalog.
 */

if (!defined('CORE_FOLDER')) {
    die('This file cannot be accessed directly');
}

class LightningVM extends ProductModule
{
    public $config = [];

    public function __construct()
    {
        $this->_name = __CLASS__;
        parent::__construct();
        $this->config = include __DIR__ . DS . 'config.php';
    }

    /** Fields of the product's module settings. */
    public function config_options($data = [])
    {
        return [
            'pool_id' => ['name' => 'Location (resource pool id)', 'type' => 'text', 'value' => isset($data['pool_id']) ? $data['pool_id'] : ''],
            'package_id' => ['name' => 'Package id', 'type' => 'text', 'value' => isset($data['package_id']) ? $data['package_id'] : ''],
            'image_id' => ['name' => 'Image id', 'type' => 'text', 'value' => isset($data['image_id']) ? $data['image_id'] : ''],
        ];
    }

    private function api($method, $path, $body = null)
    {
        $host = !empty($this->server['name']) ? $this->server['name'] : $this->server['ip'];
        $ch = curl_init('https://' . $host . '/api' . $path);
        $headers = ['Authorization: Bearer ' . $this->server['password'], 'Accept: application/json'];
        if ($body !== null) {
            $headers[] = 'Content-Type: application/json';
        }
        curl_setopt_array($ch, [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_HTTPHEADER => $headers, CURLOPT_TIMEOUT => 60]);
        if ($body !== null) {
            curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($body));
        }
        $raw = curl_exec($ch);
        $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);
        $data = json_decode((string) $raw, true);
        if ($raw === false || $status >= 400) {
            $this->error = is_array($data) && isset($data['code']) ? $data['code'] . (isset($data['message']) ? ': ' . $data['message'] : '') : 'Panel unreachable';
            return false;
        }
        return is_array($data) ? $data : [];
    }

    private function ref()
    {
        return 'order-' . (int) $this->order['id'];
    }

    public function testConnect()
    {
        $me = $this->api('GET', '/auth/me');
        if ($me === false) {
            return false;
        }
        $perms = isset($me['permissions']) ? $me['permissions'] : [];
        if (!in_array('*', $perms, true) && !in_array('servers.manage_all', $perms, true)) {
            $this->error = 'The token belongs to an account without "manage all servers".';
            return false;
        }
        return true;
    }

    public function create($order_options = [])
    {
        $user = $this->user;
        $customer = $this->api('POST', '/admin/external/wisecp/customers', ['email' => $user['email'], 'name' => trim($user['name'] . ' ' . $user['surname'])]);
        if ($customer === false) {
            return false;
        }
        $o = $this->options;
        $name = strtolower(preg_replace('/[^a-z0-9-]+/i', '-', isset($order_options['hostname']) ? $order_options['hostname'] : ''));
        $body = ['reference' => $this->ref(), 'customerId' => $customer['id'], 'type' => 'package', 'poolId' => $o['pool_id'], 'packageId' => $o['package_id'],
            'imageId' => $o['image_id'], 'name' => trim(substr($name, 0, 63), '-') ?: 'wisecp-' . (int) $this->order['id']];
        if (!empty($order_options['password'])) {
            $body['rootPassword'] = $order_options['password'];
        }
        return $this->api('POST', '/admin/external/wisecp/servers', $body) !== false;
    }

    private function action($action, $body = null)
    {
        return $this->api('POST', '/admin/external/wisecp/servers/' . $this->ref() . '/' . $action, $body ?: new stdClass()) !== false;
    }

    public function suspend()
    {
        return $this->action('suspend');
    }

    public function unsuspend()
    {
        return $this->action('unsuspend');
    }

    public function terminate()
    {
        $ok = $this->api('DELETE', '/admin/external/wisecp/servers/' . $this->ref());
        return $ok !== false || strpos((string) $this->error, 'NOT_FOUND') === 0;
    }

    public function apply_updowngrade($params = [])
    {
        $package = isset($params['package_id']) ? $params['package_id'] : $this->options['package_id'];
        return $this->action('resize', ['type' => 'package', 'packageId' => $package]);
    }

    public function adminArea_buttons()
    {
        return ['power_on' => ['text' => 'Power on'], 'shutdown' => ['text' => 'Shut down'], 'reset' => ['text' => 'Reset']];
    }

    public function use_adminArea_power_on()
    {
        return $this->action('power_on');
    }

    public function use_adminArea_shutdown()
    {
        return $this->action('shutdown');
    }

    public function use_adminArea_reset()
    {
        return $this->action('reset');
    }

    public function clientArea()
    {
        $s = $this->api('GET', '/admin/external/wisecp/servers/' . $this->ref());
        if ($s === false) {
            return '<div class="red-info">' . htmlspecialchars((string) $this->error) . '</div>';
        }
        $host = !empty($this->server['name']) ? $this->server['name'] : $this->server['ip'];
        return '<table class="table"><tr><th>Server</th><td>' . htmlspecialchars($s['name']) . '</td></tr>'
            . '<tr><th>IP</th><td>' . htmlspecialchars((string) $s['address']) . '</td></tr>'
            . '<tr><th>Status</th><td>' . htmlspecialchars($s['state'] . ' / ' . $s['powerState']) . '</td></tr></table>'
            . '<a class="lbtn" target="_blank" rel="noopener" href="https://' . htmlspecialchars($host) . '/servers/' . htmlspecialchars($s['serverId']) . '">Open in the panel</a>';
    }
}
