/**
 * The curated emoji grid (issue #1101) — a routine's sole identity marker, single
 * source shared by the habit editor (`src/features/habits/habit-editor.tsx`). No
 * emoji dependency (owner decision): plain characters, offline, font-safe, and
 * enumerable in e2e. Order and headings are binding — the editor renders this
 * as-is, grouped under each `heading`.
 */
export interface EmojiPaletteGroup {
  heading: string;
  emojis: { emoji: string; label: string }[];
}

export const EMOJI_PALETTE: EmojiPaletteGroup[] = [
  {
    heading: 'Sport & Bewegung',
    emojis: [
      { emoji: '🏃', label: 'Laufen' },
      { emoji: '🚴', label: 'Radfahren' },
      { emoji: '🏊', label: 'Schwimmen' },
      { emoji: '🧘', label: 'Yoga' },
      { emoji: '🏋️', label: 'Krafttraining' },
      { emoji: '⚽', label: 'Fußball' },
      { emoji: '🏀', label: 'Basketball' },
      { emoji: '🎾', label: 'Tennis' },
      { emoji: '🥊', label: 'Boxen' },
      { emoji: '🧗', label: 'Klettern' },
      { emoji: '🤸', label: 'Turnen' },
      { emoji: '🏓', label: 'Tischtennis' },
      { emoji: '🥋', label: 'Kampfsport' },
      { emoji: '⛸️', label: 'Schlittschuhlaufen' },
    ],
  },
  {
    heading: 'Gesundheit & Körper',
    emojis: [
      { emoji: '💊', label: 'Medikament' },
      { emoji: '🩺', label: 'Arzttermin' },
      { emoji: '🦷', label: 'Zähne putzen' },
      { emoji: '🧴', label: 'Hautpflege' },
      { emoji: '💉', label: 'Impfung' },
      { emoji: '🛌', label: 'Schlafen' },
      { emoji: '🧠', label: 'Meditation' },
      { emoji: '🩹', label: 'Pflaster' },
      { emoji: '🌡️', label: 'Fieber messen' },
      { emoji: '🧖', label: 'Sauna' },
      { emoji: '👁️', label: 'Augen' },
      { emoji: '🦶', label: 'Füße' },
      { emoji: '🫁', label: 'Atmung' },
    ],
  },
  {
    heading: 'Essen & Trinken',
    emojis: [
      { emoji: '🥗', label: 'Salat' },
      { emoji: '🍎', label: 'Apfel' },
      { emoji: '🥦', label: 'Gemüse' },
      { emoji: '🍳', label: 'Frühstück' },
      { emoji: '🍽️', label: 'Mahlzeit' },
      { emoji: '💧', label: 'Wasser trinken' },
      { emoji: '☕', label: 'Kaffee' },
      { emoji: '🍵', label: 'Tee' },
      { emoji: '🍇', label: 'Obst' },
      { emoji: '🥤', label: 'Getränk' },
      { emoji: '🍞', label: 'Brot' },
      { emoji: '🥕', label: 'Karotte' },
      { emoji: '🍲', label: 'Kochen' },
    ],
  },
  {
    heading: 'Haushalt',
    emojis: [
      { emoji: '🧹', label: 'Kehren' },
      { emoji: '🧺', label: 'Wäsche' },
      { emoji: '🧼', label: 'Putzen' },
      { emoji: '🗑️', label: 'Müll' },
      { emoji: '🛏️', label: 'Bett machen' },
      { emoji: '🧽', label: 'Abwasch' },
      { emoji: '🪴', label: 'Pflanzen gießen' },
      { emoji: '🧻', label: 'Bad putzen' },
      { emoji: '🛒', label: 'Einkaufen' },
      { emoji: '🐾', label: 'Haustier' },
      { emoji: '🔧', label: 'Reparieren' },
      { emoji: '🪑', label: 'Aufräumen' },
    ],
  },
  {
    heading: 'Lernen & Arbeit',
    emojis: [
      { emoji: '📚', label: 'Lesen' },
      { emoji: '✍️', label: 'Schreiben' },
      { emoji: '💻', label: 'Programmieren' },
      { emoji: '📝', label: 'Notizen' },
      { emoji: '🎓', label: 'Lernen' },
      { emoji: '🗣️', label: 'Sprache üben' },
      { emoji: '📖', label: 'Buch' },
      { emoji: '🧮', label: 'Rechnen' },
      { emoji: '📅', label: 'Planen' },
      { emoji: '💼', label: 'Arbeit' },
      { emoji: '🔬', label: 'Forschen' },
      { emoji: '📊', label: 'Auswerten' },
    ],
  },
  {
    heading: 'Kreativ & Freizeit',
    emojis: [
      { emoji: '🎨', label: 'Malen' },
      { emoji: '🎸', label: 'Gitarre' },
      { emoji: '🎹', label: 'Klavier' },
      { emoji: '📷', label: 'Fotografieren' },
      { emoji: '🧵', label: 'Nähen' },
      { emoji: '🎮', label: 'Spielen' },
      { emoji: '🎬', label: 'Film' },
      { emoji: '🎧', label: 'Musik hören' },
      { emoji: '✂️', label: 'Basteln' },
      { emoji: '🎭', label: 'Theater' },
      { emoji: '🖌️', label: 'Zeichnen' },
      { emoji: '🎲', label: 'Brettspiel' },
    ],
  },
  {
    heading: 'Natur',
    emojis: [
      { emoji: '🌳', label: 'Baum' },
      { emoji: '🌱', label: 'Pflanze' },
      { emoji: '🌞', label: 'Sonne' },
      { emoji: '🌧️', label: 'Regen' },
      { emoji: '🏞️', label: 'Spaziergang' },
      { emoji: '🚶', label: 'Wandern' },
      { emoji: '🌻', label: 'Blume' },
      { emoji: '🦋', label: 'Schmetterling' },
      { emoji: '🏔️', label: 'Berg' },
      { emoji: '🌊', label: 'Wasser' },
      { emoji: '🐦', label: 'Vogel' },
      { emoji: '🌌', label: 'Sternenhimmel' },
    ],
  },
  {
    heading: 'Symbole',
    emojis: [
      { emoji: '✅', label: 'Erledigt' },
      { emoji: '⭐', label: 'Stern' },
      { emoji: '❤️', label: 'Herz' },
      { emoji: '🔥', label: 'Feuer' },
      { emoji: '💯', label: 'Hundert' },
      { emoji: '🏆', label: 'Pokal' },
      { emoji: '🎯', label: 'Ziel' },
      { emoji: '⏰', label: 'Wecker' },
      { emoji: '🔔', label: 'Glocke' },
      { emoji: '💡', label: 'Idee' },
      { emoji: '🧭', label: 'Kompass' },
      { emoji: '🌈', label: 'Regenbogen' },
    ],
  },
];
