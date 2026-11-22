"use client";
import { useEffect, useState } from 'react';

// Keeps a field on the panel's proposal (lib/proposals.ts) until the person types in it. The proposal follows what it
// is made from (the scope chosen, the key pasted, the address typed) for as long as the field still holds the last
// proposal; once the person typed something else, even an empty field, it is theirs and never replaced. `again()`
// starts over after the form was sent and emptied. `undefined` means "nothing to propose yet" (data still loading).
// Works with any form state: it only reads the value and calls the setter.
export function useProposal(proposal: string | undefined, value: string, set: (v: string) => void) {
  // The proposal last put into the field; null: none yet (an empty field may then take one).
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (proposal === undefined) return;
    const untouched = shown === null ? value === '' : value === shown;
    if (!untouched) return;
    if (shown !== proposal) setShown(proposal);
    if (value !== proposal) set(proposal);
  }, [proposal, value, shown]); // eslint-disable-line react-hooks/exhaustive-deps
  return {
    // Whether the field shows the proposal as it was made (TextInput selects it on focus, so typing replaces it).
    proposed: shown !== null && value !== '' && value === shown,
    again: () => setShown(null),
  };
}
