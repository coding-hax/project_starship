'use client';

import { JournalMoodBand } from './journal-mood-band';
import { useJournalSearchMode } from './journal-view-mode';
import { useJournalLock } from './lock-store';

/**
 * Kopf-Wrapper um `JournalMoodBand` (issue #868): hebt das Band aus dem
 * Editor in den PageHead-Zusatz-Slot, reproduziert dabei aber exakt dieselben
 * zwei Gates, unter denen der Editor es zuvor zeigte — `unlocked` (der Editor
 * selbst rendert nur dort) und `!searchActive` (journal-editor.tsx's
 * `!searchActive`-Zweig). `JournalMoodBand` bleibt unverändert: sie liest
 * `useJournalSearchEntries` eigenständig, hängt also nicht am Editor.
 */
export function JournalHeadMood() {
  const { state } = useJournalLock();
  const { active: searchActive } = useJournalSearchMode();

  if (state !== 'unlocked' || searchActive) return null;

  return <JournalMoodBand />;
}
