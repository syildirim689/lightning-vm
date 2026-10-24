// Accessibility preferences, per browser. Each one becomes a data-* attribute on <html> (style.css reacts to
// them); a small inline script in the root layout applies the saved ones before the first paint.
export type A11y = {
  text: '100' | '112' | '125' | '150';
  contrast: 'normal' | 'high';
  font: 'default' | 'legible';
  spacing: 'normal' | 'wide';
  motion: 'system' | 'reduce' | 'allow';
  transparency: 'normal' | 'reduce';
  links: 'normal' | 'underline';
  focus: 'normal' | 'strong';
  targets: 'normal' | 'large';
  cursor: 'normal' | 'large';
  guide: 'off' | 'on';
};
export const a11yDefaults: A11y = { text: '100', contrast: 'normal', font: 'default', spacing: 'normal', motion: 'system', transparency: 'normal',
  links: 'normal', focus: 'normal', targets: 'normal', cursor: 'normal', guide: 'off' };
export const a11yStorageKey = 'lvm-a11y';

// Inline in <head>: the same as applyA11y, from localStorage, before React loads (no flash of the default look).
export const a11yBootScript = `try{var s=JSON.parse(localStorage.getItem('${a11yStorageKey}')||'{}').state||{};var d=${JSON.stringify(a11yDefaults)};for(var k in d){if(s[k]&&s[k]!==d[k])document.documentElement.setAttribute('data-a11y-'+k,s[k]);}}catch(e){}`;
