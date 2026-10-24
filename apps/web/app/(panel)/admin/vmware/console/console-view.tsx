"use client";
import { useTranslations } from 'next-intl';
import { useEffect, useRef, useState } from 'react';
import { apiFetch, useErrorText } from '../../../../../lib/api';

// Minimal typing of the operator-provided VMware HTML Console SDK (wmks.min.js), per its programming guide.
type Wmks = { register: (event: string, fn: (e: unknown, data: { state?: string; code?: number; reason?: string }) => void) => Wmks;
  connect: (url: string) => void; disconnect: () => void; destroy: () => void; sendCAD: () => void };
declare global { interface Window { WMKS?: { createWMKS: (id: string, opts: object) => Wmks; CONST: { Events: Record<string, string>; ConnectionState: Record<string, string> } } } }

type State = 'requesting' | 'loadingSdk' | 'sdkMissing' | 'connecting' | 'connected' | 'closed' | 'error';
const gatewayUrl = () => `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/console/ws`;
// Close reasons the gateway sends; anything else is shown as a generic disconnect.
const knownReasons = ['CONSOLE_SESSION_INVALID', 'CONSOLE_REVOKED', 'CONSOLE_EXPIRED', 'CONSOLE_LIMIT', 'CONSOLE_UNREACHABLE',
  'CONSOLE_TLS_MISMATCH', 'CONSOLE_TICKET_REJECTED', 'CONSOLE_ENDPOINT_BLOCKED', 'CONSOLE_CLOSED'];

function load(tag: 'script' | 'link', src: string) {
  return new Promise<void>((resolve, reject) => {
    const el = document.createElement(tag);
    if (tag === 'script') (el as HTMLScriptElement).src = src;
    else Object.assign(el as HTMLLinkElement, { rel: 'stylesheet', href: src });
    el.onload = () => resolve(); el.onerror = () => reject(new Error(src));
    document.head.appendChild(el);
  });
}

// Each request issues a fresh one-time console session (HttpOnly cookie, 60 s) for this VM.
const requestSession = (sessionPath: string) => apiFetch<{ vmName: string }>(sessionPath, { method: 'POST' });

// sessionPath: the admin route for any inventory VM, or the customer route for an owned server.
export default function ConsoleView({ sessionPath, title }: { sessionPath: string; title: string }) {
  const t = useTranslations('Console');
  const { error } = useErrorText();
  const [state, setState] = useState<State>('requesting');
  const [detail, setDetail] = useState<string>();
  const [vmName, setVmName] = useState<string>();
  const [probe, setProbe] = useState<string>();
  const wmks = useRef<Wmks>(undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const sdk = await fetch('/console-sdk/wmks.min.js', { method: 'HEAD' });
        if (!sdk.ok) { setState('sdkMissing'); return; }
        const session = await requestSession(sessionPath);
        if (cancelled) return;
        setVmName(session.vmName);
        setState('loadingSdk');
        await load('link', '/console-sdk/css/wmks-all.css').catch(() => undefined);
        await load('script', '/console-sdk/jquery.min.js');
        await load('script', '/console-sdk/jquery-ui.min.js');
        await load('script', '/console-sdk/wmks.min.js');
        const W = window.WMKS;
        if (!W || cancelled) { setState('sdkMissing'); return; }
        setState('connecting');
        wmks.current = W.createWMKS('wmks-container', {}).register(W.CONST.Events.CONNECTION_STATE_CHANGE, (_e, data) => {
          if (data.state === W.CONST.ConnectionState.CONNECTED) setState('connected');
          if (data.state === W.CONST.ConnectionState.DISCONNECTED) {
            setState('closed');
            setDetail(knownReasons.includes(data.reason ?? '') ? t(`reason.${data.reason as 'CONSOLE_CLOSED'}`) : t('reason.CONSOLE_CLOSED'));
          }
        });
        wmks.current.connect(gatewayUrl());
      } catch (e) {
        if (!cancelled) { setState('error'); setDetail(error(e)); }
      }
    })();
    return () => { cancelled = true; wmks.current?.disconnect(); wmks.current?.destroy(); };
  }, [sessionPath]); // eslint-disable-line react-hooks/exhaustive-deps

  // Diagnostic without the SDK: opens the gateway WebSocket with a fresh session and reports whether
  // the VM's console endpoint answered (network path, pinned TLS and ticket all worked), then closes.
  async function testGateway() {
    setProbe(t('probe.running'));
    try {
      setVmName((await requestSession(sessionPath)).vmName);
    } catch (e) { setProbe(error(e)); return; }
    const ws = new WebSocket(gatewayUrl(), ['binary']);
    let received = 0;
    ws.onmessage = (m) => { received += typeof m.data === 'string' ? m.data.length : 1; if (received) { setProbe(t('probe.ok')); ws.close(1000); } };
    ws.onclose = (e) => { if (!received) setProbe(knownReasons.includes(e.reason) ? t(`reason.${e.reason as 'CONSOLE_CLOSED'}`) : t('probe.failed', { code: e.code })); };
  }

  return <article className="console">
    <h1>{t('title', { name: vmName ?? title })}</h1>
    <p className="notice">{t('osLogin')}</p>
    <p role="status">{t(`state.${state}`)}{detail && ` · ${detail}`}</p>
    {state === 'sdkMissing' && <div className="notice"><p>{t('sdkMissing')}</p><pre><code>console-sdk/wmks.min.js{'\n'}console-sdk/jquery.min.js{'\n'}console-sdk/jquery-ui.min.js{'\n'}console-sdk/css/wmks-all.css</code></pre></div>}
    <div id="wmks-container" className="wmks" hidden={state !== 'connected' && state !== 'connecting'}/>
    <div className="actions">
      {state === 'connected' && <button type="button" className="secondary" onClick={() => wmks.current?.sendCAD()}>{t('cad')}</button>}
      <button type="button" className="secondary" onClick={testGateway}>{t('probe.button')}</button>
    </div>
    {probe && <p aria-live="polite" className="probe">{probe}</p>}
  </article>;
}
