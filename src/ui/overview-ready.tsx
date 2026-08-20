'use client';

import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useReducer,
  type ReactNode,
} from 'react';
import './overview-ready.css';

/**
 * One reveal point for a screen assembled from several independent live queries
 * (issue #642).
 *
 * Every block on /uebersicht returns `null` while its own `liveQuery` is in
 * flight — on its own the documented anti-shift move (no half-built block, no
 * spinner for local data, Smooth-Regel 2). Six of them on one screen inverts it:
 * six subscriptions answer in arbitrary order, each block unfolds on its own tick
 * and pushes everything below it down. That is exactly the layout shift
 * Smooth-Regel 3 forbids (`docs/design/form-und-motion.md`), moved from
 * "Tab-Wechsel" to "erste Sekunde nach dem Öffnen".
 *
 * The fix is not a skeleton per block. Ring, Streak-Karte and Monatsstreifen
 * deliberately render *nothing* once loaded when there is nothing to show (ruhiger
 * Leerzustand statt „0 von 0") — reserving height for them means giving it back,
 * which shifts just as hard in the other direction (`activity-month-strip.tsx`
 * does exactly that today: skeleton, then `return null` at zero activities).
 *
 * So instead: hold the content until every registered block has answered once,
 * then show all of it in a single paint. Content that appears together *below*
 * the already-standing Titelzeile moves nothing that was visible — appending
 * downwards is shift-free by definition, which is why this needs no guessed
 * height anywhere, and why "block present or absent?" is settled before content
 * is ever painted. The wait is not a network round trip but an IndexedDB read:
 * every query starts in the same effect flush and they land milliseconds apart.
 * Nothing is delayed artificially, only the latest tick — which comes anyway — is
 * awaited.
 *
 * Deliberately NOT covered: `WeatherForecast` hangs off a real network fetch and
 * keeps its own skeleton. It must never be allowed to hold the page back, and its
 * skeleton is shape-identical to the loaded state, so it shifts nothing.
 */

export interface RevealState {
  /** Registered blocks by id → "has answered once". */
  readonly pending: ReadonlyMap<string, boolean>;
  readonly revealed: boolean;
}

export type RevealAction =
  | { kind: 'register'; id: string; ready: boolean }
  | { kind: 'unregister'; id: string }
  | { kind: 'settle' }
  | { kind: 'force' };

export const INITIAL_REVEAL_STATE: RevealState = { pending: new Map(), revealed: false };

/**
 * Notausgang, damit ein Block, der nie antwortet, nicht die Startseite leert.
 *
 * `use-live-table.ts` schluckt einen Fehler der Live-Query mit `console.error` und
 * lässt die Zeilen für immer auf `undefined` — vor diesem Ticket fehlte dann ein
 * Block, jetzt bliebe die ganze Fläche verborgen, inklusive des Wetters, das gar
 * nicht an Dexie hängt. Nach dieser Frist wird gezeigt, was da ist: dann poppt
 * wieder, was nachkommt, aber die Übersicht ist nie dauerhaft leer. Großzügig
 * bemessen — ein IndexedDB-Lesen liegt im Millisekundenbereich, im Normalbetrieb
 * feuert das hier nie.
 */
export const REVEAL_FALLBACK_MS = 2000;

/**
 * The latch, as a pure reducer so it is testable without a DOM (same split as
 * `use-list-presence.ts`: pure step function here, React wiring below).
 *
 * `settle` — not `register` — is what flips `revealed`, and that split is the
 * whole point: an empty registry is vacuously "all ready", so evaluating on
 * registration would reveal on the very first commit, before any block has had
 * its mount effect. `settle` is dispatched from the provider's own effect, which
 * React runs *after* every child's, so the first evaluation already sees the
 * complete registry — while a screen with no blocks at all (alle Module aus)
 * still settles immediately instead of hanging hidden forever.
 *
 * Revealed is a one-way latch: a block mounted later (module toggled back on)
 * must never pull the page back into hiding.
 */
export function nextRevealState(state: RevealState, action: RevealAction): RevealState {
  if (state.revealed) return state;

  switch (action.kind) {
    case 'register': {
      if (state.pending.get(action.id) === action.ready) return state;
      const pending = new Map(state.pending);
      pending.set(action.id, action.ready);
      return { pending, revealed: false };
    }
    case 'unregister': {
      if (!state.pending.has(action.id)) return state;
      const pending = new Map(state.pending);
      pending.delete(action.id);
      return { pending, revealed: false };
    }
    case 'settle': {
      for (const ready of state.pending.values()) {
        if (!ready) return state;
      }
      return { pending: state.pending, revealed: true };
    }
    case 'force':
      return { pending: state.pending, revealed: true };
  }
}

interface OverviewReadyApi {
  register: (id: string, ready: boolean) => void;
  unregister: (id: string) => void;
}

const OverviewReadyContext = createContext<OverviewReadyApi | null>(null);

export function OverviewReadyProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(nextRevealState, INITIAL_REVEAL_STATE);

  const api = useMemo<OverviewReadyApi>(
    () => ({
      register: (id, ready) => dispatch({ kind: 'register', id, ready }),
      unregister: (id) => dispatch({ kind: 'unregister', id }),
    }),
    [],
  );

  // Terminates without a loop: once revealed, `settle` returns the identical state
  // object, React bails out of the re-render and this effect never re-runs.
  useEffect(() => {
    dispatch({ kind: 'settle' });
  }, [state]);

  useEffect(() => {
    if (state.revealed) return;
    const timer = setTimeout(() => dispatch({ kind: 'force' }), REVEAL_FALLBACK_MS);
    return () => clearTimeout(timer);
  }, [state.revealed]);

  return (
    <OverviewReadyContext.Provider value={api}>
      {/* Never the segment's FIRST element — the Titelzeile is, and it has to stay
          that way: the App Router steals focus to the first element of a changed
          segment (issue #233, see page-transition.tsx). */}
      <div
        className={state.revealed ? 'overview-ready' : 'overview-ready overview-ready--pending'}
        aria-busy={state.revealed ? undefined : true}
      >
        {children}
      </div>
    </OverviewReadyContext.Provider>
  );
}

/**
 * Registers the calling block with the surrounding `OverviewReadyProvider` and
 * reports whether its own live queries have answered.
 *
 * Blocks keep their own `return null` — they still decide for themselves whether
 * they render anything at all, so the module registry (ADR-0012) stays untouched:
 * the page never needs to know which data a module reads.
 *
 * Outside a provider this is inert, which is what lets the same components go on
 * being used on their own screens (`TaskList` on /aufgaben) unchanged.
 */
export function useBlockReady(ready: boolean): void {
  const api = useContext(OverviewReadyContext);
  const id = useId();

  useEffect(() => {
    api?.register(id, ready);
  }, [api, id, ready]);

  // Separate effect: unregistering belongs to unmount only, not to every change
  // of `ready` (which would deregister and re-register on each answer).
  useEffect(() => {
    if (!api) return;
    return () => api.unregister(id);
  }, [api, id]);
}
