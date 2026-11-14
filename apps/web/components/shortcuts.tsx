"use client";
// Keyboard shortcuts: "?" shows the list, "/" jumps to the page's search, "g" then a letter goes to a page (like GitHub and Gmail).
// Ignored while typing in a field, and with Ctrl/Alt/⌘ held, so they never steal text input.
import { Kbd, Modal } from '@heroui/react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useEffect, useState } from 'react';
import { can } from '../lib/permissions';
import { firstEdited, formsDirty, mayLeave } from '../lib/edits';

// The palette's "Keyboard shortcuts" action opens the dialog through this event.
export const openShortcuts = () => window.dispatchEvent(new Event('lvm:shortcuts'));

const typing = (e: KeyboardEvent) => {
  const el = e.target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName) || !!el.closest('[role="dialog"]'));
};

export default function Shortcuts({ permissions }: { permissions: string[] }) {
  const t = useTranslations('Shortcuts');
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const routes: [string, string, boolean][] = [
    ['h', '/', true], ['o', '/order', can(permissions, 'servers.create')], ['a', '/account', true], ['t', '/topology', true],
    ['d', '/admin', can(permissions, 'dashboard.view')], ['s', '/admin/servers', can(permissions, 'servers.view_all')], ['c', '/admin/catalog', can(permissions, 'catalog.view', 'catalog.manage')],
    ['i', '/admin/stats', can(permissions, 'dashboard.view')], ['q', '/admin/support', can(permissions, 'support.view')], ['u', '/support', true], ['b', '/billing', true], ['f', '/firewalls', true], ['y', '/admin/system', can(permissions, 'system.view')],
  ];
  const allowed = routes.filter((r) => r[2]);

  useEffect(() => {
    let leader = 0;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey || typing(e)) return;
      if (e.key === '?') { e.preventDefault(); setOpen(true); return; }
      const search = e.key === '/' && document.querySelector<HTMLInputElement>('main input[type="search"]');
      if (search) { e.preventDefault(); search.focus(); search.select(); return; }
      if (e.key === 'g') { leader = Date.now(); return; }
      const r = Date.now() - leader < 1200 && allowed.find(([k]) => k === e.key.toLowerCase());
      leader = 0;
      if (r) { e.preventDefault(); if (mayLeave(r[1])) router.push(r[1]); }
    };
    // Ctrl/⌘+Enter in a long text sends its form, as in mail and chat. Last in line (window, bubbling): a page that
    // handles the keys itself (support replies) has already done so and prevented the default.
    const onSend = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey) || e.defaultPrevented || !(e.target instanceof HTMLTextAreaElement)) return;
      const submit = e.target.form?.querySelector<HTMLButtonElement>('button[type="submit"]:not(:disabled)');
      if (!submit || submit.getAttribute('aria-disabled') === 'true') return;
      e.preventDefault();
      e.target.form!.requestSubmit(submit);
    };
    // Ctrl/⌘+S saves the form with unsaved text (the focused field's, else the first changed one's) instead of the
    // browser's "Save page". Forms that track their own changes (useUnsaved) do this themselves.
    const onSave = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey || e.key.toLowerCase() !== 's' || e.defaultPrevented || formsDirty()) return;
      const active = document.activeElement;
      const field = active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement ? active : firstEdited();
      const submit = field?.form?.querySelector<HTMLButtonElement>('button[type="submit"]:not(:disabled)');
      if (!submit || submit.getAttribute('aria-disabled') === 'true') return;
      e.preventDefault();
      field!.form!.requestSubmit(submit);
    };
    const onOpen = () => setOpen(true);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keydown', onSend);
    window.addEventListener('keydown', onSave);
    window.addEventListener('lvm:shortcuts', onOpen);
    return () => { window.removeEventListener('keydown', onKey); window.removeEventListener('keydown', onSend); window.removeEventListener('keydown', onSave); window.removeEventListener('lvm:shortcuts', onOpen); };
  }, [allowed.map((r) => r[0]).join()]); // eslint-disable-line react-hooks/exhaustive-deps

  const row = (keys: React.ReactNode, label: string) => <li className="flex min-h-10 items-center justify-between gap-4 border-b border-separator py-2 text-sm last:border-0">
    <span>{label}</span><span className="flex shrink-0 items-center gap-1 text-xs text-muted">{keys}</span>
  </li>;
  return <Modal.Backdrop isOpen={open} onOpenChange={setOpen}>
    <Modal.Container>
      <Modal.Dialog className="w-[30rem] max-w-[calc(100vw-1.5rem)]">
        <Modal.CloseTrigger/>
        <Modal.Header><Modal.Heading>{t('title')}</Modal.Heading></Modal.Header>
        <Modal.Body className="flex flex-col gap-4">
          <p className="text-sm text-muted">{t('intro')}</p>
          <ul>
            {row(<><Kbd>Ctrl</Kbd><Kbd>K</Kbd></>, t('palette'))}
            {row(<Kbd>?</Kbd>, t('help'))}
            {row(<Kbd>/</Kbd>, t('search'))}
            {row(<><Kbd>Ctrl</Kbd><Kbd>Enter</Kbd></>, t('send'))}
            {row(<><Kbd>Ctrl</Kbd><Kbd>S</Kbd></>, t('save'))}
          </ul>
          <div>
            <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-muted">{t('goTo')}</h3>
            <ul>{allowed.map(([k]) => <li key={k} className="contents">{row(<><Kbd>G</Kbd>{t('then')}<Kbd>{k.toUpperCase()}</Kbd></>, t(`g.${k as 'h'}`))}</li>)}</ul>
          </div>
        </Modal.Body>
      </Modal.Dialog>
    </Modal.Container>
  </Modal.Backdrop>;
}
