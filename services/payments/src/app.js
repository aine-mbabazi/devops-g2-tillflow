import { createServer } from 'node:http';

export function createApp({ darajaClient, log = () => {} }) {
  // Composition boundary for the later Payments API handlers.
  if (!darajaClient) throw new Error('A Daraja client is required');

  return createServer((req, res) => {
    const path = req.url?.split('?')[0];
    const isHealth = path === '/health';
    const allowed = req.method === 'GET' || req.method === 'HEAD';
    const statusCode = isHealth ? (allowed ? 200 : 405) : 404;
    const body = statusCode === 200
      ? { service: 'payments', status: 'ok' }
      : { error: statusCode === 405 ? 'method_not_allowed' : 'not_found' };

    res.on('finish', () => log({
      event: 'http_request',
      route: isHealth ? '/health' : 'unmatched',
      statusCode,
    }));
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    if (statusCode === 405) res.setHeader('Allow', 'GET, HEAD');
    res.writeHead(statusCode);
    res.end(req.method === 'HEAD' ? undefined : JSON.stringify(body));
  });
}
