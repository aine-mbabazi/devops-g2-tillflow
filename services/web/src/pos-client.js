// web never mints its own service-auth tokens for POS: the caller's signed
// x-service-auth header is verified once in app.js (so web can fail fast with
// a clean 401) and then forwarded to POS unchanged, which verifies it again
// independently. web has no opinion on tenancy or sale state of its own.
export class PosClient {
  constructor({ baseUrl, fetchImpl = fetch }) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.fetchImpl = fetchImpl;
  }

  async health() {
    const response = await this.fetchImpl(`${this.baseUrl}/health`);
    return response.ok;
  }

  async createSale({ authHeader, idempotencyKey, body }) {
    const response = await this.fetchImpl(`${this.baseUrl}/sales`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey, 'x-service-auth': authHeader },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  }

  async getSale({ authHeader, saleId }) {
    const response = await this.fetchImpl(`${this.baseUrl}/sales/${encodeURIComponent(saleId)}`, {
      headers: { 'x-service-auth': authHeader },
    });
    return { status: response.status, body: await response.json() };
  }

  async pay({ authHeader, saleId }) {
    const response = await this.fetchImpl(`${this.baseUrl}/sales/${encodeURIComponent(saleId)}/pay`, {
      method: 'POST',
      headers: { 'x-service-auth': authHeader },
    });
    return { status: response.status, body: await response.json() };
  }
}
