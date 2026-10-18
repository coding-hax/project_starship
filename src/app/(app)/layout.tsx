import { JournalHabitBoot } from '@/features/journal/journal-habit-boot';
import { CategoryColorsBoot } from '@/features/settings/category-colors-boot';
import { AppHeader } from '@/ui/app-header';
import { BlockedNotice } from '@/ui/blocked-notice';
import { E2EBridge } from '@/ui/e2e-bridge';
import { ModuleRouteGuard } from '@/ui/module-route-guard';
import { Nav } from '@/ui/nav';
import { SyncBoot } from '@/ui/sync-boot';
import { SyncStatus } from '@/ui/sync-status';
import { ToastHost } from '@/ui/toast-host';
import { PageTransition } from './page-transition';

/**
 * Cookie presence is gated by middleware.ts before this ever renders — that keeps
 * the segment static, so no DB round trip is left here. The real check stays at
 * the data layer (requireUser()); an invalid cookie surfaces via the first sync
 * pull's 401 (src/local/sync.ts) rather than here.
 */
export default function AppLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="shell">
      <ModuleRouteGuard />
      <AppHeader />
      <Nav />
      <main className="shell__main">
        {/* Inside the scrolling content, not a `.shell` grid sibling (AK5, #1201) —
            `OfflineNotice`'s shape is a normal block, not `position: fixed` like
            `Toast`, so it needs the page's own flow to be visible at all. */}
        <BlockedNotice />
        <PageTransition>{children}</PageTransition>
      </main>
      <SyncBoot />
      <JournalHabitBoot />
      <CategoryColorsBoot />
      <SyncStatus />
      <ToastHost />
      {process.env.NEXT_PUBLIC_E2E === '1' && <E2EBridge />}
    </div>
  );
}
