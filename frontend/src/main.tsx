import React from 'react';
import ReactDOM from 'react-dom/client';
import { App } from './App';
import { bootstrapHostedConnection } from './lib/hostedBootstrap';
import { bootstrapCurrentOriginServer } from './lib/servers';
import './styles/globals.css';
import './styles/utilities.css';

async function bootstrap(): Promise<void> {
  // Fragment connections are authoritative and must be applied (and scrubbed)
  // before considering whether this page is a daemon's own non-8787 UI.
  const endpointFragmentPresent = new URLSearchParams(
    window.location.hash.slice(1)
  ).has('endpoint');
  bootstrapHostedConnection();
  if (!endpointFragmentPresent) await bootstrapCurrentOriginServer();

  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}

void bootstrap();
