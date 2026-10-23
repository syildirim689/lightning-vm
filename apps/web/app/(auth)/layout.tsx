import LocaleSwitcher from '../locale-switcher';

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return <main className="auth"><h2 className="brand">ϟ Lightning VM</h2><LocaleSwitcher/>{children}</main>;
}
