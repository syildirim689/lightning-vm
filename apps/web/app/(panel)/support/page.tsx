import { Suspense } from 'react';
import SupportList from './list';

export default function Page() {
  return <Suspense><SupportList/></Suspense>;
}
