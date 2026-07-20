'use client';

import { useState } from 'react';
import { Fab } from '@/ui/fab';
import { HabitEditor } from './habit-editor';

const LABEL = 'Gewohnheit anlegen';

/** FAB + create sheet, same shape as QuickAddTask (docs/DESIGN_SYSTEM.md). */
export function AddHabitFab() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Fab label={LABEL} onClick={() => setOpen(true)} />
      <HabitEditor open={open} mode="create" habit={null} onClose={() => setOpen(false)} />
    </>
  );
}
