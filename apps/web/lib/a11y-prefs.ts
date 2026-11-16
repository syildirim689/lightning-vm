// Accessibility preferences, per browser. Each one becomes a data-* attribute on <html> (style.css reacts to
// them); a small inline script in the root layout applies the saved ones before the first paint. Text size and
// spacing are free values on a scale (a slider); the rest are choices.
export type A11y = {
  text: string; // per cent of the normal size, 75-200
  contrast: 'normal' | 'high';
  font: 'default' | 'legible';
  spacing: string; // 0 (normal) to 100 (widest)
  motion: 'system' | 'reduce' | 'allow';
  transparency: 'normal' | 'reduce';
  links: 'normal' | 'underline';
  focus: 'normal' | 'strong';
  targets: 'normal' | 'large';
  cursor: 'normal' | 'large';
  guide: 'off' | 'on';
};
export const a11yDefaults: A11y = { text: '100', contrast: 'normal', font: 'default', spacing: '0', motion: 'system', transparency: 'normal',
  links: 'normal', focus: 'normal', targets: 'normal', cursor: 'normal', guide: 'off' };
export const a11yStorageKey = 'lvm-a11y';
export const a11yScales = { text: { min: 75, max: 200, step: 5, normal: 100 }, spacing: { min: 0, max: 100, step: 5, normal: 0 } } as const;
// A stored value on its scale (earlier versions stored 'normal' and 'wide' for spacing).
export function a11yNumber(key: 'text' | 'spacing', v: unknown) {
  const s = a11yScales[key];
  const n = v === 'wide' ? 50 : v === 'normal' ? 0 : Number(v);
  return Number.isFinite(n) ? Math.min(s.max, Math.max(s.min, Math.round(n))) : s.normal;
}

// Inline in <head>: the same as applyA11y, from localStorage, before React loads (no flash of the default look).
export const a11yBootScript = `try{var s=JSON.parse(localStorage.getItem('${a11yStorageKey}')||'{}').state||{};var d=${JSON.stringify(a11yDefaults)};var e=document.documentElement;for(var k in d){if(k==='text'||k==='spacing')continue;if(s[k]&&s[k]!==d[k])e.setAttribute('data-a11y-'+k,s[k]);}var t=Number(s.text);if(t>=75&&t<=200&&t!==100)e.style.fontSize=t+'%';var p=s.spacing==='wide'?50:Number(s.spacing);if(p>0&&p<=100){e.setAttribute('data-a11y-spacing','on');e.style.setProperty('--a11y-spacing',String(p));}}catch(e){}`;
