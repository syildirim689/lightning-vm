"use client";
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { z } from 'zod';
import { forgetEvent } from './session-end';

// The order being composed. Kept per browser tab, so leaving the page (to add an SSH key, say) does not lose it.
export type OrderDraft = { poolId: string; imageId: string; projectId: string; type: 'package' | 'custom'; packageId: string;
  vcpu: number; memoryMb: number; diskGb: number; name: string; sshKeyIds: string[]; extraIpv4: number; applicationId: string;
  // A copy of one of the user's servers (its disk is cloned): its id and name.
  cloneFrom: string; cloneName: string;
  // Paid monthly (an invoice per period) or by the hour from the balance.
  billingCycle: 'monthly' | 'hourly';
  // Firewalls to put on the new server (their ids; older drafts have none).
  firewallIds?: string[] };

const initial: OrderDraft = { poolId: '', imageId: '', projectId: '', type: 'package', packageId: '', vcpu: 2, memoryMb: 4096, diskGb: 40, name: '', sshKeyIds: [], extraIpv4: 0, applicationId: '', cloneFrom: '', cloneName: '', billingCycle: 'monthly', firewallIds: [] };

export const useOrder = create<OrderDraft & { set: (patch: Partial<OrderDraft>) => void; clear: () => void }>()(persist(
  (set) => ({ ...initial, set: (patch) => set(patch), clear: () => set(initial) }),
  { name: 'lvm-order', storage: createJSONStorage(() => sessionStorage), partialize: ({ set: _s, clear: _c, ...draft }) => draft },
));

// The draft names the person's project, SSH keys and the server it copies. It goes with their session, also from
// this store's memory: a tab that stays open would otherwise write it back (lib/session-end.ts removes the key).
if (typeof window !== 'undefined') window.addEventListener(forgetEvent, () => { useOrder.getState().clear(); useOrder.persist.clearStorage(); });

// Same rule as the API (RFC 1123 label); the API stays the authority, this only answers early.
export const hostnameSchema = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/);

export function orderBody(d: OrderDraft) {
  return { type: d.type, poolId: d.poolId, ...(d.imageId && { imageId: d.imageId }), ...(d.projectId && { projectId: d.projectId }), ...(d.extraIpv4 > 0 && { extraIpv4: d.extraIpv4 }), ...(d.applicationId && { applicationId: d.applicationId }), ...(d.cloneFrom && { cloneFrom: d.cloneFrom }), ...(d.billingCycle === 'hourly' && { billingCycle: 'hourly' }),
    ...(d.type === 'package' ? { packageId: d.packageId } : { vcpu: d.vcpu, memoryMb: d.memoryMb, diskGb: d.diskGb }) };
}
