import { Suspense } from 'react';
import SupportQueue from './queue';

export default function Page() {
  return <Suspense><SupportQueue/></Suspense>;
}
