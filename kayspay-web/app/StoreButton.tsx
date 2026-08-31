'use client';

import { PLAY_STORE_URL, trackStoreClick } from './store';

/**
 * The Google Play call to action.
 *
 * `location` identifies which page/section the click came from, so the
 * analytics event can attribute installs to the content that earned them
 * rather than lumping every click together.
 */
export default function StoreButton({
  location,
  className = 'store-button',
}: {
  location: string;
  className?: string;
}) {
  return (
    <a
      className={className}
      href={PLAY_STORE_URL}
      target="_blank"
      // noopener/noreferrer is required on target="_blank": without it the
      // opened page gets scripting access back to this one.
      rel="noopener noreferrer"
      onClick={() => trackStoreClick(location)}
      aria-label="Download KaysPay on Google Play"
    >
      <small>GET IT ON</small>
      <strong>Google Play</strong>
    </a>
  );
}
