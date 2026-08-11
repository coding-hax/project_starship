'use client';

import { useId, useState, type FormEvent } from 'react';
import { uuidv7 } from 'uuidv7';
import { useIcsSubscriptionList, refreshStaleSubscriptions } from '@/features/events/use-ics-subscriptions';
import { db } from '@/local/dexie';
import { Row } from '@/ui/row';
import { SectionCard } from '@/ui/section-card';
import './ics-subscriptions-panel.css';

/**
 * `.ics`-Abos verwalten (issue #560, ADR-0022): URL hinzufügen/entfernen,
 * beides direkt gegen `db.icsSubscriptions` — kein eigener Sync-Pfad, diese
 * Tabelle ist nie in der Outbox. Ein neues Abo wird sofort angestoßen
 * (`refreshStaleSubscriptions`), statt darauf zu warten, dass `/kalender`
 * als nächstes geöffnet wird.
 */
export function IcsSubscriptionsPanel() {
  const subscriptions = useIcsSubscriptionList();
  const [url, setUrl] = useState('');
  const [name, setName] = useState('');
  const urlInputId = useId();
  const nameInputId = useId();

  async function handleAdd(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedUrl = url.trim();
    if (!trimmedUrl) return;

    await db.icsSubscriptions.put({
      id: uuidv7(),
      url: trimmedUrl,
      name: name.trim() || trimmedUrl,
      fetchedAt: null,
      lastError: null,
      events: [],
    });
    setUrl('');
    setName('');
    refreshStaleSubscriptions().catch((error) => console.error('[ics] refresh failed', error));
  }

  async function handleRemove(id: string) {
    await db.icsSubscriptions.delete(id);
  }

  return (
    <SectionCard title="ICS-Abos">
      {subscriptions.length > 0 && (
        <ul className="ics-subscriptions-panel__list">
          {subscriptions.map((subscription) => (
            <li key={subscription.id} className="ics-subscriptions-panel__item">
              <Row label={subscription.name} description={subscription.url}>
                <button
                  type="button"
                  className="ics-subscriptions-panel__remove"
                  onClick={() => handleRemove(subscription.id)}
                  aria-label={`Abo „${subscription.name}“ entfernen`}
                >
                  Entfernen
                </button>
              </Row>
              {subscription.lastError && (
                <p className="ics-subscriptions-panel__error">{subscription.lastError}</p>
              )}
            </li>
          ))}
        </ul>
      )}

      <form className="ics-subscriptions-panel__form" onSubmit={handleAdd}>
        <label htmlFor={urlInputId} className="ics-subscriptions-panel__label">
          Kalender-URL
        </label>
        <input
          id={urlInputId}
          type="url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://…/feiertage.ics"
          className="ics-subscriptions-panel__input"
          required
        />
        <label htmlFor={nameInputId} className="ics-subscriptions-panel__label">
          Name (optional)
        </label>
        <input
          id={nameInputId}
          type="text"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="z. B. Feiertage"
          className="ics-subscriptions-panel__input"
        />
        <button type="submit" className="ics-subscriptions-panel__submit">
          Abo hinzufügen
        </button>
      </form>
    </SectionCard>
  );
}
