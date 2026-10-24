"use client";
import { create } from 'zustand';
import { createJSONStorage, persist } from 'zustand/middleware';
import { z } from 'zod';

// The order being composed. Kept per browser tab, so leaving the page (to add an SSH key, say) does not lose it.
export type OrderDraft = { poolId: string; imageId: string; projectId: string; type: 'package' | 'custom'; packageId: string;
  vcpu: number; memoryMb: number; diskGb: number; name: string; sshKeyIds: string[] };

const initial: OrderDraft = { poolId: '', imageId: '', projectId: '', type: 'package', packageId: '', vcpu: 2, memoryMb: 4096, diskGb: 40, name: '', sshKeyIds: [] };

export const useOrder = create<OrderDraft & { set: (patch: Partial<OrderDraft>) => void; clear: () => void }>()(persist(
  (set) => ({ ...initial, set: (patch) => set(patch), clear: () => set(initial) }),
  { name: 'lvm-order', storage: createJSONStorage(() => sessionStorage), partialize: ({ set: _s, clear: _c, ...draft }) => draft },
));

// Same rule as the API (RFC 1123 label); the API stays the authority, this only answers early.
export const hostnameSchema = z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/);

export function orderBody(d: OrderDraft) {
  return { type: d.type, poolId: d.poolId, ...(d.imageId && { imageId: d.imageId }), ...(d.projectId && { projectId: d.projectId }),
    ...(d.type === 'package' ? { packageId: d.packageId } : { vcpu: d.vcpu, memoryMb: d.memoryMb, diskGb: d.diskGb }) };
}
