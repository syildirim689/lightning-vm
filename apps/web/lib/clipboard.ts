"use client";
import { toast } from '@heroui/react';
import { useTranslations } from 'next-intl';

// Puts text on the clipboard and says whether it really got there. navigator.clipboard exists only on HTTPS (and
// localhost): a panel opened over plain HTTP falls back to selecting the text in a hidden field and asking the
// browser to copy the selection. False means nothing was copied and the person has to do it by hand.
export async function copyText(text: string): Promise<boolean> {
  try { if (navigator.clipboard?.writeText) { await navigator.clipboard.writeText(text); return true; } } catch { /* blocked: try the old way */ }
  const before = document.activeElement as HTMLElement | null;
  const el = document.createElement('textarea');
  try {
    el.value = text; el.readOnly = true; el.setAttribute('aria-hidden', 'true');
    el.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;opacity:0';
    // Inside an open dialog the field goes into the dialog, or its focus trap takes the selection away.
    (before?.closest('[role="dialog"],[role="alertdialog"]') ?? document.body).appendChild(el);
    el.focus({ preventScroll: true }); el.select(); el.setSelectionRange(0, text.length);
    return document.execCommand('copy');
  } catch { return false; } finally { el.remove(); before?.focus?.({ preventScroll: true }); }
}

// For copy buttons, above all those holding something shown only once (a new API token, backup codes, a password):
// the success message appears only when the text was copied; otherwise an honest "copy it by hand".
export function useCopy() {
  const t = useTranslations('Clipboard');
  return async (text: string, copied?: string) => {
    const ok = await copyText(text);
    if (!ok) toast.warning(t('failed')); else if (copied) toast.success(copied);
    return ok;
  };
}
