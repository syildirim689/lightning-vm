import account from './account';
import admin from './admin';
import api from './api';
import billing from './billing';
import catalog from './catalog';
import servers from './servers';
import type { Docs } from './types';

// Every documented route, from the files of this folder (one per area). A key in two files is a mistake;
// test/api-reference.test.mjs finds it through the totals.
export const docs: Docs = { ...servers, ...catalog, ...billing, ...admin, ...account, ...api };
export const docCount = [servers, catalog, billing, admin, account, api].reduce((n, d) => n + Object.keys(d).length, 0);
