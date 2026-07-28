export class WrongPassphraseError extends Error {
  constructor() {
    super('Falsche Passphrase oder beschaedigte Huelle.');
    this.name = 'WrongPassphraseError';
  }
}

export class JournalDecryptError extends Error {
  constructor() {
    super('Journal-Chiffrat konnte nicht entschluesselt werden.');
    this.name = 'JournalDecryptError';
  }
}
