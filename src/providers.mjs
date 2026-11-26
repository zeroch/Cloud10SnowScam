import { join } from 'node:path';
import { createCache } from './cache.mjs';
import { createDashboardLoader } from './provider-core.mjs';
export * from './provider-core.mjs';

export const loadDashboard = createDashboardLoader(createCache(join(process.cwd(), '.cache')));
