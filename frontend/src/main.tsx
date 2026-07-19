import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import {
  bootstrapHostedConnection,
  bootstrapPairingConnection
} from './lib/hostedBootstrap';
import { bootstrapCurrentOriginServer } from './lib/servers';
import './styles/globals.css';
import './styles/utilities.css';

async function bootstrap(): Promise<void> {
  // Pairing is same-origin and authoritative. Claim (and scrub) it before a
  // hosted endpoint fragment or the current-origin health probe can run.
  const pairFragmentPresent = await bootstrapPairingConnection();
  // Fragment connections are authoritative and must be applied (and scrubbed)
  // before considering whether this page is a daemon's own non-8787 UI.
  const endpointFragmentPresent = new URLSearchParams(
    window.location.hash.slice(1)
  ).has('endpoint');
  if (!pairFragmentPresent) bootstrapHostedConnection();
  if (!pairFragmentPresent && !endpointFragmentPresent) {
    await bootstrapCurrentOriginServer();
  }

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void bootstrap();
