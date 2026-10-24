"use client";
import { useState } from 'react';
import { Order, Projects } from './order';
import { ServerList, SshKeys } from './servers-ui';

export default function UserPanel() {
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [keys, setKeys] = useState<{ id: string; name: string }[]>([]);
  return <><ServerList/><Order projects={projects} keys={keys}/><SshKeys onChange={setKeys}/><Projects onChange={setProjects}/></>;
}
