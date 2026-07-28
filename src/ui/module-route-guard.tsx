'use client';

import { usePathname, useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { useModules } from '@/features/settings/use-modules';
import { MODULES } from '@/modules/registry';

function ownerOf(pathname: string) {
  return MODULES.find(
    (m) => !m.core && m.routes?.some((route) => pathname === route || pathname.startsWith(`${route}/`)),
  );
}

/**
 * Redirects a direct call to an off module's route to /uebersicht (issue #309).
 * Purely client-side by design (ADR-0012, K1): `src/app/sw.ts` has no `localStorage`
 * and stays untouched — the flash-free part of this is `data-modules-off` +
 * `[data-module]` in globals.css, set before hydration; this effect only has to
 * catch the direct-navigation case once React takes over.
 */
export function ModuleRouteGuard() {
  const pathname = usePathname();
  const router = useRouter();
  const { isActive } = useModules();

  const owner = ownerOf(pathname);
  const blocked = owner !== undefined && !isActive(owner.id);

  useEffect(() => {
    if (blocked) router.replace('/uebersicht');
  }, [blocked, router]);

  return null;
}
