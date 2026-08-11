import { msg } from '../shared/i18n';
import { AlertTriangle, ArrowLeft, RotateCcw } from 'lucide-react';
import { isRouteErrorResponse, Link, useRouteError } from 'react-router-dom';

import { Button } from '../shared/ui';

export function RouteError() {
  const error = useRouteError();
  const title = isRouteErrorResponse(error) && error.status === 404 ? msg("m1304") : msg("m1305");
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : msg("m0323");

  return (
    <main className="route-error">
      <div className="route-error__icon"><AlertTriangle size={28} /></div>
      <span className="eyebrow">Vibe CS</span>
      <h1>{title}</h1>
      <p>{detail}</p>
      <div className="button-row">
        <Button variant="primary" onClick={() => window.location.reload()}>
          <RotateCcw size={15} />{msg("m1264")}
        </Button>
        <Link className="button button--secondary button--md" to="/">
          <ArrowLeft size={15} />{msg("m1197")}
        </Link>
      </div>
    </main>
  );
}

export function NotFound() {
  return (
    <main className="route-error">
      <div className="route-error__icon"><AlertTriangle size={28} /></div>
      <span className="eyebrow">Vibe CS</span>
      <h1>{msg("m1304")}</h1>
      <p>{msg("m1200")}</p>
      <Link className="button button--primary button--md" to="/">
        <ArrowLeft size={15} />{msg("m1197")}
      </Link>
    </main>
  );
}
