// Zustand store — assembled from per-feature slice factories.
//
// Each slice file exports a `createXSlice(set, get)` function that
// returns the slice's state defaults + action methods. Slices freely
// reference each other via `get().refreshFoo()` because they all end
// up on the same store. Module-level constants / helpers / IPC
// disposers live in their respective slice files; nothing of value
// remains in this file beyond composition.

import { create } from 'zustand';

import { createAppSlice } from './app.js';
import { createNavigationSlice } from './navigation.js';
import { createToastsSlice } from './toasts.js';
import { createCompaniesSlice } from './companies.js';
import { createProductsSlice } from './products.js';
import { createBrandsSlice } from './brands.js';
import { createCategoriesSlice } from './categories.js';
import { createDashboardSlice } from './dashboard.js';
import { createExportsSlice } from './exports.js';
import { createWorkspaceSlice } from './workspace.js';
import { createAiSlice } from './ai.js';
import { createRemoteChangesSlice } from './remoteChanges.js';
import { createBootstrapSlice } from './bootstrap.js';

export const useAppStore = create((set, get) => ({
  ...createAppSlice(set, get),
  ...createNavigationSlice(set, get),
  ...createToastsSlice(set, get),
  ...createCompaniesSlice(set, get),
  ...createProductsSlice(set, get),
  ...createBrandsSlice(set, get),
  ...createCategoriesSlice(set, get),
  ...createDashboardSlice(set, get),
  ...createExportsSlice(set, get),
  ...createWorkspaceSlice(set, get),
  ...createAiSlice(set, get),
  ...createRemoteChangesSlice(set, get),
  ...createBootstrapSlice(set, get),
}));
