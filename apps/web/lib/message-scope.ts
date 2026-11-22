// Which translations each part of the app sends to the browser. Every page used to carry all of them (~380 KB of
// HTML on the sign-in page); now the public pages carry only what their components use, the setup wizard adds its
// own, and the signed-in panel gets everything. lib/message-scope.test.ts walks the imports of the public pages and
// fails when one of them starts using a namespace that is not listed here.
export const publicScope = ['A11y', 'Auth', 'AuthLayout', 'Formats', 'Proposals', 'Layout', 'Metadata', 'Nav', 'PublicStatus', 'Table', 'Windows', 'ErrorPage', 'errors', 'fieldErrors', 'Clipboard'] as const;
export const setupScope = [...publicScope, 'Setup', 'Guides', 'Vmware', 'Capabilities'] as const;

export function pick(messages: Record<string, unknown>, names: readonly string[]) {
  return Object.fromEntries(names.filter((n) => n in messages).map((n) => [n, messages[n]]));
}
