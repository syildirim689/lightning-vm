"use client";
import { useState } from 'react';
import { Order, Projects } from './order';

export default function UserPanel() {
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  return <><Projects onChange={setProjects}/><Order projects={projects}/></>;
}
