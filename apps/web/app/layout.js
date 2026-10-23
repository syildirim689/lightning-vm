import './style.css';
import Link from 'next/link';
export const metadata = { title: 'Lightning VM', description: 'VMware yönetim platformu başlangıç sürümü' };
export default function Layout({children}) {
 return <html lang="tr"><body><aside><h2>ϟ Lightning VM</h2><small>ALTYAPI YÖNETİMİ</small><nav><Link href="/">Kullanıcı paneli</Link><Link href="/admin">Yönetim paneli</Link></nav><p className="muted">v0.1.0 · Geliştirme iskeleti</p></aside><main><div className="notice">Başlangıç sürümü · Kimlik doğrulama ve VMware bağlantısı henüz uygulanmadı.</div>{children}</main></body></html>;
}
