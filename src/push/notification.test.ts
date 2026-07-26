import { describe, expect, it } from 'vitest';
import { buildNotification, parsePushPayload } from './notification';

describe('buildNotification', () => {
  it('maps title/body/url onto the Notification.showNotification shape', () => {
    expect(buildNotification({ title: 'Starship', body: 'Testnachricht', url: '/aufgaben' })).toEqual({
      title: 'Starship',
      options: { body: 'Testnachricht', data: { url: '/aufgaben' } },
    });
  });
});

describe('parsePushPayload', () => {
  it('accepts a well-formed payload', () => {
    expect(parsePushPayload({ title: 'a', body: 'b', url: '/' })).toEqual({
      title: 'a',
      body: 'b',
      url: '/',
    });
  });

  it.each([null, undefined, 'a string', 42, {}, { title: 'a' }, { title: 1, body: 'b', url: '/' }])(
    'rejects malformed data: %j',
    (data) => {
      expect(parsePushPayload(data)).toBeNull();
    },
  );
});
